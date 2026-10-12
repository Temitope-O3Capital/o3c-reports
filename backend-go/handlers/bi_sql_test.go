package handlers

import (
	"database/sql"
	"os"
	"strings"
	"testing"

	"github.com/o3c/workspace/core"
)

/*
TESTS FOR THE SQL CONSOLE.

The console is the one place in the workspace where a person hands arbitrary SQL to the
database, so these tests are the feature. They are written to match the ORDER the
controls actually protect anything, and the live ones matter most: a test that proves my
regex rejects "DELETE" proves almost nothing, because the regex is the fourth line of
defence. What is worth proving is that POSTGRES refuses the write even when the regex is
bypassed — so TestBISQLPostgresRefusesAWriteLive does exactly that, by sending a write
that biSQLValidate lets through.
*/

// ── Validation (the cheap, fourth line of defence) ───────────────────────────

func TestBISQLValidateRefusesWhatItShould(t *testing.T) {
	cases := []struct {
		name, sql string
		wantErr   bool
	}{
		{"a plain select", "SELECT 1", false},
		{"a CTE", "WITH x AS (SELECT 1 AS a) SELECT * FROM x", false},
		{"lower case", "select count(*) from app.customers", false},
		{"leading whitespace and newlines", "\n\n  SELECT 1\n", false},
		{"a trailing semicolon is fine", "SELECT 1;", false},
		{"a comment before the select", "SELECT 1 -- counting", false},

		{"empty", "", true},
		{"only whitespace", "   \n\t ", true},
		{"an insert", "INSERT INTO app.customers (cif) VALUES ('x')", true},
		{"an update", "UPDATE app.o3c_users SET role='admin'", true},
		{"a delete", "DELETE FROM app.customers", true},
		{"a truncate", "TRUNCATE app.customers", true},
		{"DDL", "DROP TABLE app.customers", true},
		{"a grant", "GRANT ALL ON app.customers TO public", true},
		{"two statements", "SELECT 1; DROP TABLE app.customers", true},
		{"two statements with trailing semicolon", "SELECT 1; SELECT 2;", true},
		{"reading a server file", "SELECT pg_read_file('/etc/passwd')", true},
		{"listing a server directory", "SELECT pg_ls_dir('.')", true},
		{"a foreign connection", "SELECT * FROM dblink('host=x', 'select 1') AS t(a int)", true},
		{"COPY", "COPY app.customers TO '/tmp/x.csv'", true},
		{"holding the connection", "SELECT pg_sleep(600)", true},
		{"terminating a backend", "SELECT pg_terminate_backend(1)", true},
		{"reading a connection secret", "SELECT current_setting('my.password_thing')", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := biSQLValidate(c.sql)
			if c.wantErr && err == nil {
				t.Errorf("biSQLValidate(%q) allowed it; expected a refusal", c.sql)
			}
			if !c.wantErr && err != nil {
				t.Errorf("biSQLValidate(%q) refused a legitimate read: %v", c.sql, err)
			}
		})
	}
}

func TestBISQLRefusalsExplainThemselves(t *testing.T) {
	// An analyst who gets "invalid query" learns nothing and asks someone. Every
	// refusal should name what it objected to.
	for _, q := range []string{
		"DELETE FROM app.customers",
		"SELECT 1; SELECT 2",
		"SELECT pg_read_file('/etc/passwd')",
	} {
		err := biSQLValidate(q)
		if err == nil {
			t.Fatalf("%q was allowed", q)
		}
		if len(err.Error()) < 25 {
			t.Errorf("the refusal for %q is too terse to act on: %q", q, err)
		}
	}
}

// ── The result screen (steps 3 and 4) ────────────────────────────────────────

func TestBISQLResultScreenRefusesCredentialColumns(t *testing.T) {
	// A column name on the deny-list, however it got into the result.
	err := biSQLCheckResult(
		[]string{"id", "full_name", "password_hash"},
		[]map[string]any{{"id": 1, "full_name": "A", "password_hash": "x"}})
	if err == nil {
		t.Fatal("a result containing password_hash was allowed through")
	}
	if !strings.Contains(err.Error(), "password_hash") {
		t.Errorf("the refusal does not name the offending column: %v", err)
	}
}

func TestBISQLResultScreenCatchesAnAliasedSecret(t *testing.T) {
	// SELECT password_hash AS harmless_looking_name. The column name check cannot see
	// this, which is exactly why the value scan exists.
	err := biSQLCheckResult(
		[]string{"id", "whatever"},
		[]map[string]any{{"id": 1, "whatever": "$2a$10$abcdefghijklmnopqrstuv"}})
	if err == nil {
		t.Fatal("an aliased bcrypt hash was allowed through")
	}
	if !strings.Contains(err.Error(), "bcrypt") {
		t.Errorf("the refusal does not say what it recognised: %v", err)
	}
}

func TestBISQLResultScreenAllowsOrdinaryData(t *testing.T) {
	// The screen must not be so eager that it blocks real analysis. Names, money,
	// references and prose all pass.
	err := biSQLCheckResult(
		[]string{"customer_name", "amount_kobo", "reference", "notes"},
		[]map[string]any{{
			"customer_name": "Banji Oyewole Ojo",
			"amount_kobo":   int64(109457869907),
			"reference":     "GTB/2026/0912/44817",
			"notes":         "Customer asked for a statement covering $2,000 of spend",
		}})
	if err != nil {
		t.Errorf("ordinary data was refused: %v", err)
	}
}

func TestBISQLDeniedColumnsAreRealColumnsLive(t *testing.T) {
	// A deny-list naming columns that do not exist is a deny-list nobody maintains, and
	// it hides the fact that a real secret column was missed. Every entry must exist.
	if os.Getenv("EXPORT_LIVE_TEST") != "1" {
		t.Skip("set EXPORT_LIVE_TEST=1")
	}
	env := readEnv(t, "../.env")
	pg, err := sql.Open("pgx", env["DATABASE_URL"])
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer pg.Close()
	db := &core.DB{PG: pg}

	rows, err := db.PGQuery(t.Context(), `
		SELECT DISTINCT lower(column_name) AS c
		  FROM information_schema.columns WHERE table_schema = 'app'`)
	if err != nil {
		t.Fatalf("read columns: %v", err)
	}
	live := map[string]bool{}
	for _, r := range rows {
		live[str(r["c"])] = true
	}
	for col := range biSQLDeniedColumns {
		if !live[col] {
			t.Errorf("the deny-list names %q, which no table in app has — remove it, or "+
				"correct the spelling (a misspelt entry protects nothing)", col)
		}
	}

	// And the converse: anything in app that LOOKS like a credential should be on the
	// list. This is the check that notices a new secret column arriving.
	rows, err = db.PGQuery(t.Context(), `
		SELECT DISTINCT lower(column_name) AS c
		  FROM information_schema.columns
		 WHERE table_schema = 'app'
		   AND column_name ~* '(password|secret|api_key|private_key|_encrypted$|_enc$|_hmac$)'
		   AND column_name NOT IN ('is_secret', 'password_hint')`)
	if err != nil {
		t.Fatalf("read candidates: %v", err)
	}
	for _, r := range rows {
		c := str(r["c"])
		if _, denied := biSQLDeniedColumns[c]; !denied {
			t.Errorf("app has a column %q that looks like a credential and is NOT on the "+
				"console deny-list. Add it, or if it is harmless say so here.", c)
		}
	}
}

// ── What Postgres enforces (steps 1 and 2 — the real controls) ───────────────

func biSQLTestDB(t *testing.T) (*core.DB, func()) {
	t.Helper()
	if os.Getenv("EXPORT_LIVE_TEST") != "1" {
		t.Skip("set EXPORT_LIVE_TEST=1")
	}
	env := readEnv(t, "../.env")
	pg, err := sql.Open("pgx", env["DATABASE_URL"])
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	return &core.DB{PG: pg}, func() { pg.Close() }
}

// TestBISQLPostgresRefusesAWriteLive is the test that matters.
//
// It deliberately BYPASSES biSQLValidate and calls the executor's transaction directly
// with a write, to prove that the protection does not depend on the regex. If someone
// later loosens the validator — or finds a phrasing it does not recognise — this is what
// still stands between a console and a dropped table.
func TestBISQLPostgresRefusesAWriteLive(t *testing.T) {
	db, done := biSQLTestDB(t)
	defer done()

	conn, _ := biSQLConn(db)
	tx, err := conn.BeginTx(t.Context(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback() //nolint:errcheck
	if _, err := tx.ExecContext(t.Context(), "SET LOCAL transaction_read_only = on"); err != nil {
		t.Fatalf("set read only: %v", err)
	}

	for _, write := range []string{
		"CREATE TEMP TABLE bi_console_probe (i int)",
		"INSERT INTO app.bi_sql_queries (name, sql_text) VALUES ('probe', 'SELECT 1')",
		"UPDATE app.o3c_users SET department = department",
		"DELETE FROM app.bi_sql_queries WHERE id = -1",
	} {
		if _, err := tx.ExecContext(t.Context(), write); err == nil {
			t.Errorf("POSTGRES ALLOWED A WRITE inside the read-only transaction: %q\n"+
				"The console's safety rests on this. Do not ship until it refuses.", write)
		} else if !strings.Contains(err.Error(), "read-only") {
			// Any refusal is acceptable, but it should be the read-only one — otherwise
			// the statement failed for an unrelated reason and proves nothing.
			t.Logf("%q refused with: %v", write, err)
		}
	}
}

func TestBISQLExecuteLive(t *testing.T) {
	db, done := biSQLTestDB(t)
	defer done()
	ctx := t.Context()

	t.Run("a real query returns ordered columns", func(t *testing.T) {
		res, err := biSQLExecute(ctx, db,
			`SELECT cif, full_name, state FROM app.customers WHERE state IS NOT NULL LIMIT 5`, 10)
		if err != nil {
			t.Fatalf("a legitimate query failed: %v", err)
		}
		want := []string{"cif", "full_name", "state"}
		if len(res.Columns) != len(want) {
			t.Fatalf("got columns %v, want %v", res.Columns, want)
		}
		for i := range want {
			if res.Columns[i] != want[i] {
				t.Errorf("column %d is %q, want %q — the SELECT order must survive",
					i, res.Columns[i], want[i])
			}
		}
		if res.RowCount == 0 {
			t.Error("no rows from a table holding 22,000")
		}
		if res.Connection == "" {
			t.Error("the result does not say which connection ran it")
		}
	})

	t.Run("the row cap truncates and says so", func(t *testing.T) {
		res, err := biSQLExecute(ctx, db, `SELECT cif FROM app.customers`, 5)
		if err != nil {
			t.Fatalf("query: %v", err)
		}
		if res.RowCount != 5 {
			t.Errorf("got %d rows, want exactly the 5 asked for", res.RowCount)
		}
		if !res.Truncated {
			t.Error("22,000 rows capped at 5 and Truncated is false — a silent cut is the " +
				"one thing a console must never do")
		}
	})

	t.Run("a write is refused with a usable message", func(t *testing.T) {
		_, err := biSQLExecute(ctx, db, `DELETE FROM app.bi_sql_queries`, 10)
		if err == nil {
			t.Fatal("a DELETE was accepted")
		}
		if !strings.Contains(strings.ToLower(err.Error()), "read-only") {
			t.Errorf("the refusal should say the console is read-only: %v", err)
		}
	})

	t.Run("SELECT star over a credential table is refused", func(t *testing.T) {
		// The case a SQL-text scan cannot catch: the column is never named.
		_, err := biSQLExecute(ctx, db, `SELECT * FROM app.o3c_users LIMIT 1`, 10)
		if err == nil {
			t.Fatal("SELECT * over o3c_users returned rows — password_hash is in there")
		}
		if !strings.Contains(err.Error(), "password_hash") {
			t.Errorf("the refusal should name the column that caused it: %v", err)
		}
	})

	t.Run("the same table is queryable without the secret", func(t *testing.T) {
		// The deny-list must not make a table unusable — only its secrets.
		res, err := biSQLExecute(ctx, db,
			`SELECT id, full_name, role FROM app.o3c_users ORDER BY id LIMIT 3`, 10)
		if err != nil {
			t.Fatalf("a legitimate query over o3c_users was refused: %v", err)
		}
		if res.RowCount == 0 {
			t.Error("no users returned")
		}
	})

	t.Run("an aliased credential is still refused", func(t *testing.T) {
		_, err := biSQLExecute(ctx, db,
			`SELECT id, password_hash AS notes FROM app.o3c_users LIMIT 1`, 10)
		if err == nil {
			t.Fatal("password_hash aliased to 'notes' was returned")
		}
	})

	t.Run("the statement timeout is enforced", func(t *testing.T) {
		// generate_series rather than pg_sleep, which the validator refuses outright —
		// the point here is the TIMEOUT, not the keyword check.
		_, err := biSQLExecute(ctx, db,
			`SELECT count(*) FROM generate_series(1, 20000000000) g`, 10)
		if err == nil {
			t.Fatal("a query over 20bn rows completed, which means no timeout applied")
		}
		if !strings.Contains(err.Error(), "cancelled") && !strings.Contains(err.Error(), "timeout") {
			t.Logf("refused, though not obviously by the timeout: %v", err)
		}
	})
}

func TestBISQLSchemaHidesDeniedColumnsLive(t *testing.T) {
	db, done := biSQLTestDB(t)
	defer done()

	rows, err := db.PGQuery(t.Context(), `
		SELECT c.column_name
		  FROM information_schema.columns c
		 WHERE c.table_schema='app' AND c.table_name='o3c_users'`)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	found := false
	for _, r := range rows {
		if str(r["column_name"]) == "password_hash" {
			found = true
		}
	}
	if !found {
		t.Skip("o3c_users has no password_hash — nothing to hide")
	}
	// The endpoint filters the deny-list out of its suggestions. Asserted on the map
	// rather than over HTTP because the filtering is the contract: a console that
	// autocompletes a column it will then refuse teaches people to try.
	if _, denied := biSQLDeniedColumns["password_hash"]; !denied {
		t.Error("password_hash is not on the deny-list, so the schema endpoint would " +
			"offer it as a suggestion")
	}
}

// TestBISQLRefusesComputingWithACredential covers the hole found by trying it: the
// result screen checks names and value shapes, and both are bypassed by computing with
// the secret rather than selecting it.
//
// Verified against the live database before the fix:
//
//	SELECT length(password_hash) AS n, substr(password_hash, 2, 12) AS x FROM app.o3c_users
//	→ 60 | 2a$12$kyNmzV
//
// The alias is innocent and the fragment does not start with "$2a$", so nothing
// downstream recognised it. Repeat with a moving offset and the hash comes out in
// twelve-character pieces.
func TestBISQLRefusesComputingWithACredential(t *testing.T) {
	for _, q := range []string{
		`SELECT length(password_hash) AS n FROM app.o3c_users`,
		`SELECT substr(password_hash, 2, 12) AS x FROM app.o3c_users`,
		`SELECT md5(password_hash) AS h FROM app.o3c_users`,
		`SELECT count(*) FROM app.o3c_users WHERE password_hash LIKE '$2a$%'`,
		`SELECT encrypted_value AS v FROM app.api_credentials`,
		`SELECT upper(totp_secret_encrypted) FROM app.o3c_users`,
		`SELECT subject_name_encrypted FROM app.sars`,
		`SELECT id_value FROM app.watch_list_entries`,
	} {
		if err := biSQLValidate(q); err == nil {
			t.Errorf("a query computing with a credential was allowed: %s", q)
		}
	}
}

// TestBISQLStillAllowsTheMaskedColumns is the other half: the deny-list must not take
// away the columns an analyst is supposed to use. Word-boundary matching is what makes
// this work — an underscore is a word character, so \bbvn\b does not match bvn_masked.
func TestBISQLStillAllowsTheMaskedColumns(t *testing.T) {
	for _, q := range []string{
		`SELECT bvn_masked FROM app.customers LIMIT 5`,
		`SELECT card_pan_masked FROM app.card_issuance_requests LIMIT 5`,
		`SELECT id_value_masked FROM app.watch_list_entries LIMIT 5`,
		// A token COUNT is fine; it is the value that is secret.
		`SELECT count(*) AS tokens_issued FROM app.sse_tokens`,
		// And ordinary analysis must not trip over a word that merely contains one.
		`SELECT customer_name, amount_kobo FROM app.collection_payments LIMIT 5`,
	} {
		if err := biSQLValidate(q); err != nil {
			t.Errorf("a legitimate query was refused: %s\n  %v", q, err)
		}
	}
}

// ── Found by reviewing Phase 2 rather than by using it ───────────────────────

// TestBISQLTrailingSemicolonRunsLive covers a bug the validator endorsed.
//
// biSQLValidate deliberately allows "SELECT 1;" because every SQL client allows it, and
// a test above asserts that. But the executor wraps the query in a subquery to apply the
// row cap, and `SELECT * FROM (SELECT 1;) AS q LIMIT n` is a syntax error — confirmed
// against this database. So the console accepted the query and then handed back a
// Postgres error pointing at a semicolon the analyst was entitled to type. The test
// suite was endorsing a broken path, which is worse than not covering it.
func TestBISQLTrailingSemicolonRunsLive(t *testing.T) {
	db, done := biSQLTestDB(t)
	defer done()

	for _, q := range []string{
		"SELECT 1 AS a;",
		"SELECT 1 AS a;  ",
		"SELECT cif FROM app.customers LIMIT 2 ;\n",
	} {
		res, err := biSQLExecute(t.Context(), db, q, 10)
		if err != nil {
			t.Errorf("a query with a trailing semicolon failed: %q\n  %v", q, err)
			continue
		}
		if res.RowCount == 0 {
			t.Errorf("%q returned no rows", q)
		}
	}
}

// TestBISQLDuplicateColumnNamesAreKeptApartLive covers silent data corruption.
//
// Postgres happily returns two columns of the same name — SELECT a.id, b.id, or any
// SELECT * across a join where both sides have a cif. A row here is a map keyed on the
// column name, so without de-duplication the second value overwrites the first and BOTH
// headings show the second column's value: two different numbers rendered as one, with
// nothing on screen to suggest it.
func TestBISQLDuplicateColumnNamesAreKeptApartLive(t *testing.T) {
	db, done := biSQLTestDB(t)
	defer done()

	res, err := biSQLExecute(t.Context(), db,
		`SELECT cif, cif, full_name FROM app.customers WHERE cif IS NOT NULL LIMIT 1`, 5)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if len(res.Columns) != 3 {
		t.Fatalf("got %d columns %v, want 3", len(res.Columns), res.Columns)
	}
	seen := map[string]bool{}
	for _, c := range res.Columns {
		if seen[c] {
			t.Errorf("column %q appears twice in the result — a map-keyed row will lose "+
				"one of them", c)
		}
		seen[c] = true
	}
	if res.Columns[1] != "cif (2)" {
		t.Errorf("the duplicate is named %q; expected \"cif (2)\" so an analyst can tell "+
			"the two apart", res.Columns[1])
	}
	// And the row must carry both keys, or the table renders an empty cell.
	for _, k := range res.Columns {
		if _, ok := res.Rows[0][k]; !ok {
			t.Errorf("the row has no value for column %q", k)
		}
	}
}

// TestBISQLPostgresRefusesADataModifyingCTELive is the cleverest bypass available: a
// WITH clause whose body writes and whose SELECT only reads the RETURNING rows. It
// passes the "starts with SELECT or WITH" check by construction, and no keyword list
// sensibly enumerates it.
//
// Verified against this database: both UPDATE..RETURNING and INSERT..RETURNING inside a
// CTE are refused with "cannot execute SELECT in a read-only transaction". This test
// exists so that refusal is pinned rather than assumed, because it is the single thing
// standing between "WITH" being allowed and the console being writable.
func TestBISQLPostgresRefusesADataModifyingCTELive(t *testing.T) {
	db, done := biSQLTestDB(t)
	defer done()

	for _, q := range []string{
		`WITH x AS (UPDATE app.customers SET city = city WHERE false RETURNING cif) SELECT * FROM x`,
		`WITH x AS (DELETE FROM app.fx_parallel_rates WHERE false RETURNING id) SELECT * FROM x`,
		`WITH x AS (INSERT INTO app.fx_parallel_rates (source, currency, buy, sell)
		            VALUES ('probe','XXX',1,1) RETURNING id) SELECT * FROM x`,
	} {
		if _, err := biSQLExecute(t.Context(), db, q, 5); err == nil {
			t.Errorf("A DATA-MODIFYING CTE WAS ACCEPTED. This is the bypass that makes "+
				"allowing WITH dangerous:\n%s", q)
		}
	}
}

// TestBISQLLimitClampsToTheMaximum covers a small bug with a disproportionate effect: a
// request over the cap used to fall back to the DEFAULT, so asking for 25,000 rows gave
// 2,000 — an order of magnitude fewer than asked for, silently. Over the cap now means
// the cap.
func TestBISQLLimitClampsToTheMaximum(t *testing.T) {
	db, done := biSQLTestDB(t)
	defer done()

	res, err := biSQLExecute(t.Context(), db, `SELECT cif FROM app.customers`, 999999)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if res.Limit != biSQLMaxRows {
		t.Errorf("limit resolved to %d; asking for more than the cap should give the cap "+
			"(%d), not the default (%d)", res.Limit, biSQLMaxRows, biSQLDefaultRows)
	}
}

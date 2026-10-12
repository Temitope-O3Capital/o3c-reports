package handlers

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

/*
THE BI SQL CONSOLE.

BI asked to write SQL directly rather than only through the Report Builder. That is a
reasonable ask — a registry of 52 datasets still cannot answer a question that spans
three of them — and it is also the single most dangerous surface in the workspace, so
the controls below are listed in the order they actually protect anything.

WHAT ENFORCES WHAT, AND IN WHICH ORDER:

 1. POSTGRES, NOT THIS FILE. Every query runs inside a transaction opened with
    sql.TxOptions{ReadOnly: true}, reinforced with `SET LOCAL transaction_read_only =
    on`, and rolled back at the end whatever happens. Verified against this database on
    2026-10-09: CREATE TABLE inside it fails with "cannot execute CREATE TABLE in a
    read-only transaction". That is the engine refusing, not a parser hoping. INSERT,
    UPDATE, DELETE, DDL and anything else that writes are refused the same way, which is
    why the keyword checks in biSQLValidate are defence in depth rather than the defence.

 2. A STATEMENT TIMEOUT, also Postgres. `SET LOCAL statement_timeout` is set per
    transaction; verified the same day that pg_sleep(2) under a 300ms timeout is
    cancelled. A console without one is an outage waiting for a cartesian join.

 3. A COLUMN DENY-LIST APPLIED TO THE RESULT, NOT THE QUERY. This is the part worth
    explaining, because the obvious design is wrong. Scanning the SQL text for
    "password_hash" does nothing about `SELECT * FROM o3c_users`, and no regex short of
    a real parser can tell which columns a statement will actually return. So the check
    runs AFTER execution and BEFORE the rows are handed back: if any returned column
    name is on the deny-list, the whole result is discarded. The query may touch those
    tables — joining on a user id is legitimate — it simply cannot hand back the secret.

 4. A VALUE FINGERPRINT SCAN, because step 3 is defeated by `SELECT password_hash AS x`.
    Returned values are checked for the shapes secrets have: bcrypt and argon2 prefixes,
    PEM headers, and the workspace's own encrypted-blob prefix. Aliasing hides the name;
    it does not change the bytes.

 5. ROLE GATE. Guarded on the "reports" page, which core/auth.go grants to bi_analyst,
    bi_head and admin only — deliberately NOT "report_builder", which every department
    head holds. The console is for BI; department heads get the 52 department-scoped
    datasets instead.

 6. EVERY RUN IS LOGGED, with the SQL text, to report_export_log — the same table the
    export engine writes to, so "what left the building" is one query, not two.

WHAT THIS DOES NOT DO. It does not create a separate database role. The app connects as
o3_app, which has rolcreaterole = false, so the role has to be made by a superuser;
see migrations/351 for the script and why it is worth doing anyway. Until then
`o3c_users.password_hash` is reachable BY THE CONNECTION even though it is unreachable
through this endpoint, and the difference matters: steps 3 and 4 are application
controls, and the role would be a database one.
*/

const (
	// Deliberately generous for analysis and still bounded. The export engine's own
	// default is 100,000, but that goes to a file; this goes into a browser table.
	biSQLDefaultRows = 2000
	biSQLMaxRows     = 20000
	// Long enough for a real aggregate over 1m card transactions, short enough that a
	// mistake does not hold a pooled connection all afternoon.
	biSQLTimeout = 25 * time.Second
)

// biSQLDeniedColumns are column names that must never be returned, whatever query asks
// for them. Measured against information_schema on 2026-10-09 — every one of these
// exists in app today.
var biSQLDeniedColumns = map[string]string{
	"password_hash":            "o3c_users — a credential",
	"totp_secret_encrypted":    "o3c_users — a second factor",
	"telnyx_sip_password_enc":  "o3c_users — a SIP credential",
	"zoho_voice_refresh_token": "o3c_users — an OAuth refresh token",
	"zoho_voice_access_token":  "o3c_users — an OAuth access token",
	"encrypted_value":          "api_credentials — every provider secret in the platform",
	"api_key":                  "fx_api_clients — a live API key",
	"token":                    "sse_tokens / survey_sends — a bearer token",
	"csat_token":               "helpdesk_tickets — a survey bearer token",
	"subject_name_encrypted":   "sars — a SAR subject",
	"subject_id_encrypted":     "sars — a SAR subject's identity document",
	"summary_encrypted":        "sars — the substance of a SAR",
	"id_number_enc":            "crm_contacts — an encrypted identity document",
	"id_number_hmac":           "crm_contacts — a searchable hash of one",
	"phone_hmac":               "campaign_contacts / contact_list_members",
	"email_hmac":               "campaign_contacts / contact_list_members",
	"tokens_valid_from":        "o3c_users — session invalidation state",
	"must_change_password":     "o3c_users — account state",
	"card_pan":                 "accounts / card_issuance_requests — use the masked column",
	"bvn":                      "customers — use bvn_masked",
	"nin":                      "customers",
	"id_value":                 "watch_list_entries — use the masked column",
}

// biSQLSecretShapes are the fingerprints a credential leaves in its own value, used to
// catch an aliased column. Cheap to check and specific enough not to fire on prose.
var biSQLSecretShapes = []struct {
	prefix string
	what   string
}{
	{"$2a$", "a bcrypt hash"},
	{"$2b$", "a bcrypt hash"},
	{"$2y$", "a bcrypt hash"},
	{"$argon2", "an argon2 hash"},
	{"-----BEGIN", "a PEM private key or certificate"},
	{"sk_live_", "a live secret key"},
	{"sk_test_", "a secret key"},
	{"SG.", "a SendGrid API key"},
}

// biSQLBannedTokens are refused before execution. None of them is the real control — a
// read-only transaction already refuses every write — but they turn an accident into a
// clear message instead of a Postgres error, and they close off the file and network
// reach that a read-only transaction still permits.
var biSQLBannedTokens = []struct {
	re  *regexp.Regexp
	why string
}{
	{regexp.MustCompile(`(?i)\bpg_read_file\b|\bpg_read_binary_file\b|\bpg_ls_dir\b|\bpg_stat_file\b`),
		"reads files from the database server"},
	{regexp.MustCompile(`(?i)\blo_import\b|\blo_export\b`), "reads or writes server-side large objects"},
	{regexp.MustCompile(`(?i)\bdblink\b|\bpostgres_fdw\b`), "opens a connection to another server"},
	{regexp.MustCompile(`(?i)\bcopy\b\s`), "COPY reads or writes server files"},
	{regexp.MustCompile(`(?i)\bpg_sleep\b|\bpg_sleep_for\b`), "holds a pooled connection open for no result"},
	{regexp.MustCompile(`(?i)\bset_config\b|\bpg_reload_conf\b|\bpg_terminate_backend\b|\bpg_cancel_backend\b`),
		"changes server state"},
	{regexp.MustCompile(`(?i)\bcurrent_setting\s*\(\s*'[^']*password`), "reads a connection secret"},
}

// biSQLStatementStartRE requires the query to begin as a read. WITH is admitted because
// a CTE is how any real analysis is written — and a data-modifying CTE is still refused
// by the read-only transaction underneath.
var biSQLStatementStartRE = regexp.MustCompile(`(?is)^\s*(select|with)\b`)

type biSQLRequest struct {
	SQL   string `json:"sql"`
	Limit int    `json:"limit"`
}

type biSQLResult struct {
	Columns   []string         `json:"columns"`
	Rows      []map[string]any `json:"rows"`
	RowCount  int              `json:"row_count"`
	Truncated bool             `json:"truncated"`
	Limit     int              `json:"limit"`
	ElapsedMS int64            `json:"elapsed_ms"`
	// Which connection ran it, so a missing read-only role is visible on screen.
	Connection string `json:"connection"`
}

// RegisterBISQL mounts the console. See the file comment for what guards it.
func RegisterBISQL(r chi.Router, db *core.DB) {
	// "reports" and not "report_builder": the former is BI and admin, the latter is
	// every department head. This is the line between "query the whole warehouse" and
	// "report on your own department", and it is the same line the export engine draws.
	access := core.RequirePages("reports")

	r.With(access).Post("/run", biSQLRun(db))
	r.With(access).Get("/saved", biSQLListSaved(db))
	r.With(access).Post("/saved", biSQLSaveQuery(db))
	r.With(access).Put("/saved/{id}", biSQLUpdateSaved(db))
	r.With(access).Delete("/saved/{id}", biSQLDeleteSaved(db))
	r.With(access).Get("/schema", biSQLSchema(db))
}

// biSQLValidate rejects what should never reach the database. It is the FOURTH line of
// defence, not the first; see the file comment.
func biSQLValidate(q string) error {
	s := strings.TrimSpace(q)
	if s == "" {
		return fmt.Errorf("nothing to run")
	}
	if len(s) > 20000 {
		return fmt.Errorf("query is longer than 20,000 characters")
	}
	if !biSQLStatementStartRE.MatchString(s) {
		return fmt.Errorf("only SELECT and WITH queries can be run here — this console is read-only")
	}
	// One statement. A trailing semicolon is fine; a second statement is not.
	if trimmed := strings.TrimRight(s, "; \t\r\n"); strings.Contains(trimmed, ";") {
		return fmt.Errorf("run one statement at a time — remove the ';' in the middle of the query")
	}
	// Naming a credential column, even only to compute with it. See
	// biSQLDeniedNameRE for why this sits alongside the result screen rather than
	// instead of it.
	if hit := biSQLNamesACredential(s); hit != "" {
		return fmt.Errorf("that query names %q, which this console never reads (%s). "+
			"Computing with it -- length(), substr() -- is refused for the same reason",
			hit, biSQLDeniedColumns[strings.ToLower(hit)])
	}
	for _, b := range biSQLBannedTokens {
		if b.re.MatchString(s) {
			return fmt.Errorf("that query uses something this console does not allow: %s", b.why)
		}
	}
	return nil
}

// biSQLCheckResult is step 3 and step 4 of the controls: refuse the RESULT if it carries
// a secret, whether named or aliased.
func biSQLCheckResult(cols []string, rows []map[string]any) error {
	for _, c := range cols {
		if what, denied := biSQLDeniedColumns[strings.ToLower(strings.TrimSpace(c))]; denied {
			return fmt.Errorf("the result includes %q, which this console never returns (%s). "+
				"Join to the table if you need to — just do not select that column", c, what)
		}
	}
	for _, r := range rows {
		for col, v := range r {
			s, ok := v.(string)
			if !ok || len(s) < 4 {
				continue
			}
			for _, shape := range biSQLSecretShapes {
				if strings.HasPrefix(s, shape.prefix) {
					return fmt.Errorf("column %q returned what looks like %s. Renaming a "+
						"credential column does not make it returnable", col, shape.what)
				}
			}
		}
	}
	return nil
}

// biSQLExecute runs one read-only statement and returns ordered columns with the rows.
//
// Column ORDER is preserved deliberately. core.Row is a map, so the shared query helper
// cannot say which column came first, and a console that reorders a analyst's SELECT
// list alphabetically is quietly unusable.
func biSQLExecute(ctx context.Context, db *core.DB, q string, limit int) (*biSQLResult, error) {
	if err := biSQLValidate(q); err != nil {
		return nil, err
	}
	// CLAMP, do not fall back. Asking for 25,000 rows used to silently give 2,000 — the
	// DEFAULT rather than the maximum — so an analyst who asked for more got dramatically
	// less and nothing said why. Over the cap now means the cap.
	if limit <= 0 {
		limit = biSQLDefaultRows
	}
	if limit > biSQLMaxRows {
		limit = biSQLMaxRows
	}

	ctx, cancel := context.WithTimeout(ctx, biSQLTimeout+5*time.Second)
	defer cancel()

	// ReadOnly at the driver, and again with SET LOCAL below, because a pooler can be
	// configured in ways that make the first one a no-op and the cost of both is nothing.
	conn, connLabel := biSQLConn(db)
	tx, err := conn.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, fmt.Errorf("could not start a read-only transaction: %w", err)
	}
	// Always rolled back. Nothing this console does is ever committed, so there is no
	// path — not an error path, not a panic path — where a write could survive.
	defer tx.Rollback() //nolint:errcheck

	if _, err := tx.ExecContext(ctx, "SET LOCAL transaction_read_only = on"); err != nil {
		return nil, fmt.Errorf("could not make the transaction read-only: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		fmt.Sprintf("SET LOCAL statement_timeout = '%dms'", biSQLTimeout.Milliseconds())); err != nil {
		return nil, fmt.Errorf("could not set the query timeout: %w", err)
	}

	// THE TRAILING SEMICOLON HAS TO GO BEFORE WRAPPING. biSQLValidate deliberately
	// allows "SELECT 1;" because every SQL client on earth does, but the wrapper puts
	// the query inside a subquery, and "SELECT * FROM (SELECT 1;) AS q LIMIT n" is a
	// syntax error. Found by running it: the console accepted the query, then handed
	// back a Postgres syntax error pointing at a semicolon the analyst was entitled to
	// type. Stripped here rather than refused in the validator — refusing it would be
	// pedantry about punctuation.
	inner := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(q), ";"))
	// limit+1 so "there is more" can be reported honestly rather than silently cut.
	wrapped := fmt.Sprintf("SELECT * FROM (%s) AS bi_console_q LIMIT %d", inner, limit+1)

	started := time.Now()
	rows, err := tx.QueryContext(ctx, wrapped)
	if err != nil {
		return nil, biSQLFriendlyError(err)
	}
	defer rows.Close()

	rawCols, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	// DUPLICATE COLUMN NAMES MUST BE MADE DISTINCT BEFORE THE ROWS ARE BUILT.
	//
	// Postgres is perfectly happy to return two columns called the same thing --
	// SELECT a.id, b.id, or any SELECT * over a join of two tables that both have a
	// cif. A row here is a map keyed on the column name, so the second value would
	// overwrite the first and BOTH headings would then show the second column's value.
	// Not a crash, and not an empty cell: two different numbers silently rendered as
	// one. Verified on this database that `SELECT cif, cif FROM app.customers` returns
	// two columns, so this is reachable by accident, not just by contrivance.
	cols := biSQLDistinctColumns(rawCols)
	out := make([]map[string]any, 0, limit)
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		m := make(map[string]any, len(cols))
		for i, c := range cols {
			m[c] = biSQLNormalize(vals[i])
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, biSQLFriendlyError(err)
	}

	truncated := len(out) > limit
	if truncated {
		out = out[:limit]
	}
	if err := biSQLCheckResult(cols, out); err != nil {
		return nil, err
	}
	return &biSQLResult{
		Columns: cols, Rows: out, RowCount: len(out),
		Truncated: truncated, Limit: limit,
		ElapsedMS:  time.Since(started).Milliseconds(),
		Connection: connLabel,
	}, nil
}

// biSQLFriendlyError turns the two failures an analyst will actually hit into something
// that says what to do next. Everything else is passed through verbatim — a syntax error
// is most useful in Postgres's own words.
func biSQLFriendlyError(err error) error {
	s := err.Error()
	switch {
	case strings.Contains(s, "statement timeout"):
		return fmt.Errorf("the query ran longer than %s and was cancelled. Narrow the date "+
			"range, or aggregate before joining", biSQLTimeout)
	case strings.Contains(s, "read-only transaction"):
		return fmt.Errorf("that statement writes, and this console is read-only")
	}
	return err
}

func biSQLRun(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in biSQLRequest
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			respondErr(w, 400, "Could not read the request")
			return
		}
		u := core.UserFromCtx(r.Context())
		res, err := biSQLExecute(r.Context(), db, in.SQL, in.Limit)

		// Logged either way. A refused query is the more interesting audit record.
		biSQLLog(r, db, u, in.SQL, res, err)

		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		respond(w, res, "pg")
	}
}

// biSQLLog records every run in report_export_log, the same place the export engine
// writes, so one query answers "what has left the building".
func biSQLLog(r *http.Request, db *core.DB, u *core.Claims, q string, res *biSQLResult, runErr error) {
	status, rowCount := "ok", 0
	if runErr != nil {
		status = "refused"
	} else if res != nil {
		rowCount = res.RowCount
	}
	name, role := "", ""
	if u != nil {
		name, role = u.FullName, u.Role
	}
	metaJSON, _ := json.Marshal(map[string]any{
		"sql":       q,
		"module":    "bi_sql_console",
		"truncated": res != nil && res.Truncated,
		"error":     biSQLErrText(runErr),
	})
	var uid *int64
	if u != nil {
		id := u.ID
		uid = &id
	}
	if _, err := db.PGExec(r.Context(), `
		INSERT INTO report_export_log
			(report_type, filters, row_count, created_by, format, status,
			 actor_name, actor_role, ip_address)
		VALUES ('bi_sql_console', $1::jsonb, $2, $3, 'screen', $4, $5, $6, $7)`,
		string(metaJSON), rowCount, uid, status, name, role, clientIP(r)); err != nil {
		slog.Error("biSQLLog", "err", err)
	}
}

// biSQLSchema lists the tables and columns an analyst may query, so the console can
// offer them without anyone memorising 363 table names.
//
// The deny-list is applied HERE TOO, so a denied column is not even suggested. A console
// that autocompletes password_hash and then refuses to return it is a console that
// teaches people to try.
func biSQLSchema(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT c.table_name, c.column_name, c.data_type
			  FROM information_schema.columns c
			  JOIN information_schema.tables t
			    ON t.table_schema = c.table_schema AND t.table_name = c.table_name
			 WHERE c.table_schema = 'app' AND t.table_type = 'BASE TABLE'
			 ORDER BY c.table_name, c.ordinal_position`)
		if err != nil {
			respondErrLog(w, 500, "Could not read the schema", err)
			return
		}
		type tbl struct {
			Table   string   `json:"table"`
			Columns []string `json:"columns"`
		}
		order := []string{}
		byTable := map[string]*tbl{}
		for _, row := range rows {
			name := str(row["table_name"])
			col := str(row["column_name"])
			if _, denied := biSQLDeniedColumns[strings.ToLower(col)]; denied {
				continue
			}
			if byTable[name] == nil {
				byTable[name] = &tbl{Table: name}
				order = append(order, name)
			}
			byTable[name].Columns = append(byTable[name].Columns,
				col+" · "+str(row["data_type"]))
		}
		out := make([]*tbl, 0, len(order))
		for _, n := range order {
			out = append(out, byTable[n])
		}
		respond(w, out, "pg")
	}
}

// ── Saved queries ─────────────────────────────────────────────────────────────

func biSQLListSaved(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := core.UserFromCtx(r.Context())
		if u == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT q.id, q.name, q.description, q.sql_text, q.is_shared,
			       q.created_by, q.created_at, q.updated_at,
			       COALESCE(uu.full_name, '') AS created_by_name,
			       (q.created_by = $1) AS is_mine
			  FROM app.bi_sql_queries q
			  LEFT JOIN app.o3c_users uu ON uu.id = q.created_by
			 WHERE q.created_by = $1 OR q.is_shared
			 ORDER BY q.updated_at DESC`, u.ID)
		if err != nil {
			respondErrLog(w, 500, "Could not list saved queries", err)
			return
		}
		respond(w, rows, "pg")
	}
}

func biSQLSaveQuery(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Name        string `json:"name"`
			Description string `json:"description"`
			SQL         string `json:"sql"`
			IsShared    bool   `json:"is_shared"`
		}
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			respondErr(w, 400, "Could not read the request")
			return
		}
		if strings.TrimSpace(in.Name) == "" {
			respondErr(w, 400, "Give the query a name")
			return
		}
		// Validated on save as well as on run, so a query that could never execute is
		// not stored and shared for someone else to discover.
		if err := biSQLValidate(in.SQL); err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		u := core.UserFromCtx(r.Context())
		if u == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO app.bi_sql_queries (name, description, sql_text, is_shared, created_by)
			VALUES ($1,$2,$3,$4,$5) RETURNING id`,
			strings.TrimSpace(in.Name), in.Description, in.SQL, in.IsShared, u.ID)
		if err != nil {
			respondErrLog(w, 500, "Could not save the query", err)
			return
		}
		id := int64(0)
		if len(rows) > 0 {
			id = toInt64(rows[0]["id"])
		}
		respond(w, map[string]any{"id": id}, "pg")
	}
}

func biSQLUpdateSaved(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Name        *string `json:"name"`
			Description *string `json:"description"`
			SQL         *string `json:"sql"`
			IsShared    *bool   `json:"is_shared"`
		}
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			respondErr(w, 400, "Could not read the request")
			return
		}
		if in.SQL != nil {
			if err := biSQLValidate(*in.SQL); err != nil {
				respondErr(w, 400, err.Error())
				return
			}
		}
		u := core.UserFromCtx(r.Context())
		if u == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		// OWNERSHIP IS CHECKED IN THE WHERE CLAUSE, not read-then-write: a shared query
		// is visible to every analyst, and visibility is not permission to edit. Admins
		// are not special-cased here — an admin who needs to change someone's saved query
		// can delete it, which is at least visible.
		res, err := db.PGExec(r.Context(), `
			UPDATE app.bi_sql_queries
			   SET name        = COALESCE($3, name),
			       description = COALESCE($4, description),
			       sql_text    = COALESCE($5, sql_text),
			       is_shared   = COALESCE($6, is_shared),
			       updated_at  = NOW()
			 WHERE id = $1 AND created_by = $2`,
			chi.URLParam(r, "id"), u.ID, in.Name, in.Description, in.SQL, in.IsShared)
		if err != nil {
			respondErrLog(w, 500, "Could not update the query", err)
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			respondErr(w, 404, "No saved query of yours with that id")
			return
		}
		respond(w, map[string]any{"ok": true}, "pg")
	}
}

func biSQLDeleteSaved(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := core.UserFromCtx(r.Context())
		if u == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		res, err := db.PGExec(r.Context(),
			`DELETE FROM app.bi_sql_queries WHERE id = $1 AND created_by = $2`,
			chi.URLParam(r, "id"), u.ID)
		if err != nil {
			respondErrLog(w, 500, "Could not delete the query", err)
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			respondErr(w, 404, "No saved query of yours with that id")
			return
		}
		respond(w, map[string]any{"ok": true}, "pg")
	}
}

// biSQLNormalize mirrors core's own value handling for an ad-hoc result set.
//
// The shared query helper normalises values before building its map, but it returns an
// unordered map and this console must preserve the analyst's SELECT order, so it reads
// rows itself — and then has to do the same normalising. Without it a text column
// arrives as []byte and the secret-shape scan below would never match a prefix, because
// []byte is not a string.
func biSQLNormalize(v any) any {
	switch t := v.(type) {
	case []byte:
		return string(t)
	case int32:
		return int64(t)
	default:
		return v
	}
}

func biSQLErrText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// ── Which connection the console uses ─────────────────────────────────────────
//
// By default the console borrows the application's own pool, which is safe to the extent
// that a read-only transaction and a statement timeout make it safe — and those are
// enforced by Postgres, so it is a real extent. What it is not is a DATABASE boundary:
// o3_app can still SELECT app.o3c_users.password_hash, and the console's refusal to
// return it is an application control.
//
// If BI_SQL_DATABASE_URL is set, every console query runs on that connection instead.
// Point it at the o3_bi_readonly role in migrations/351 and the boundary moves into
// Postgres: the credential columns are not merely unreturnable, they are unreadable.
//
// Deliberately OPTIONAL and announced. The alternative — refusing to work until a DBA
// provisions a role — would have meant shipping nothing, and the platform already has
// two features switched off waiting for configuration (Graph mail ingestion, the board
// pack) with nothing on screen explaining why. Every result says which connection
// produced it, so the hardening is visible as missing rather than silently absent.
var (
	biSQLPoolOnce  sync.Once
	biSQLPool      *sql.DB
	biSQLPoolLabel string
)

func biSQLConn(db *core.DB) (*sql.DB, string) {
	biSQLPoolOnce.Do(func() {
		url := strings.TrimSpace(os.Getenv("BI_SQL_DATABASE_URL"))
		if url == "" {
			biSQLPoolLabel = "app connection (o3_app) — set BI_SQL_DATABASE_URL to use a read-only role"
			return
		}
		pool, err := sql.Open("pgx", url)
		if err != nil {
			slog.Error("BI SQL console: BI_SQL_DATABASE_URL is set but unusable; "+
				"falling back to the app connection", "err", err)
			biSQLPoolLabel = "app connection (BI_SQL_DATABASE_URL failed to open)"
			return
		}
		// PING BEFORE TRUSTING IT. sql.Open does not connect -- it only parses the DSN --
		// so a wrong password or an unreachable host would have been discovered by
		// every query failing, with the console reporting "read-only role" while
		// returning nothing at all. Verifying here means a misconfiguration degrades
		// to the app connection, which works, and says so on screen.
		pctx, pcancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer pcancel()
		if err := pool.PingContext(pctx); err != nil {
			slog.Error("BI SQL console: BI_SQL_DATABASE_URL will not connect; falling "+
				"back to the app connection", "err", err)
			pool.Close()
			biSQLPoolLabel = "app connection (BI_SQL_DATABASE_URL would not connect)"
			return
		}
		// Small on purpose: this pool exists for interactive analysis by a handful of
		// people, and a runaway console should not be able to starve the application.
		pool.SetMaxOpenConns(4)
		pool.SetMaxIdleConns(2)
		pool.SetConnMaxLifetime(30 * time.Minute)
		biSQLPool = pool
		biSQLPoolLabel = "read-only role (BI_SQL_DATABASE_URL)"
		slog.Info("BI SQL console using a dedicated read-only connection")
	})
	if biSQLPool != nil {
		return biSQLPool, biSQLPoolLabel
	}
	return db.PG, biSQLPoolLabel
}

// ── Naming a credential column at all ─────────────────────────────────────────
//
// THE HOLE THIS CLOSES, FOUND BY TRYING IT. The result screen checks the column names
// that come back and the shapes of the values. Both are defeated by computing with the
// secret instead of selecting it:
//
//	SELECT length(password_hash) AS n, substr(password_hash, 2, 12) AS x
//	  FROM app.o3c_users
//
// Run against this database on 2026-10-09 that returns `60 | 2a$12$kyNmzV`. The alias is
// not on the deny-list, and the value starts "2a$" rather than "$2a$", so the prefix scan
// does not recognise it either. Repeat with a moving offset and the whole hash comes out
// twelve characters at a time.
//
// So the query TEXT is scanned too, for the denied names as whole words. Stated plainly
// because the asymmetry is the point: NEITHER LAYER IS SUFFICIENT ALONE, and each covers
// precisely the other's blind spot.
//
//   - a text scan alone is defeated by `SELECT * FROM app.o3c_users`, which never names
//     the column;
//   - a result scan alone is defeated by the substr() above, which never returns it.
//
// Whole words, so the masked columns stay usable: `\bbvn\b` does not match inside
// bvn_masked, and `\bcard_pan\b` does not match card_pan_masked, because an underscore
// is a word character. Those are the columns an analyst is SUPPOSED to use.
var biSQLDeniedNameRE = func() *regexp.Regexp {
	names := make([]string, 0, len(biSQLDeniedColumns))
	for c := range biSQLDeniedColumns {
		names = append(names, regexp.QuoteMeta(c))
	}
	sort.Strings(names) // a stable pattern, so the same query always fails the same way
	return regexp.MustCompile(`(?i)\b(` + strings.Join(names, "|") + `)\b`)
}()

// biSQLNamesACredential reports the first denied column a query mentions, or "".
func biSQLNamesACredential(q string) string {
	return biSQLDeniedNameRE.FindString(q)
}

// biSQLDistinctColumns makes a result's column names unique, preserving order and
// leaving the common case untouched.
//
// A duplicate is suffixed with its position — id, "id (2)", "id (3)" — rather than
// dropped or silently merged, because an analyst who wrote SELECT a.id, b.id wants both
// and needs to be able to tell which is which. The label is deliberately human rather
// than id_2: it is rendered as a column heading, not used as an identifier.
func biSQLDistinctColumns(in []string) []string {
	seen := make(map[string]int, len(in))
	out := make([]string, len(in))
	for i, c := range in {
		seen[c]++
		if n := seen[c]; n > 1 {
			out[i] = fmt.Sprintf("%s (%d)", c, n)
			continue
		}
		out[i] = c
	}
	return out
}

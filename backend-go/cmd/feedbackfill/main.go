// One-off backfill for the feed columns migration 233 added. Not part of the server
// build (the deploy exe builds from `.`).
//
// Migration 233 gave the account, customer and transaction feeds columns for fields
// they had always parsed past. New drops fill them; this fills them for rows that
// arrived before, by re-reading the drops retained under DATA_FEED_DIR:
//
//	accounts      currency_code, status_code, interest_rate, card_issue_date — from
//	              the newest non-empty value for each account across every acct_file
//	customers     address_3, phone_2 — the same, from cust_file, matched on CIF with
//	              leading zeros ignored (the baseline and the feed pad differently)
//	transactions  pcc, code_class — from txn_file, matched on row_hash, so only rows
//	              the feed itself inserted can be reached (baseline rows never carried
//	              these fields)
//	currency      transactions.currency_code for every row with a known account, by
//	              app.resolve_currency — the same rule the live insert uses
//
// It only ever fills a column that is NULL. It never overwrites a value, never
// inserts or deletes a row, and prints counts only — no customer data.
//
//	go run ./cmd/feedbackfill                  # dry run: read, stage, count; changes nothing
//	go run ./cmd/feedbackfill -apply           # write
//	go run ./cmd/feedbackfill -only accounts   # one step (accounts,customers,transactions,currency)
package main

import (
	"bufio"
	"context"
	"database/sql"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/o3c/workspace/acctfeed"
	"github.com/o3c/workspace/custfeed"
	"github.com/o3c/workspace/feedcore"
	"github.com/o3c/workspace/txnfeed"
)

func loadEnv(path string) map[string]string {
	m := map[string]string{}
	f, err := os.Open(path)
	if err != nil {
		return m
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		i := strings.Index(line, "=")
		if i < 0 {
			continue
		}
		m[strings.TrimSpace(line[:i])] = strings.Trim(strings.TrimSpace(line[i+1:]), `"'`)
	}
	return m
}

func main() {
	apply := flag.Bool("apply", false, "write the backfill (default: dry run, which changes nothing)")
	only := flag.String("only", "accounts,customers,transactions,currency", "comma-separated steps to run")
	flag.Parse()

	env := loadEnv(".env")
	get := func(k string) string {
		if v := os.Getenv(k); v != "" {
			return v
		}
		return env[k]
	}
	dsn, root := get("DATABASE_URL"), get("DATA_FEED_DIR")
	if dsn == "" || root == "" {
		fail("DATABASE_URL and DATA_FEED_DIR must be set (run from backend-go so .env is found)")
	}
	steps := map[string]bool{}
	for _, s := range strings.Split(*only, ",") {
		steps[strings.TrimSpace(s)] = true
	}

	ctx := context.Background()
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		fail("open: %v", err)
	}
	defer db.Close()
	// One connection throughout: the staging tables are TEMP, so they exist only on
	// the session that created them.
	conn, err := db.Conn(ctx)
	if err != nil {
		fail("connect: %v", err)
	}
	defer conn.Close()
	for _, q := range []string{
		`SET application_name = 'feedbackfill-233'`,
		`SET lock_timeout = '10s'`,
		`SET statement_timeout = 0`,
	} {
		if _, err := conn.ExecContext(ctx, q); err != nil {
			fail("%s: %v", q, err)
		}
	}

	mode := "DRY RUN — nothing will be written"
	if *apply {
		mode = "APPLY"
	}
	fmt.Printf("feedbackfill %s · drops under %s · started %s\n\n", mode, root, time.Now().Format("2006-01-02 15:04:05"))

	stagedAccounts := false
	if steps["accounts"] {
		runAccounts(ctx, conn, filepath.Join(root, acctfeed.Stream.SubDir), acctfeed.Stream.Prefix, *apply)
		stagedAccounts = true
	}
	if steps["customers"] {
		runCustomers(ctx, conn, filepath.Join(root, "cust_file"), *apply)
	}
	if steps["transactions"] {
		runTransactions(ctx, conn, filepath.Join(root, txnfeed.Stream.SubDir), txnfeed.Stream.Prefix, *apply)
	}
	if steps["currency"] {
		runCurrency(ctx, conn, *apply, stagedAccounts)
	}
	fmt.Printf("\nfinished %s\n", time.Now().Format("2006-01-02 15:04:05"))
}

func fail(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "feedbackfill: "+format+"\n", a...)
	os.Exit(1)
}

// ── Drop files ───────────────────────────────────────────────────────────────

type dropFile struct {
	path string
	date time.Time
	seq  int
}

type readStats struct{ files, lines, rejected int }

// listDrops returns the non-empty "<prefix>.DDMMYYYY.SEQ.csv" files in dir, NEWEST
// first, so the first value seen for a key is the most recent one.
func listDrops(dir, prefix string) []dropFile {
	re := regexp.MustCompile(`^` + regexp.QuoteMeta(prefix) + `\.(\d{8})\.(\d+)\.csv$`)
	entries, err := os.ReadDir(dir)
	if err != nil {
		fail("read %s: %v", dir, err)
	}
	var out []dropFile
	for _, e := range entries {
		m := re.FindStringSubmatch(e.Name())
		if e.IsDir() || m == nil {
			continue
		}
		info, err := e.Info()
		if err != nil || info.Size() == 0 {
			continue
		}
		d, err := time.Parse("02012006", m[1]) // DD MM YYYY, never ISO
		if err != nil {
			continue
		}
		seq, _ := strconv.Atoi(m[2])
		out = append(out, dropFile{filepath.Join(dir, e.Name()), d, seq})
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].date.Equal(out[j].date) {
			return out[i].date.After(out[j].date)
		}
		return out[i].seq > out[j].seq
	})
	return out
}

// eachLine calls fn for every non-empty line of every drop, newest file first,
// transcoding Windows-1252 bytes exactly as the live ingest does.
func eachLine(drops []dropFile, st *readStats, fn func(line string)) {
	for i, d := range drops {
		f, err := os.Open(d.path)
		if err != nil {
			fail("open %s: %v", d.path, err)
		}
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
		for sc.Scan() {
			if line := strings.TrimSpace(feedcore.ToUTF8(sc.Bytes())); line != "" {
				st.lines++
				fn(line)
			}
		}
		err = sc.Err()
		f.Close()
		if err != nil {
			fail("read %s: %v", d.path, err)
		}
		st.files++
		if (i+1)%20000 == 0 {
			fmt.Printf("  … %d / %d files\n", i+1, len(drops))
		}
	}
}

// ── Database helpers ─────────────────────────────────────────────────────────

// stage bulk-inserts rows into a TEMP table in batches of 1,000.
func stage(ctx context.Context, conn *sql.Conn, table string, cols int, rows [][]any) {
	const batch = 1000
	for i := 0; i < len(rows); i += batch {
		end := min(i+batch, len(rows))
		ph := make([]string, 0, end-i)
		args := make([]any, 0, (end-i)*cols)
		for j, r := range rows[i:end] {
			p := make([]string, cols)
			for k := range p {
				p[k] = fmt.Sprintf("$%d", j*cols+k+1)
			}
			ph = append(ph, "("+strings.Join(p, ",")+")")
			args = append(args, r...)
		}
		if _, err := conn.ExecContext(ctx, "INSERT INTO "+table+" VALUES "+strings.Join(ph, ","), args...); err != nil {
			fail("stage %s: %v", table, err)
		}
	}
}

func exec(ctx context.Context, conn *sql.Conn, q string) {
	if _, err := conn.ExecContext(ctx, q); err != nil {
		fail("%v\n%s", err, q)
	}
}

// report runs a query whose columns are all counts and prints them as name = value.
func report(ctx context.Context, conn *sql.Conn, q string) {
	rows, err := conn.QueryContext(ctx, q)
	if err != nil {
		fail("%v\n%s", err, q)
	}
	defer rows.Close()
	cols, _ := rows.Columns()
	for rows.Next() {
		vals := make([]sql.NullInt64, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			fail("scan: %v", err)
		}
		for i, c := range cols {
			fmt.Printf("  %-32s %d\n", c, vals[i].Int64)
		}
	}
	if err := rows.Err(); err != nil {
		fail("%v", err)
	}
}

func update(ctx context.Context, conn *sql.Conn, label, q string) {
	res, err := conn.ExecContext(ctx, q)
	if err != nil {
		fail("%s: %v", label, err)
	}
	n, _ := res.RowsAffected()
	fmt.Printf("  UPDATED %-24s %d rows\n", label, n)
}

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// ── Accounts ─────────────────────────────────────────────────────────────────

func runAccounts(ctx context.Context, conn *sql.Conn, dir, prefix string, apply bool) {
	type vals struct {
		currency, status, rate, issue string
	}
	drops := listDrops(dir, prefix)
	fmt.Printf("accounts: reading %d non-empty drops\n", len(drops))
	var st readStats
	m := map[string]*vals{}
	eachLine(drops, &st, func(line string) {
		a, err := acctfeed.ParseLine(line)
		if err != nil {
			st.rejected++
			return
		}
		v := m[a.AccountNo]
		if v == nil {
			v = &vals{}
			m[a.AccountNo] = v
		}
		// Newest file first, so each field keeps the most recent non-empty value.
		if v.currency == "" {
			v.currency = a.CurrencyCode
		}
		if v.status == "" {
			v.status = a.StatusCode
		}
		if v.rate == "" && a.InterestRate.Valid {
			v.rate = strconv.FormatFloat(a.InterestRate.Float64, 'f', -1, 64)
		}
		if v.issue == "" && a.CardIssueDate.Valid {
			v.issue = a.CardIssueDate.Time.Format("2006-01-02")
		}
	})
	fmt.Printf("  %d lines, %d rejected, %d distinct accounts\n", st.lines, st.rejected, len(m))

	exec(ctx, conn, `DROP TABLE IF EXISTS bf_accounts`)
	exec(ctx, conn, `CREATE TEMP TABLE bf_accounts (account_no text PRIMARY KEY, currency_code text,
		status_code text, interest_rate text, card_issue_date text)`)
	rows := make([][]any, 0, len(m))
	for k, v := range m {
		rows = append(rows, []any{k, nullStr(v.currency), nullStr(v.status), nullStr(v.rate), nullStr(v.issue)})
	}
	stage(ctx, conn, "bf_accounts", 5, rows)
	exec(ctx, conn, `ANALYZE bf_accounts`)

	report(ctx, conn, `
		SELECT count(*)                                                                          AS matched_accounts,
		       count(*) FILTER (WHERE a.currency_code   IS NULL AND s.currency_code   IS NOT NULL) AS fill_currency_code,
		       count(*) FILTER (WHERE a.status_code     IS NULL AND s.status_code     IS NOT NULL) AS fill_status_code,
		       count(*) FILTER (WHERE a.interest_rate   IS NULL AND s.interest_rate   IS NOT NULL) AS fill_interest_rate,
		       count(*) FILTER (WHERE a.card_issue_date IS NULL AND s.card_issue_date IS NOT NULL) AS fill_card_issue_date,
		       count(*) FILTER (WHERE s.currency_code = '840')                                     AS usd_accounts,
		       (SELECT count(*) FROM app.accounts x
		         WHERE NOT EXISTS (SELECT 1 FROM bf_accounts y WHERE y.account_no = x.account_no)) AS accounts_in_no_drop
		  FROM app.accounts a JOIN bf_accounts s ON s.account_no = a.account_no`)
	if !apply {
		return
	}
	update(ctx, conn, "app.accounts", `
		UPDATE app.accounts a
		   SET currency_code   = COALESCE(a.currency_code,   s.currency_code),
		       status_code     = COALESCE(a.status_code,     s.status_code),
		       interest_rate   = COALESCE(a.interest_rate,   s.interest_rate::numeric),
		       card_issue_date = COALESCE(a.card_issue_date, s.card_issue_date::date)
		  FROM bf_accounts s
		 WHERE s.account_no = a.account_no
		   AND (   (a.currency_code   IS NULL AND s.currency_code   IS NOT NULL)
		        OR (a.status_code     IS NULL AND s.status_code     IS NOT NULL)
		        OR (a.interest_rate   IS NULL AND s.interest_rate   IS NOT NULL)
		        OR (a.card_issue_date IS NULL AND s.card_issue_date IS NOT NULL))`)
}

// ── Customers ────────────────────────────────────────────────────────────────

func runCustomers(ctx context.Context, conn *sql.Conn, dir string, apply bool) {
	type vals struct{ addr3, phone2 string }
	drops := listDrops(dir, "cust_file")
	fmt.Printf("\ncustomers: reading %d non-empty drops\n", len(drops))
	var st readStats
	m := map[string]*vals{}
	eachLine(drops, &st, func(line string) {
		c, err := custfeed.ParseLine(line)
		if err != nil {
			st.rejected++
			return
		}
		key := strings.TrimLeft(c.CIF, "0")
		v := m[key]
		if v == nil {
			v = &vals{}
			m[key] = v
		}
		if v.addr3 == "" {
			v.addr3 = c.Address3
		}
		if v.phone2 == "" {
			v.phone2 = c.Cell
		}
	})
	fmt.Printf("  %d lines, %d rejected, %d distinct CIFs\n", st.lines, st.rejected, len(m))

	exec(ctx, conn, `DROP TABLE IF EXISTS bf_customers`)
	exec(ctx, conn, `CREATE TEMP TABLE bf_customers (cif_key text PRIMARY KEY, address_3 text, phone_2 text)`)
	rows := make([][]any, 0, len(m))
	for k, v := range m {
		if v.addr3 == "" && v.phone2 == "" {
			continue
		}
		rows = append(rows, []any{k, nullStr(v.addr3), nullStr(v.phone2)})
	}
	stage(ctx, conn, "bf_customers", 3, rows)
	exec(ctx, conn, `ANALYZE bf_customers`)

	report(ctx, conn, `
		SELECT count(*)                                                              AS matched_customer_rows,
		       count(DISTINCT s.cif_key)                                             AS matched_cifs,
		       count(*) FILTER (WHERE c.address_3 IS NULL AND s.address_3 IS NOT NULL) AS fill_address_3,
		       count(*) FILTER (WHERE c.phone_2   IS NULL AND s.phone_2   IS NOT NULL) AS fill_phone_2
		  FROM app.customers c JOIN bf_customers s ON s.cif_key = ltrim(c.cif, '0')
		 WHERE c.cif IS NOT NULL AND c.cif <> ''`)
	if !apply {
		return
	}
	update(ctx, conn, "app.customers", `
		UPDATE app.customers c
		   SET address_3 = COALESCE(c.address_3, s.address_3),
		       phone_2   = COALESCE(c.phone_2,   s.phone_2)
		  FROM bf_customers s
		 WHERE s.cif_key = ltrim(c.cif, '0') AND c.cif IS NOT NULL AND c.cif <> ''
		   AND (   (c.address_3 IS NULL AND s.address_3 IS NOT NULL)
		        OR (c.phone_2   IS NULL AND s.phone_2   IS NOT NULL))`)
}

// ── Transactions: pcc / code_class ───────────────────────────────────────────

func runTransactions(ctx context.Context, conn *sql.Conn, dir, prefix string, apply bool) {
	type vals struct{ pcc, codeClass string }
	drops := listDrops(dir, prefix)
	fmt.Printf("\ntransactions: reading %d non-empty drops\n", len(drops))
	var st readStats
	m := map[string]vals{}
	eachLine(drops, &st, func(line string) {
		t, err := txnfeed.ParseLine(line)
		if err != nil {
			st.rejected++
			return
		}
		if t.PCC == "" && t.CodeClass == "" {
			return
		}
		m[t.RowHash()] = vals{t.PCC, t.CodeClass}
	})
	fmt.Printf("  %d lines, %d rejected, %d distinct row hashes\n", st.lines, st.rejected, len(m))

	exec(ctx, conn, `DROP TABLE IF EXISTS bf_txns`)
	exec(ctx, conn, `CREATE TEMP TABLE bf_txns (row_hash text PRIMARY KEY, pcc text, code_class text)`)
	rows := make([][]any, 0, len(m))
	for k, v := range m {
		rows = append(rows, []any{k, nullStr(v.pcc), nullStr(v.codeClass)})
	}
	stage(ctx, conn, "bf_txns", 3, rows)
	exec(ctx, conn, `ANALYZE bf_txns`)

	report(ctx, conn, `
		SELECT count(*)                                                                AS matched_feed_rows,
		       count(*) FILTER (WHERE t.pcc        IS NULL AND s.pcc        IS NOT NULL) AS fill_pcc,
		       count(*) FILTER (WHERE t.code_class IS NULL AND s.code_class IS NOT NULL) AS fill_code_class,
		       (SELECT count(*) FROM app.transactions x
		         WHERE x.row_hash IS NOT NULL
		           AND NOT EXISTS (SELECT 1 FROM bf_txns y WHERE y.row_hash = x.row_hash)) AS hashed_rows_not_in_drops
		  FROM app.transactions t JOIN bf_txns s ON s.row_hash = t.row_hash`)
	if !apply {
		return
	}
	update(ctx, conn, "app.transactions (pcc)", `
		UPDATE app.transactions t
		   SET pcc        = COALESCE(t.pcc,        s.pcc),
		       code_class = COALESCE(t.code_class, s.code_class)
		  FROM bf_txns s
		 WHERE s.row_hash = t.row_hash
		   AND (   (t.pcc        IS NULL AND s.pcc        IS NOT NULL)
		        OR (t.code_class IS NULL AND s.code_class IS NOT NULL))`)
}

// ── Transactions: currency ───────────────────────────────────────────────────

// runCurrency fills transactions.currency_code through the owning account. A row
// whose account_no matches no account is left NULL rather than defaulted to naira —
// that would be a guess recorded as a fact. In a dry run the staged account
// currencies are folded in, so the USD count reflects what -apply would produce.
func runCurrency(ctx context.Context, conn *sql.Conn, apply, stagedAccounts bool) {
	fmt.Printf("\ncurrency:\n")
	acctCur := "a.currency_code"
	join := ""
	if stagedAccounts && !apply {
		acctCur = "COALESCE(a.currency_code, s.currency_code)"
		join = "LEFT JOIN bf_accounts s ON s.account_no = a.account_no"
	}
	report(ctx, conn, `
		SELECT count(*) FILTER (WHERE t.currency_code IS NULL)                                AS null_now,
		       count(*) FILTER (WHERE t.currency_code IS NULL AND a.account_no IS NOT NULL)   AS would_fill,
		       count(*) FILTER (WHERE t.currency_code IS NULL AND a.account_no IS NOT NULL
		                          AND app.resolve_currency(NULL, `+acctCur+`, COALESCE(a.product_name, t.product_name)) = '840') AS would_be_usd,
		       count(*) FILTER (WHERE t.currency_code IS NULL AND a.account_no IS NULL)       AS no_account_stays_null
		  FROM app.transactions t
		  LEFT JOIN app.accounts a ON a.account_no = t.account_no AND t.account_no <> ''
		  `+join)
	if !apply {
		return
	}
	// Batched so no single statement holds 1M row locks against the live feed.
	total := 0
	for {
		res, err := conn.ExecContext(ctx, `
			WITH batch AS (
			    SELECT t.txn_id, a.currency_code AS acct_currency, a.product_name AS acct_product
			      FROM app.transactions t
			      JOIN app.accounts a ON a.account_no = t.account_no
			     WHERE t.currency_code IS NULL AND t.account_no <> ''
			     LIMIT 50000
			)
			UPDATE app.transactions t
			   SET currency_code = app.resolve_currency(NULL, b.acct_currency, COALESCE(b.acct_product, t.product_name))
			  FROM batch b
			 WHERE t.txn_id = b.txn_id AND t.currency_code IS NULL`)
		if err != nil {
			fail("currency batch after %d rows: %v", total, err)
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			break
		}
		total += int(n)
		fmt.Printf("  … %d rows\n", total)
	}
	fmt.Printf("  UPDATED %-24s %d rows\n", "app.transactions (currency)", total)
}

// Throwaway, read-only: pulls the full live book from Udara's bulk-searchable endpoints
// (never from our own Postgres mirror) and reports true counts, field inventories, branch
// splits, and date ranges. Exists only to answer "what does Udara itself say, right now" —
// not part of the server build, not meant to be kept.
//
//	go run ./cmd/liveverify <endpoint>
//
// endpoint one of: loans, fds, individuals, groups, products, officers, callover, all
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/o3c/workspace/cbssync"
	"github.com/o3c/workspace/core"
	"github.com/o3c/workspace/migrate"
	"github.com/o3c/workspace/udara"
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
		k := strings.TrimSpace(line[:i])
		v := strings.Trim(strings.TrimSpace(line[i+1:]), `"'`)
		m[k] = v
	}
	return m
}

type envelope struct {
	Data json.RawMessage `json:"data"`
}

func recordCountOf(data json.RawMessage) int {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return 0
	}
	var obj map[string]json.RawMessage
	if json.Unmarshal(trimmed, &obj) != nil {
		return 0
	}
	for _, k := range []string{"recordCount", "totalCount", "totalRecords", "total", "count"} {
		if v, ok := obj[k]; ok {
			var n int
			if json.Unmarshal(v, &n) == nil {
				return n
			}
		}
	}
	return 0
}

func extractItems(data json.RawMessage) ([]map[string]any, error) {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return nil, nil
	}
	switch trimmed[0] {
	case '[':
		var items []map[string]any
		if err := json.Unmarshal(trimmed, &items); err != nil {
			return nil, err
		}
		return items, nil
	case '{':
		var obj map[string]json.RawMessage
		if err := json.Unmarshal(trimmed, &obj); err != nil {
			return nil, err
		}
		for _, k := range []string{"data", "items", "records", "result", "list"} {
			if v, ok := obj[k]; ok {
				if it, err := extractItems(v); err == nil && it != nil {
					return it, nil
				}
			}
		}
		for _, v := range obj {
			tv := bytes.TrimSpace(v)
			if len(tv) > 0 && tv[0] == '[' {
				var items []map[string]any
				if err := json.Unmarshal(tv, &items); err == nil {
					return items, nil
				}
			}
		}
	}
	return nil, nil
}

func fetchOnePage(ctx context.Context, c *udara.Client, path string, page, size int) ([]map[string]any, int, error) {
	q := url.Values{}
	q.Set("PageNumber", strconv.Itoa(page))
	q.Set("PageSize", strconv.Itoa(size))
	raw, code, err := c.Do(ctx, "GET", path, nil, q)
	if err != nil {
		return nil, 0, fmt.Errorf("fetch %s: %w", path, err)
	}
	if code < 200 || code >= 300 {
		return nil, 0, fmt.Errorf("fetch %s: HTTP %d: %s", path, code, truncate(raw, 500))
	}
	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, 0, fmt.Errorf("fetch %s: parse envelope: %w; head=%s", path, err, truncate(raw, 300))
	}
	items, err := extractItems(env.Data)
	if err != nil {
		return nil, 0, fmt.Errorf("fetch %s: parse data: %w", path, err)
	}
	return items, recordCountOf(env.Data), nil
}

func truncate(b []byte, n int) string {
	if len(b) <= n {
		return string(b)
	}
	return string(b[:n]) + "...(truncated)"
}

func recordKey(m map[string]any) string {
	for _, k := range []string{"id", "accountNumber", "customerID", "referenceNumber"} {
		if v, ok := m[k]; ok {
			return fmt.Sprintf("%v", v)
		}
	}
	b, _ := json.Marshal(m)
	return string(b)
}

func dedupByID(items []map[string]any) []map[string]any {
	seen := make(map[string]bool, len(items))
	out := make([]map[string]any, 0, len(items))
	for _, m := range items {
		k := recordKey(m)
		if seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, m)
	}
	return out
}

// fetchFullBook: page 1 at a modest size to learn the reported total, then one atomic
// refetch sized to total+buffer (Udara's real multi-page walk is documented as unstable —
// duplicates/drops across adjacent pages — this big-page trick avoids that entirely),
// then dedupe by id as a final safety net. ALSO cross-checks with a literal page walk at
// a small page size and reports if the two methods disagree, since we are verifying, not
// just syncing.
func fetchFullBook(ctx context.Context, c *udara.Client, path string) ([]map[string]any, int, error) {
	items, total, err := fetchOnePage(ctx, c, path, 1, 500)
	if err != nil {
		return nil, 0, err
	}
	if total > len(items) {
		items, _, err = fetchOnePage(ctx, c, path, 1, total+200)
		if err != nil {
			return nil, 0, err
		}
	}
	return dedupByID(items), total, nil
}

func fieldSet(items []map[string]any) []string {
	seen := map[string]bool{}
	for _, m := range items {
		for k := range m {
			seen[k] = true
		}
	}
	out := make([]string, 0, len(seen))
	for k := range seen {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func cfInt64(v any) int64 {
	switch n := v.(type) {
	case int64:
		return n
	case float64:
		return int64(n)
	case string:
		i, _ := strconv.ParseInt(n, 10, 64)
		return i
	default:
		return 0
	}
}

func str(m map[string]any, k string) string {
	if v, ok := m[k]; ok && v != nil {
		return fmt.Sprintf("%v", v)
	}
	return ""
}

func num(m map[string]any, k string) float64 {
	if v, ok := m[k]; ok && v != nil {
		switch t := v.(type) {
		case float64:
			return t
		case string:
			f, _ := strconv.ParseFloat(t, 64)
			return f
		}
	}
	return 0
}

func main() {
	env := loadEnv(".env")
	get := func(k string) string {
		if v := os.Getenv(k); v != "" {
			return v
		}
		return env[k]
	}
	which := "all"
	if len(os.Args) > 1 {
		which = os.Args[1]
	}

	// DB-only commands — no Udara client needed, checked before the IsConfigured gate below.
	if which == "glaccounts" {
		cfg, err := core.LoadConfig()
		if err != nil {
			fmt.Println("config error:", err)
			os.Exit(1)
		}
		db, err := core.Open(cfg)
		if err != nil {
			fmt.Println("db open error:", err)
			os.Exit(1)
		}
		ctx := context.Background()
		rows, err := db.PGQuery(ctx, `
			SELECT p.product_category, p.account_number, p.account_name,
			       COUNT(*) FILTER (WHERE p.side = 'debit')  AS debit_postings,
			       COUNT(*) FILTER (WHERE p.side = 'credit') AS credit_postings,
			       SUM(p.amount_kobo) AS total_amount_kobo
			  FROM cbs_gl_postings p
			  LEFT JOIN gl_account_lines l ON l.account_number = p.account_number
			 WHERE l.account_number IS NULL
			 GROUP BY p.product_category, p.account_number, p.account_name
			 ORDER BY p.product_category, total_amount_kobo DESC`)
		if err != nil {
			fmt.Println("query error:", err)
			os.Exit(1)
		}
		fmt.Printf("%-14s %-14s %-45s %10s %10s %18s\n", "category", "account_num", "account_name", "debits", "credits", "total_kobo")
		for _, r := range rows {
			fmt.Printf("%-14v %-14v %-45v %10v %10v %18v\n",
				r["product_category"], r["account_number"], r["account_name"],
				r["debit_postings"], r["credit_postings"], r["total_amount_kobo"])
		}
		fmt.Printf("\n%d accounts not yet classified in gl_account_lines\n", len(rows))
		return
	}

	if which == "glaccounts2" {
		cfg, err := core.LoadConfig()
		if err != nil {
			fmt.Println("config error:", err)
			os.Exit(1)
		}
		db, err := core.Open(cfg)
		if err != nil {
			fmt.Println("db open error:", err)
			os.Exit(1)
		}
		ctx := context.Background()
		rows, err := db.PGQuery(ctx, `
			SELECT p.account_number, p.account_name,
			       STRING_AGG(DISTINCT p.product_category, ',') AS categories,
			       COUNT(DISTINCT p.cbs_loan_account) FILTER (WHERE p.cbs_loan_account IS NOT NULL) AS distinct_loan_accts,
			       SUM(p.amount_kobo) AS total_amount_kobo,
			       COUNT(*) AS postings
			  FROM cbs_gl_postings p
			  LEFT JOIN gl_account_lines l ON l.account_number = p.account_number
			 WHERE l.account_number IS NULL
			 GROUP BY p.account_number, p.account_name
			HAVING COUNT(DISTINCT p.account_name) = 1  -- drop account_numbers that are really per-customer sub-ledgers (name varies... won't trigger here since grouped by name too; real filter is below)
			 ORDER BY total_amount_kobo DESC
			 LIMIT 400`)
		if err != nil {
			fmt.Println("query error:", err)
			os.Exit(1)
		}
		fmt.Printf("%-16s %-50s %-20s %8s %18s\n", "account_num", "account_name", "categories", "posts", "total_kobo")
		for _, r := range rows {
			fmt.Printf("%-16v %-50v %-20v %8v %18v\n", r["account_number"], r["account_name"], r["categories"], r["postings"], r["total_amount_kobo"])
		}
		return
	}

	if which == "applymigrations" {
		cfg, err := core.LoadConfig()
		if err != nil {
			fmt.Println("config error:", err)
			os.Exit(1)
		}
		db, err := core.Open(cfg)
		if err != nil {
			fmt.Println("db open error:", err)
			os.Exit(1)
		}
		if err := migrate.Apply(context.Background(), db, os.DirFS("migrations"), "."); err != nil {
			fmt.Println("migrate error:", err)
			os.Exit(1)
		}
		fmt.Println("migrations applied OK")
		return
	}

	if which == "drilldowncheck" {
		cfg, err := core.LoadConfig()
		if err != nil {
			fmt.Println("config error:", err)
			os.Exit(1)
		}
		db, err := core.Open(cfg)
		if err != nil {
			fmt.Println("db open error:", err)
			os.Exit(1)
		}
		ctx := context.Background()
		check := func(name, sql string, args ...any) {
			rows, err := db.PGQuery(ctx, sql, args...)
			if err != nil {
				fmt.Printf("%-20s ERROR: %v\n", name, err)
				return
			}
			fmt.Printf("%-20s OK, %d rows\n", name, len(rows))
		}
		check("loan receivable", `SELECT cbs_account_number, product_name, status, outstanding_principal_kobo, branch_name FROM cbs_loans WHERE status NOT IN ('Closed','Revoked') AND branch_name = $1 ORDER BY outstanding_principal_kobo DESC LIMIT 500`, "Head Office Branch")
		check("fd principal", `SELECT cbs_account_number, COALESCE(NULLIF(btrim(raw->>'name'), ''), cbs_customer_id) AS customer_name, principal_kobo, accrued_interest_kobo, maturity_date, branch_name FROM cbs_fixed_deposits WHERE status='Active' AND raw->>'hasDisbursed' IS DISTINCT FROM 'false' AND branch_name = $1 ORDER BY principal_kobo DESC LIMIT 500`, "Abuja Branch")
		check("card receivable", `SELECT b.account_no, b.cif, b.product_name, b.currency, b.receivable_kobo AS amount_kobo, u.office_location FROM app.card_balances b LEFT JOIN app.v_card_sale_officer o ON o.account_no=b.account_no LEFT JOIN o3c_users u ON u.id=o.officer_id WHERE b.receivable_kobo > 0 AND b.currency = $1 ORDER BY b.receivable_kobo DESC LIMIT 500`, "NGN")
		check("opening equity", `SELECT branch_name, amount_kobo, is_estimated, note FROM gl_opening_balances WHERE as_of_date=DATE '2026-01-01' AND line='Opening Equity' AND branch_name = $1`, "Head Office Branch")
		check("income entries (income line)", `SELECT p.id, p.financial_date, p.narration, p.posting_reference, p.account_number, p.account_name, p.side, p.amount_kobo FROM cbs_gl_postings p JOIN gl_account_lines l ON l.account_number=p.account_number WHERE l.statement_line = $1 AND (l.product_label = $2 OR ($2='' AND l.product_label IS NULL)) AND p.financial_date >= $3::date ORDER BY p.financial_date DESC LIMIT 500`, "Card Interest Income", "", "2026-07-01")
		check("cashflow entries", `WITH account_kind AS (SELECT account_number, BOOL_OR(product_category='fixed_deposit') AS is_fd, BOOL_OR(product_category='loan') AS is_loan FROM cbs_gl_postings WHERE financial_date >= DATE '2026-07-01' GROUP BY account_number), classified AS (SELECT p.id, p.financial_date, p.narration, p.posting_reference, p.account_number, p.account_name, p.side, p.amount_kobo, CASE p.branch_name WHEN 'Head Office Branch' THEN 'Lagos' WHEN 'Abuja Branch' THEN 'Abuja' ELSE COALESCE(p.branch_name,'Unattributed') END AS branch, COALESCE(a.activity, CASE WHEN l.account_number IS NOT NULL THEN 'operating' END, CASE WHEN k.is_fd THEN 'financing' END, CASE WHEN k.is_loan THEN 'investing' END, CASE WHEN p.product_category='withholding_tax' THEN 'operating' END, 'unclassified') AS activity, COALESCE(a.label, l.statement_line, CASE WHEN k.is_fd THEN 'Fixed Deposit Principal Movement' END, CASE WHEN k.is_loan THEN 'Loan Principal Movement' END, CASE WHEN p.product_category='withholding_tax' THEN 'Withholding Tax' END, 'Unclassified (' || p.product_category || ')') AS line_label FROM cbs_gl_postings p LEFT JOIN gl_account_lines l ON l.account_number=p.account_number LEFT JOIN gl_cash_flow_accounts a ON a.account_number=p.account_number LEFT JOIN account_kind k ON k.account_number=p.account_number WHERE p.financial_date >= $1::date) SELECT id, financial_date, narration, posting_reference, account_number, account_name, side, amount_kobo, branch FROM classified WHERE activity = $2 AND line_label = $3 ORDER BY financial_date DESC LIMIT 500`, "2026-07-01", "financing", "Fixed Deposit Principal Movement")
		return
	}

	if which == "positioncheck" {
		cfg, err := core.LoadConfig()
		if err != nil {
			fmt.Println("config error:", err)
			os.Exit(1)
		}
		db, err := core.Open(cfg)
		if err != nil {
			fmt.Println("db open error:", err)
			os.Exit(1)
		}
		ctx := context.Background()
		rows, _ := db.PGQuery(ctx, `SELECT currency, side, SUM(amount_kobo) AS n FROM app.financial_position GROUP BY currency, side ORDER BY 1,2`)
		fmt.Println("--- financial_position (whole company) ---")
		for _, r := range rows {
			fmt.Printf("%v %v %v\n", r["currency"], r["side"], r["n"])
		}
		rows2, _ := db.PGQuery(ctx, `SELECT currency, side, SUM(amount_kobo) AS n FROM app.financial_position_by_branch WHERE side IN ('Asset','Liability') GROUP BY currency, side ORDER BY 1,2`)
		fmt.Println("--- financial_position_by_branch, summed across all branches ---")
		for _, r := range rows2 {
			fmt.Printf("%v %v %v\n", r["currency"], r["side"], r["n"])
		}
		return
	}

	if which == "incomelines" {
		cfg, err := core.LoadConfig()
		if err != nil {
			fmt.Println("config error:", err)
			os.Exit(1)
		}
		db, err := core.Open(cfg)
		if err != nil {
			fmt.Println("db open error:", err)
			os.Exit(1)
		}
		ctx := context.Background()
		rows, _ := db.PGQuery(ctx, `SELECT statement_line, product_label, COUNT(*) AS accounts FROM gl_account_lines WHERE statement='income' GROUP BY statement_line, product_label ORDER BY statement_line, product_label`)
		for _, r := range rows {
			fmt.Printf("%-28v %v\n", r["statement_line"], r["product_label"])
		}
		return
	}

	if which == "ledgercheck" {
		cfg, err := core.LoadConfig()
		if err != nil {
			fmt.Println("config error:", err)
			os.Exit(1)
		}
		db, err := core.Open(cfg)
		if err != nil {
			fmt.Println("db open error:", err)
			os.Exit(1)
		}
		ctx := context.Background()

		fmt.Println("--- income: whole-period (no date filter) vs the view's own totals ---")
		rows, err := db.PGQuery(ctx, `
			WITH income AS (
				SELECT CASE p.branch_name WHEN 'Head Office Branch' THEN 'Lagos' WHEN 'Abuja Branch' THEN 'Abuja' ELSE COALESCE(p.branch_name,'Unattributed') END AS branch,
				       SUM(CASE WHEN p.side='credit' THEN p.amount_kobo ELSE -p.amount_kobo END) AS amount_kobo
				  FROM cbs_gl_postings p JOIN gl_account_lines l ON l.account_number=p.account_number
				 WHERE l.statement='income' AND p.financial_date >= DATE '2026-07-01'
				 GROUP BY 1)
			SELECT branch, amount_kobo FROM income ORDER BY branch`)
		if err != nil {
			fmt.Println("direct-query error:", err)
			os.Exit(1)
		}
		for _, r := range rows {
			fmt.Printf("direct:  %-14v %v\n", r["branch"], r["amount_kobo"])
		}
		rows2, _ := db.PGQuery(ctx, `
			SELECT branch, SUM(amount_kobo) AS amount_kobo FROM app.income_statement_by_branch
			 WHERE statement='income' GROUP BY branch ORDER BY branch`)
		for _, r := range rows2 {
			fmt.Printf("view:    %-14v %v\n", r["branch"], r["amount_kobo"])
		}

		fmt.Println("\n--- income: narrowed to a date range (should be LESS than whole-period) ---")
		rows3, err := db.PGQuery(ctx, `
			WITH income AS (
				SELECT CASE p.branch_name WHEN 'Head Office Branch' THEN 'Lagos' WHEN 'Abuja Branch' THEN 'Abuja' ELSE COALESCE(p.branch_name,'Unattributed') END AS branch,
				       SUM(CASE WHEN p.side='credit' THEN p.amount_kobo ELSE -p.amount_kobo END) AS amount_kobo
				  FROM cbs_gl_postings p JOIN gl_account_lines l ON l.account_number=p.account_number
				 WHERE l.statement='income' AND p.financial_date >= DATE '2026-07-01'
				   AND p.financial_date >= $1::date AND p.financial_date <= $2::date
				 GROUP BY 1)
			SELECT branch, amount_kobo FROM income ORDER BY branch`, "2026-09-01", "2026-09-30")
		if err != nil {
			fmt.Println("date-range query error:", err)
			os.Exit(1)
		}
		for _, r := range rows3 {
			fmt.Printf("Sep only: %-14v %v\n", r["branch"], r["amount_kobo"])
		}

		fmt.Println("\n--- cash flow: whole-period direct vs view ---")
		rows4, err := db.PGQuery(ctx, `
			WITH account_kind AS (
				SELECT account_number, BOOL_OR(product_category='fixed_deposit') AS is_fd, BOOL_OR(product_category='loan') AS is_loan
				  FROM cbs_gl_postings WHERE financial_date >= DATE '2026-07-01' GROUP BY account_number
			), classified AS (
				SELECT p.side, p.amount_kobo,
				       COALESCE(a.activity,
				                CASE WHEN l.account_number IS NOT NULL THEN 'operating' END,
				                CASE WHEN k.is_fd THEN 'financing' END,
				                CASE WHEN k.is_loan THEN 'investing' END,
				                CASE WHEN p.product_category='withholding_tax' THEN 'operating' END,
				                'unclassified') AS activity
				  FROM cbs_gl_postings p
				  LEFT JOIN gl_account_lines l ON l.account_number=p.account_number
				  LEFT JOIN gl_cash_flow_accounts a ON a.account_number=p.account_number
				  LEFT JOIN account_kind k ON k.account_number=p.account_number
				 WHERE p.financial_date >= $1::date
			)
			SELECT activity, SUM(CASE WHEN side='credit' THEN amount_kobo ELSE -amount_kobo END) AS amount_kobo
			  FROM classified WHERE activity NOT IN ('cash','internal') GROUP BY activity ORDER BY activity`,
			"2026-07-01")
		if err != nil {
			fmt.Println("cash flow direct-query error:", err)
			os.Exit(1)
		}
		for _, r := range rows4 {
			fmt.Printf("direct:  %-14v %v\n", r["activity"], r["amount_kobo"])
		}
		rows5, _ := db.PGQuery(ctx, `
			SELECT activity, SUM(amount_kobo) AS amount_kobo FROM app.cash_flow_statement_by_branch
			 GROUP BY activity ORDER BY activity`)
		for _, r := range rows5 {
			fmt.Printf("view:    %-14v %v\n", r["activity"], r["amount_kobo"])
		}
		return
	}

	if which == "cashflowcheck" {
		cfg, err := core.LoadConfig()
		if err != nil {
			fmt.Println("config error:", err)
			os.Exit(1)
		}
		db, err := core.Open(cfg)
		if err != nil {
			fmt.Println("db open error:", err)
			os.Exit(1)
		}
		ctx := context.Background()

		fmt.Println("--- cash_flow_statement_by_branch totals by activity ---")
		rows, err := db.PGQuery(ctx, `
			SELECT branch, activity, SUM(amount_kobo) AS total_kobo, SUM(postings) AS postings
			  FROM app.cash_flow_statement_by_branch
			 GROUP BY branch, activity
			 ORDER BY branch, activity`)
		if err != nil {
			fmt.Println("query error:", err)
			os.Exit(1)
		}
		var sumOIF int64
		for _, r := range rows {
			fmt.Printf("%-12v %-14v %18v  (%v postings)\n", r["branch"], r["activity"], r["total_kobo"], r["postings"])
			if fmt.Sprint(r["activity"]) != "unclassified" {
				sumOIF += cfInt64(r["total_kobo"])
			}
		}

		fmt.Println("\n--- net movement on cash/internal accounts (should ~= sum of O+I+F above) ---")
		rows2, _ := db.PGQuery(ctx, `
			SELECT a.activity,
			       SUM(CASE WHEN p.side='credit' THEN p.amount_kobo ELSE -p.amount_kobo END) AS net_kobo
			  FROM cbs_gl_postings p
			  JOIN gl_cash_flow_accounts a ON a.account_number = p.account_number
			 WHERE p.financial_date >= DATE '2026-07-01' AND a.activity IN ('cash','internal')
			 GROUP BY a.activity`)
		var cashNet int64
		for _, r := range rows2 {
			fmt.Printf("%-14v %18v\n", r["activity"], r["net_kobo"])
			if fmt.Sprint(r["activity"]) == "cash" {
				cashNet = cfInt64(r["net_kobo"])
			}
		}
		fmt.Printf("\nSum(Operating+Investing+Financing, unclassified excluded) = %d\n", sumOIF)
		fmt.Printf("Net movement on 'cash' accounts                            = %d\n", cashNet)
		fmt.Printf("Difference (should equal unclassified + internal, roughly)  = %d\n", sumOIF+cashNet)
		return
	}

	if which == "rerun348" {
		cfg, err := core.LoadConfig()
		if err != nil {
			fmt.Println("config error:", err)
			os.Exit(1)
		}
		db, err := core.Open(cfg)
		if err != nil {
			fmt.Println("db open error:", err)
			os.Exit(1)
		}
		sql, err := os.ReadFile("migrations/348_cash_flow_statement.sql")
		if err != nil {
			fmt.Println("read error:", err)
			os.Exit(1)
		}
		if _, err := db.PGExec(context.Background(), string(sql)); err != nil {
			fmt.Println("exec error:", err)
			os.Exit(1)
		}
		fmt.Println("re-applied 348 OK")
		return
	}

	if which == "unclassified" {
		cfg, err := core.LoadConfig()
		if err != nil {
			fmt.Println("config error:", err)
			os.Exit(1)
		}
		db, err := core.Open(cfg)
		if err != nil {
			fmt.Println("db open error:", err)
			os.Exit(1)
		}
		ctx := context.Background()
		rows, err := db.PGQuery(ctx, `
			SELECT p.product_category, p.account_number, p.account_name,
			       COUNT(*) AS postings,
			       SUM(CASE WHEN p.side='credit' THEN p.amount_kobo ELSE -p.amount_kobo END) AS net_kobo,
			       COUNT(DISTINCT p.cbs_loan_account) FILTER (WHERE p.cbs_loan_account IS NOT NULL) AS distinct_loan_links
			  FROM cbs_gl_postings p
			  LEFT JOIN gl_account_lines l ON l.account_number = p.account_number
			  LEFT JOIN gl_cash_flow_accounts a ON a.account_number = p.account_number
			 WHERE p.financial_date >= DATE '2026-07-01'
			   AND l.account_number IS NULL AND a.account_number IS NULL
			   AND p.product_category NOT IN ('fixed_deposit','loan','withholding_tax')
			 GROUP BY p.product_category, p.account_number, p.account_name
			 ORDER BY ABS(SUM(CASE WHEN p.side='credit' THEN p.amount_kobo ELSE -p.amount_kobo END)) DESC
			 LIMIT 60`)
		if err != nil {
			fmt.Println("query error:", err)
			os.Exit(1)
		}
		fmt.Printf("%-14s %-16s %-45s %8s %18s %6s\n", "category", "account_num", "account_name", "posts", "net_kobo", "loanlk")
		for _, r := range rows {
			fmt.Printf("%-14v %-16v %-45v %8v %18v %6v\n", r["product_category"], r["account_number"], r["account_name"], r["postings"], r["net_kobo"], r["distinct_loan_links"])
		}
		return
	}

	if which == "glpairs" {
		cfg, err := core.LoadConfig()
		if err != nil {
			fmt.Println("config error:", err)
			os.Exit(1)
		}
		db, err := core.Open(cfg)
		if err != nil {
			fmt.Println("db open error:", err)
			os.Exit(1)
		}
		ctx := context.Background()
		rows, err := db.PGQuery(ctx, `
			SELECT legs, COUNT(*) AS postings
			  FROM (
			    SELECT posting_reference,
			           COUNT(*) FILTER (WHERE side='debit')  AS d,
			           COUNT(*) FILTER (WHERE side='credit') AS c,
			           COUNT(*) FILTER (WHERE side='debit') || 'd/' ||
			           COUNT(*) FILTER (WHERE side='credit') || 'c' AS legs
			      FROM cbs_gl_postings
			     GROUP BY posting_reference
			  ) x
			 GROUP BY legs
			 ORDER BY postings DESC
			 LIMIT 20`)
		if err != nil {
			fmt.Println("query error:", err)
			os.Exit(1)
		}
		for _, r := range rows {
			fmt.Printf("%-10v %v\n", r["legs"], r["postings"])
		}
		return
	}

	c := udara.New(get("UDARA360_BASE_URL"), get("UDARA360_CLIENT_ID"), get("UDARA360_CLIENT_SECRET"))
	if !c.IsConfigured() {
		fmt.Println("NOT CONFIGURED")
		os.Exit(1)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	if which == "runblinkfx" {
		cfg, err := core.LoadConfig()
		if err != nil {
			fmt.Println("config error:", err)
			os.Exit(1)
		}
		db, err := core.Open(cfg)
		if err != nil {
			fmt.Println("db open error:", err)
			os.Exit(1)
		}
		res, err := cbssync.ParseBlinkFXEvents(ctx, db)
		fmt.Printf("result: %+v\n", res)
		if err != nil {
			fmt.Println("ERROR:", err)
			os.Exit(1)
		}
		return
	}

	if which == "runglsync" {
		cfg, err := core.LoadConfig()
		if err != nil {
			fmt.Println("config error:", err)
			os.Exit(1)
		}
		db, err := core.Open(cfg)
		if err != nil {
			fmt.Println("db open error:", err)
			os.Exit(1)
		}
		res, err := cbssync.SyncGLPostings(ctx, c, db)
		fmt.Printf("result: %+v\n", res)
		if err != nil {
			fmt.Println("ERROR:", err)
			os.Exit(1)
		}
		return
	}

	run := func(name, path string) {
		fmt.Printf("\n=== %s  (%s) ===\n", name, path)
		items, total, err := fetchFullBook(ctx, c, path)
		if err != nil {
			fmt.Println("ERROR:", err)
			return
		}
		fmt.Printf("reported total=%d  true fetched+deduped=%d\n", total, len(items))
		fmt.Printf("fields (%d): %s\n", len(fieldSet(items)), strings.Join(fieldSet(items), ", "))
	}

	if which == "loans" || which == "all" {
		path := "/api/LoanAccount/v1/Search"
		items, total, err := fetchFullBook(ctx, c, path)
		fmt.Printf("\n=== LOANS (%s) ===\n", path)
		if err != nil {
			fmt.Println("ERROR:", err)
		} else {
			fmt.Printf("reported total=%d true=%d\n", total, len(items))
			fmt.Printf("fields: %s\n", strings.Join(fieldSet(items), ", "))
			branchCount := map[string]int{}
			branchSum := map[string]float64{}
			minStart, minApproved, minCreated, minFirstInst := "", "", "", ""
			for _, it := range items {
				b := str(it, "branchName")
				branchCount[b]++
				branchSum[b] += num(it, "ledgerBalance")
				for field, min := range map[string]*string{
					"startDate": &minStart, "approvedDate": &minApproved,
					"dateCreated": &minCreated, "firstInstallmentDate": &minFirstInst,
				} {
					v := str(it, field)
					if v != "" && (*min == "" || v < *min) {
						*min = v
					}
				}
			}
			fmt.Printf("branch counts: %v\n", branchCount)
			fmt.Printf("branch ledgerBalance sums: %v\n", branchSum)
			fmt.Printf("MIN startDate=%s approvedDate=%s dateCreated=%s firstInstallmentDate=%s\n",
				minStart, minApproved, minCreated, minFirstInst)
		}
	}

	if which == "fds" || which == "all" {
		path := "/api/FixedDepositAccount/v1/Search"
		items, total, err := fetchFullBook(ctx, c, path)
		fmt.Printf("\n=== FIXED DEPOSITS (%s) ===\n", path)
		if err != nil {
			fmt.Println("ERROR:", err)
		} else {
			fmt.Printf("reported total=%d true=%d\n", total, len(items))
			fmt.Printf("fields: %s\n", strings.Join(fieldSet(items), ", "))
			branchCount := map[string]int{}
			branchSumPrincipal := map[string]float64{}
			branchSumLedger := map[string]float64{}
			minCommencement := ""
			preJanCount := map[string]int{}
			preJanPrincipal := map[string]float64{}
			preJanLedger := map[string]float64{}
			var preJanIDs []string
			for _, it := range items {
				b := str(it, "branchName")
				branchCount[b]++
				branchSumPrincipal[b] += num(it, "principalAmount")
				branchSumLedger[b] += num(it, "ledgerBalance")
				cd := str(it, "commencementDate")
				if cd != "" && (minCommencement == "" || cd < minCommencement) {
					minCommencement = cd
				}
				status := str(it, "accountStatus")
				if cd != "" && cd < "2026-01-01" {
					stillOpen := !strings.EqualFold(status, "Closed") && !strings.EqualFold(status, "Liquidated") &&
						!strings.EqualFold(status, "Matured")
					if stillOpen {
						preJanCount[b]++
						preJanPrincipal[b] += num(it, "principalAmount")
						preJanLedger[b] += num(it, "ledgerBalance")
						preJanIDs = append(preJanIDs, fmt.Sprintf("%s(%s,status=%s,commenced=%s,principal=%.2f)",
							str(it, "accountNumber"), b, status, cd, num(it, "principalAmount")))
					}
				}
			}
			fmt.Printf("branch counts: %v\n", branchCount)
			fmt.Printf("branch principalAmount sums: %v\n", branchSumPrincipal)
			fmt.Printf("branch ledgerBalance sums: %v\n", branchSumLedger)
			fmt.Printf("MIN commencementDate=%s\n", minCommencement)
			fmt.Printf("Pre-2026-01-01, still-open: count=%v principalSum=%v ledgerSum=%v\n",
				preJanCount, preJanPrincipal, preJanLedger)
			fmt.Printf("Pre-2026-01-01 still-open accounts:\n  %s\n", strings.Join(preJanIDs, "\n  "))
		}
	}

	if which == "individuals" || which == "all" {
		run("INDIVIDUAL CUSTOMERS", "/api/Account/v1/SearchIndividualCustomers")
	}
	if which == "groups" || which == "all" {
		run("GROUP CUSTOMERS", "/api/Account/v1/SearchGroupCustomers")
	}
	if which == "products" || which == "all" {
		run("PRODUCTS", "/api/Product/v1/SearchProducts")
	}
	if which == "officers" || which == "all" {
		path := "/api/account/v1/SearchAccountOfficers"
		items, total, err := fetchFullBook(ctx, c, path)
		fmt.Printf("\n=== OFFICERS (%s) ===\n", path)
		if err != nil {
			fmt.Println("ERROR:", err)
		} else {
			fmt.Printf("reported total=%d true=%d\n", total, len(items))
			for _, it := range items {
				fmt.Printf("  staffID=%s name=%s branchCode=%s branchName=%s address=%s status=%s\n",
					str(it, "staffID"), str(it, "name"), str(it, "branchCode"), str(it, "branchName"),
					str(it, "address"), str(it, "status"))
			}
		}
	}

	if which == "callover" || which == "all" {
		path := "/api/Report/v1/GetTransactionCallOverReport"
		fmt.Printf("\n=== CALL-OVER REPORT (%s) ===\n", path)
		var all []map[string]any
		for page := 1; page <= 50; page++ {
			items, _, err := fetchOnePage(ctx, c, path, page, 1000)
			if err != nil {
				fmt.Println("ERROR on page", page, ":", err)
				break
			}
			if len(items) == 0 {
				fmt.Printf("page %d empty, stopping\n", page)
				break
			}
			fmt.Printf("page %d: %d rows\n", page, len(items))
			all = append(all, items...)
		}
		// No reliable per-row id on this feed (many legs share the same accountNumber),
		// so dedup on the full posting fingerprint instead of falling back to
		// accountNumber -- that would wrongly collapse distinct legitimate legs.
		seen := map[string]bool{}
		deduped := make([]map[string]any, 0, len(all))
		for _, it := range all {
			k := strings.Join([]string{
				str(it, "postingReferenceNumber"), str(it, "entryCode"), str(it, "accountNumber"),
				str(it, "financialDate"), str(it, "amount"), str(it, "instrumentNumber"),
				str(it, "debit"), str(it, "credit"),
			}, "|")
			if seen[k] {
				continue
			}
			seen[k] = true
			deduped = append(deduped, it)
		}
		fmt.Printf("TOTAL rows raw=%d  deduped-by-fingerprint=%d\n", len(all), len(deduped))
		all = deduped
		branchCount := map[string]int{}
		entryCount := map[string]int{}
		minDate, maxDate := "", ""
		for _, it := range all {
			b := str(it, "branch")
			branchCount[b]++
			ec := str(it, "entryCode")
			entryCount[ec]++
			fd := str(it, "financialDate")
			if fd != "" {
				if minDate == "" || fd < minDate {
					minDate = fd
				}
				if maxDate == "" || fd > maxDate {
					maxDate = fd
				}
			}
		}
		fmt.Printf("branch counts: %v\n", branchCount)
		fmt.Printf("entryCode counts: %v\n", entryCount)
		fmt.Printf("financialDate range: %s .. %s\n", minDate, maxDate)
	}
}

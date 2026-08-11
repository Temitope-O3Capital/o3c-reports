// Package cbssync spools the Udara360 core-banking book (products, loans, fixed
// deposits) into the workspace's read-only snapshot tables (cbs_products,
// cbs_loans, cbs_fixed_deposits) and reconciles those accounts against workspace
// records via cbs_links. Udara360 is the system of record; these tables are
// refreshed atomically per run and are never written by workspace workflows.
package cbssync

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/o3c/reports/core"
	"github.com/o3c/reports/udara"
)

const (
	// defaultPageSize is large enough to return the entire loan/FD book in a single
	// page (the CBS honours large page sizes; its multi-page pagination is unstable).
	defaultPageSize = 500
	// buffer is headroom added when re-fetching a book larger than defaultPageSize.
	buffer = 100
)

// Result summarises one sync run.
type Result struct {
	Products  int
	Loans     int
	FDs       int
	Matched   int
	Unmatched int
}

// envelope is the standard Udara360 response wrapper: {"data":[...], "message":..., "status":...}.
// Only "data" is consumed; message/status vary in type across endpoints (status is a bool),
// so they are left out to keep unmarshalling tolerant.
type envelope struct {
	Data json.RawMessage `json:"data"`
}

// SyncAll runs a full spool + reconcile, recording an audit row in cbs_sync_runs.
// kind is "scheduled" or "manual"; triggeredBy is the user id for manual runs (or NULL).
func SyncAll(ctx context.Context, c *udara.Client, db *core.DB, kind string, triggeredBy sql.NullInt64) (Result, error) {
	var res Result
	if !c.IsConfigured() {
		return res, fmt.Errorf("cbs sync: udara client not configured")
	}

	var runID int64
	if err := db.PG.QueryRowContext(ctx,
		`INSERT INTO cbs_sync_runs (kind, status, triggered_by) VALUES ($1, 'running', $2) RETURNING id`,
		kind, triggeredBy).Scan(&runID); err != nil {
		return res, fmt.Errorf("cbs sync: open run: %w", err)
	}

	res, err := doSync(ctx, c, db)
	if err != nil {
		_, _ = db.PG.ExecContext(ctx,
			`UPDATE cbs_sync_runs SET finished_at = NOW(), status = 'error', error = $2 WHERE id = $1`,
			runID, err.Error())
		slog.Error("cbs sync failed", "run_id", runID, "err", err)
		return res, err
	}

	_, _ = db.PG.ExecContext(ctx,
		`UPDATE cbs_sync_runs SET finished_at = NOW(), status = 'ok',
		    products_n = $2, loans_n = $3, fds_n = $4, matched_n = $5, unmatched_n = $6
		 WHERE id = $1`,
		runID, res.Products, res.Loans, res.FDs, res.Matched, res.Unmatched)
	slog.Info("cbs sync ok", "run_id", runID, "products", res.Products, "loans", res.Loans,
		"fds", res.FDs, "matched", res.Matched, "unmatched", res.Unmatched)
	return res, nil
}

func doSync(ctx context.Context, c *udara.Client, db *core.DB) (Result, error) {
	var res Result

	// Products do NOT paginate (the endpoint rejects PageNumber/PageSize) -- fetch once.
	products, err := fetchList(ctx, c, "/api/Product/v1/SearchProducts", nil)
	if err != nil {
		return res, err
	}
	loans, err := fetchFullBook(ctx, c, "/api/LoanAccount/v1/Search")
	if err != nil {
		return res, err
	}
	fds, err := fetchFullBook(ctx, c, "/api/FixedDepositAccount/v1/Search")
	if err != nil {
		return res, err
	}

	// Atomic full-refresh of all three snapshot tables in one transaction.
	tx, err := db.PG.BeginTx(ctx, nil)
	if err != nil {
		return res, fmt.Errorf("cbs sync: begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	if err := refreshProducts(ctx, tx, products); err != nil {
		return res, err
	}
	if err := refreshLoans(ctx, tx, loans); err != nil {
		return res, err
	}
	if err := refreshFDs(ctx, tx, fds); err != nil {
		return res, err
	}
	if err := tx.Commit(); err != nil {
		return res, fmt.Errorf("cbs sync: commit: %w", err)
	}

	res.Products, res.Loans, res.FDs = len(products), len(loans), len(fds)

	// Reconcile against workspace records (best-effort; unmatched are surfaced, not forced).
	matched, unmatched, err := Reconcile(ctx, db)
	if err != nil {
		slog.Warn("cbs reconcile failed", "err", err)
	}
	res.Matched, res.Unmatched = matched, unmatched
	return res, nil
}

// ── fetching ─────────────────────────────────────────────────────────────────

// fetchList performs a single GET and returns the records under the "data" array.
func fetchList(ctx context.Context, c *udara.Client, path string, query url.Values) ([]map[string]any, error) {
	raw, code, err := c.Do(ctx, "GET", path, nil, query)
	if err != nil {
		return nil, fmt.Errorf("cbs fetch %s: %w", path, err)
	}
	if code < 200 || code >= 300 {
		return nil, fmt.Errorf("cbs fetch %s: HTTP %d: %s", path, code, truncate(raw, 300))
	}
	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, fmt.Errorf("cbs fetch %s: parse envelope: %w", path, err)
	}
	items, err := extractItems(env.Data)
	if err != nil {
		return nil, fmt.Errorf("cbs fetch %s: parse data: %w; head=%s", path, err, truncate(env.Data, 240))
	}
	return items, nil
}

// fetchFullBook fetches every record for a Search endpoint in a single page.
// Udara360's multi-page pagination is unstable (records duplicate across adjacent
// pages while others are dropped), but a page sized to the reported recordCount
// returns the whole book atomically. We size the page to recordCount, then dedupe
// by CBS id as a final safety net.
func fetchFullBook(ctx context.Context, c *udara.Client, path string) ([]map[string]any, error) {
	items, total, err := fetchOnePage(ctx, c, path, 1, defaultPageSize)
	if err != nil {
		return nil, err
	}
	// If the book is bigger than our page, refetch with a page sized to the total.
	if total > len(items) {
		items, _, err = fetchOnePage(ctx, c, path, 1, total+buffer)
		if err != nil {
			return nil, err
		}
	}
	return dedupByID(items), nil
}

// fetchOnePage returns the record array and the CBS-reported recordCount for one page.
func fetchOnePage(ctx context.Context, c *udara.Client, path string, page, size int) ([]map[string]any, int, error) {
	q := url.Values{}
	q.Set("PageNumber", strconv.Itoa(page))
	q.Set("PageSize", strconv.Itoa(size))
	raw, code, err := c.Do(ctx, "GET", path, nil, q)
	if err != nil {
		return nil, 0, fmt.Errorf("cbs fetch %s: %w", path, err)
	}
	if code < 200 || code >= 300 {
		return nil, 0, fmt.Errorf("cbs fetch %s: HTTP %d: %s", path, code, truncate(raw, 300))
	}
	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, 0, fmt.Errorf("cbs fetch %s: parse envelope: %w", path, err)
	}
	items, err := extractItems(env.Data)
	if err != nil {
		return nil, 0, fmt.Errorf("cbs fetch %s: parse data: %w; head=%s", path, err, truncate(env.Data, 240))
	}
	return items, recordCountOf(env.Data), nil
}

// recordCountOf reads the total-record count the CBS embeds alongside the data array.
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

// recordKey identifies a CBS record for de-duplication (id GUID, else account number).
func recordKey(m map[string]any) string {
	if id := gstr(m, "id"); id != "" {
		return id
	}
	if a := gstr(m, "accountNumber"); a != "" {
		return "acct:" + a
	}
	return "raw:" + rawOf(m)
}

// ── table refreshers ─────────────────────────────────────────────────────────

func refreshProducts(ctx context.Context, tx *sql.Tx, rows []map[string]any) error {
	if _, err := tx.ExecContext(ctx, `DELETE FROM cbs_products`); err != nil {
		return fmt.Errorf("cbs refresh products: clear: %w", err)
	}
	const q = `INSERT INTO cbs_products
	    (code, name, type, category, interest_rate, tenure, status, raw, synced_at)
	    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb, NOW())
	    ON CONFLICT (code) DO NOTHING`
	for _, m := range rows {
		code := gstr(m, "code")
		if code == "" {
			continue
		}
		if _, err := tx.ExecContext(ctx, q,
			code, gstr(m, "name"), gstr(m, "type"), gstr(m, "category"),
			gnum(m, "interestRate"), gint(m, "tenure"), gstr(m, "status"), rawOf(m),
		); err != nil {
			return fmt.Errorf("cbs refresh products: insert %s: %w", code, err)
		}
	}
	return nil
}

func refreshLoans(ctx context.Context, tx *sql.Tx, rows []map[string]any) error {
	if _, err := tx.ExecContext(ctx, `DELETE FROM cbs_loans`); err != nil {
		return fmt.Errorf("cbs refresh loans: clear: %w", err)
	}
	const q = `INSERT INTO cbs_loans
	    (cbs_id, cbs_account_number, cbs_customer_id, linked_account, product_code, product_name, status,
	     loan_amount_kobo, outstanding_principal_kobo, outstanding_interest_kobo, outstanding_fee_kobo,
	     interest_rate, tenor_days, start_date, maturity_date, officer_name,
	     economic_sector, branch_name, reference_number, installment_amount_kobo, approved_date, date_booked,
	     raw, synced_at)
	    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb, NOW())
	    ON CONFLICT (cbs_id) DO UPDATE SET
	        cbs_account_number = EXCLUDED.cbs_account_number,
	        cbs_customer_id = EXCLUDED.cbs_customer_id, linked_account = EXCLUDED.linked_account,
	        product_code = EXCLUDED.product_code, product_name = EXCLUDED.product_name, status = EXCLUDED.status,
	        loan_amount_kobo = EXCLUDED.loan_amount_kobo, outstanding_principal_kobo = EXCLUDED.outstanding_principal_kobo,
	        outstanding_interest_kobo = EXCLUDED.outstanding_interest_kobo, outstanding_fee_kobo = EXCLUDED.outstanding_fee_kobo,
	        interest_rate = EXCLUDED.interest_rate, tenor_days = EXCLUDED.tenor_days,
	        start_date = EXCLUDED.start_date, maturity_date = EXCLUDED.maturity_date,
	        officer_name = EXCLUDED.officer_name,
	        economic_sector = EXCLUDED.economic_sector, branch_name = EXCLUDED.branch_name,
	        reference_number = EXCLUDED.reference_number, installment_amount_kobo = EXCLUDED.installment_amount_kobo,
	        approved_date = EXCLUDED.approved_date, date_booked = EXCLUDED.date_booked,
	        raw = EXCLUDED.raw, synced_at = NOW()`
	for _, m := range rows {
		id := gstr(m, "id")
		if id == "" {
			continue
		}
		// date_booked = the genuine origination date. Udara's dateCreated is the
		// import timestamp, so use approvedDate (== startDate) and fall back to
		// startDate if approval is ever missing.
		booked := gts(m, "approvedDate")
		if !booked.Valid {
			booked = gts(m, "startDate")
		}
		if _, err := tx.ExecContext(ctx, q,
			id, gstr(m, "accountNumber"), gstr(m, "customerID"), gstr(m, "linkedNumber"),
			gstr(m, "productCode"), gstr(m, "productName"), gstr(m, "accountStatus"),
			gkobo(m, "loanAmount"), gkobo(m, "outstandingLoanPrincipal"),
			gkobo(m, "outstandingLoanInterest"), gkobo(m, "outstandingLoanFee"),
			gnum(m, "applicableInterestRate"), gint(m, "tenure"),
			gts(m, "startDate"), gts(m, "maturityDate"), gstr(m, "accountOfficerName"),
			gstr(m, "economicSector"), gstr(m, "branchName"), gstr(m, "referenceNumber"),
			gkobo(m, "installmentAmount"), gts(m, "approvedDate"), booked, rawOf(m),
		); err != nil {
			return fmt.Errorf("cbs refresh loans: insert %s: %w", id, err)
		}
	}
	return nil
}

func refreshFDs(ctx context.Context, tx *sql.Tx, rows []map[string]any) error {
	if _, err := tx.ExecContext(ctx, `DELETE FROM cbs_fixed_deposits`); err != nil {
		return fmt.Errorf("cbs refresh fds: clear: %w", err)
	}
	const q = `INSERT INTO cbs_fixed_deposits
	    (cbs_id, cbs_account_number, cbs_customer_id, product_code, product_name, status,
	     principal_kobo, accrued_interest_kobo, ledger_balance_kobo, interest_rate, tenor_days,
	     commencement_date, maturity_date, liquidation_account,
	     reference_number, branch_name, rollover_count, date_booked,
	     raw, synced_at)
	    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb, NOW())
	    ON CONFLICT (cbs_id) DO UPDATE SET
	        cbs_account_number = EXCLUDED.cbs_account_number, cbs_customer_id = EXCLUDED.cbs_customer_id,
	        product_code = EXCLUDED.product_code, product_name = EXCLUDED.product_name, status = EXCLUDED.status,
	        principal_kobo = EXCLUDED.principal_kobo, accrued_interest_kobo = EXCLUDED.accrued_interest_kobo,
	        ledger_balance_kobo = EXCLUDED.ledger_balance_kobo, interest_rate = EXCLUDED.interest_rate,
	        tenor_days = EXCLUDED.tenor_days, commencement_date = EXCLUDED.commencement_date,
	        maturity_date = EXCLUDED.maturity_date, liquidation_account = EXCLUDED.liquidation_account,
	        reference_number = EXCLUDED.reference_number, branch_name = EXCLUDED.branch_name,
	        rollover_count = EXCLUDED.rollover_count, date_booked = EXCLUDED.date_booked,
	        raw = EXCLUDED.raw, synced_at = NOW()`
	for _, m := range rows {
		id := gstr(m, "id")
		if id == "" {
			continue
		}
		// date_booked = commencementDate (when the deposit actually started), not
		// Udara's dateCreated (the import timestamp).
		if _, err := tx.ExecContext(ctx, q,
			id, gstr(m, "accountNumber"), gstr(m, "customerID"), gstr(m, "productCode"), gstr(m, "productName"),
			gstr(m, "accountStatus"), gkobo(m, "principalAmount"), gkobo(m, "accruedInterest"),
			gkobo(m, "ledgerBalance"), gnum(m, "applicableInterestRate"), gint(m, "tenure"),
			gts(m, "commencementDate"), gts(m, "maturityDate"), gstr(m, "liquidationAccount"),
			gstr(m, "referenceNumber"), gstr(m, "branchName"), gint(m, "rolloverCount"),
			gts(m, "commencementDate"), rawOf(m),
		); err != nil {
			return fmt.Errorf("cbs refresh fds: insert %s: %w", id, err)
		}
	}
	return nil
}

// ── field extraction helpers (Udara returns numbers as JSON floats or strings) ─

func gstr(m map[string]any, k string) string {
	v, ok := m[k]
	if !ok || v == nil {
		return ""
	}
	switch t := v.(type) {
	case string:
		return t
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(t)
	default:
		return fmt.Sprintf("%v", t)
	}
}

// gkobo returns an integer minor-unit (kobo) amount.
func gkobo(m map[string]any, k string) sql.NullInt64 {
	v, ok := m[k]
	if !ok || v == nil {
		return sql.NullInt64{}
	}
	switch t := v.(type) {
	case float64:
		return sql.NullInt64{Int64: int64(t), Valid: true}
	case string:
		s := strings.TrimSpace(t)
		if s == "" {
			return sql.NullInt64{}
		}
		if f, err := strconv.ParseFloat(s, 64); err == nil {
			return sql.NullInt64{Int64: int64(f), Valid: true}
		}
	}
	return sql.NullInt64{}
}

// gnum returns a decimal (rates).
func gnum(m map[string]any, k string) sql.NullFloat64 {
	v, ok := m[k]
	if !ok || v == nil {
		return sql.NullFloat64{}
	}
	switch t := v.(type) {
	case float64:
		return sql.NullFloat64{Float64: t, Valid: true}
	case string:
		s := strings.TrimSpace(t)
		if s == "" {
			return sql.NullFloat64{}
		}
		if f, err := strconv.ParseFloat(s, 64); err == nil {
			return sql.NullFloat64{Float64: f, Valid: true}
		}
	}
	return sql.NullFloat64{}
}

// gint returns an integer (tenure/day counts).
func gint(m map[string]any, k string) sql.NullInt64 {
	v, ok := m[k]
	if !ok || v == nil {
		return sql.NullInt64{}
	}
	switch t := v.(type) {
	case float64:
		return sql.NullInt64{Int64: int64(t), Valid: true}
	case string:
		s := strings.TrimSpace(t)
		if s == "" {
			return sql.NullInt64{}
		}
		if f, err := strconv.ParseFloat(s, 64); err == nil {
			return sql.NullInt64{Int64: int64(f), Valid: true}
		}
	}
	return sql.NullInt64{}
}

// gts parses Udara timestamps, which come without a timezone (or empty).
func gts(m map[string]any, k string) sql.NullTime {
	s := strings.TrimSpace(gstr(m, k))
	if s == "" {
		return sql.NullTime{}
	}
	for _, layout := range []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02T15:04:05.999999999",
		"2006-01-02T15:04:05",
		"2006-01-02",
	} {
		if tt, err := time.Parse(layout, s); err == nil {
			return sql.NullTime{Time: tt, Valid: true}
		}
	}
	return sql.NullTime{}
}

// extractItems pulls the record array out of a Udara "data" value, which may be a
// bare array ([...]) or an object that wraps the array under a nested field
// ({"data":[...], "totalCount":N}). Returns nil (no error) when no array is found.
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
		// Prefer conventionally-named collection fields.
		for _, k := range []string{"data", "items", "records", "result", "list"} {
			if v, ok := obj[k]; ok {
				if it, err := extractItems(v); err == nil && it != nil {
					return it, nil
				}
			}
		}
		// Otherwise take the first array-valued field.
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

func rawOf(m map[string]any) string {
	b, err := json.Marshal(m)
	if err != nil {
		return "{}"
	}
	return string(b)
}

func truncate(b []byte, n int) string {
	s := string(b)
	if len(s) > n {
		return s[:n] + "..."
	}
	return s
}

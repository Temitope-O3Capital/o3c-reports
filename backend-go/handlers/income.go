package handlers

import (
	"context"
	"database/sql"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// ── Parser ────────────────────────────────────────────────────────────────────

var (
	incProductRE = regexp.MustCompile(`Account Product \[(\d+)\]\s*:\s*(.+)`)
	incDataRE    = regexp.MustCompile(`^\s*(\d{1,6})\s+(\d{4,})\s+(\d{6,})\s+(NGN|USD)\s+(.+)$`)
	incHdrDateRE = regexp.MustCompile(`Report Date\s*:\s*(\d{8})`)
	incNumRE     = regexp.MustCompile(`-?[\d,]+\.?\d*`)
)

func incDetectType(filename string) string {
	n := strings.ToLower(filename)
	switch {
	case strings.Contains(n, "cyc_int"):
		return "interest"
	case strings.Contains(n, "cyc_chg"):
		return "charges"
	case strings.Contains(n, "cyc_bal"):
		return "balances"
	case strings.Contains(n, "cyc_loc"):
		return "loc"
	case strings.Contains(n, "cust_file"):
		return "customers"
	}
	return "unknown"
}

func incExtractNums(s string) []float64 {
	ms := incNumRE.FindAllString(s, -1)
	out := make([]float64, 0, len(ms))
	for _, m := range ms {
		if f, err := strconv.ParseFloat(strings.ReplaceAll(m, ",", ""), 64); err == nil {
			out = append(out, f)
		}
	}
	return out
}

func incAt(nums []float64, i int) float64 {
	if i < len(nums) {
		return nums[i]
	}
	return 0
}

func incParseReport(content, fileType string) ([]map[string]any, time.Time) {
	cycleDate := time.Now().UTC().Truncate(24 * time.Hour)
	if m := incHdrDateRE.FindStringSubmatch(content); m != nil {
		s := m[1]
		// Try DDMMYYYY (actual report format), then YYYYMMDD as fallback
		for _, ys := range []string{s[4:8] + s[2:4] + s[0:2], s} {
			if t, err := time.Parse("20060102", ys); err == nil {
				cycleDate = t
				break
			}
		}
	}

	var rows []map[string]any
	productCode, productName := "", ""

	for _, line := range strings.Split(content, "\n") {
		if pm := incProductRE.FindStringSubmatch(line); pm != nil {
			productCode, productName = strings.TrimSpace(pm[1]), strings.TrimSpace(pm[2])
			continue
		}
		dm := incDataRE.FindStringSubmatch(line)
		if dm == nil {
			continue
		}
		nums := incExtractNums(dm[5])
		row := map[string]any{
			"apnum": dm[1], "cif": strings.TrimSpace(dm[2]),
			"account": strings.TrimSpace(dm[3]), "currency": dm[4],
			"product_code": productCode, "product_name": productName,
		}
		switch fileType {
		case "interest":
			row["interest"] = incAt(nums, 0)
		case "charges":
			row["fees"] = incAt(nums, 0); row["interest"] = incAt(nums, 1)
			row["penalty"] = incAt(nums, 2); row["purchase"] = incAt(nums, 3)
			row["cash_advance"] = incAt(nums, 4)
		case "balances":
			row["billed_bal"] = incAt(nums, 0); row["current_bal"] = incAt(nums, 1)
			row["outstanding_bal"] = incAt(nums, 2); row["overdue"] = incAt(nums, 3)
			row["min_payment"] = incAt(nums, 4)
		case "loc":
			row["current_loc"] = incAt(nums, 0); row["loc_change"] = incAt(nums, 1)
			row["temp_loc"] = incAt(nums, 2)
		default:
			continue
		}
		rows = append(rows, row)
	}
	return rows, cycleDate
}

func incParseCustomers(content string) []map[string]any {
	// Format (no header): FIRSTNAME,LASTNAME,ADDR1,ADDR2,ADDR3,COUNTRY,PHONE,EMAIL,STATE,CITY,MOBILE,CIF
	var rows []map[string]any
	cr := csv.NewReader(strings.NewReader(content))
	records, _ := cr.ReadAll()
	for _, p := range records {
		if len(p) < 12 {
			continue
		}
		cif := strings.TrimSpace(p[11])
		valid := cif != ""
		for _, c := range cif {
			if c < '0' || c > '9' {
				valid = false
				break
			}
		}
		if !valid {
			continue
		}
		var addrParts []string
		for _, s := range p[2:5] {
			if s = strings.TrimSpace(s); s != "" {
				addrParts = append(addrParts, s)
			}
		}
		rows = append(rows, map[string]any{
			"cif": cif,
			"first_name": incTitle(p[0]), "last_name": incTitle(p[1]),
			"address":    strings.Join(addrParts, ", "),
			"country":    strings.TrimSpace(p[5]),
			"phone":      strings.TrimSpace(p[6]),
			"email":      strings.ToLower(strings.TrimSpace(p[7])),
			"state":      incTitle(p[8]),
			"city":       incTitle(p[9]),
			"mobile":     strings.TrimSpace(p[10]),
		})
	}
	return rows
}

func incTitle(s string) string {
	words := strings.Fields(strings.TrimSpace(s))
	for i, w := range words {
		if len(w) > 0 {
			words[i] = strings.ToUpper(w[:1]) + strings.ToLower(w[1:])
		}
	}
	return strings.Join(words, " ")
}

// ── Bulk insert inside a transaction ─────────────────────────────────────────

func incBulkInsert(ctx context.Context, tx *sql.Tx, table string, cols []string, rows []map[string]any) error {
	const batchSize = 500
	for start := 0; start < len(rows); start += batchSize {
		end := start + batchSize
		if end > len(rows) {
			end = len(rows)
		}
		batch := rows[start:end]
		var groups []string
		var args []any
		n := 1
		for _, row := range batch {
			holders := make([]string, len(cols))
			for i, col := range cols {
				holders[i] = fmt.Sprintf("$%d", n)
				args = append(args, row[col])
				n++
			}
			groups = append(groups, "("+strings.Join(holders, ",")+")")
		}
		q := fmt.Sprintf("INSERT INTO %s (%s) VALUES %s",
			table, strings.Join(cols, ","), strings.Join(groups, ","))
		if _, err := tx.ExecContext(ctx, q, args...); err != nil {
			return err
		}
	}
	return nil
}

// ── Account JOIN query builder ────────────────────────────────────────────────

func incAccountQuery(cycleID int64, product, currency string, hasOverdue, hasInterest bool, q string) (string, []any, int) {
	filters := []string{"ii.cycle_id = $1"}
	args := []any{cycleID}
	n := 2

	if product != "" {
		filters = append(filters, fmt.Sprintf("ii.product_name = $%d", n))
		args = append(args, product)
		n++
	}
	if currency != "" {
		filters = append(filters, fmt.Sprintf("ii.currency = $%d", n))
		args = append(args, currency)
		n++
	}
	if hasOverdue {
		filters = append(filters, "COALESCE(ib.overdue, 0) > 0")
	}
	if hasInterest {
		filters = append(filters, "COALESCE(ii.interest, 0) > 0")
	}
	if q != "" {
		filters = append(filters, fmt.Sprintf(
			`(ii.cif ILIKE $%d OR ic.first_name ILIKE $%d OR ic.last_name ILIKE $%d OR a."First Name" ILIKE $%d OR a."Last Name" ILIKE $%d)`,
			n, n, n, n, n))
		args = append(args, "%"+q+"%")
		n++
	}

	where := strings.Join(filters, " AND ")
	qSQL := fmt.Sprintf(`
		SELECT
			ii.cif,
			COALESCE(a."First Name", ic.first_name, '') AS first_name,
			COALESCE(a."Last Name",  ic.last_name,  '') AS last_name,
			ii.account, ii.product_code, ii.product_name, ii.currency,
			COALESCE(ii.interest,        0) AS interest,
			COALESCE(ich.fees,           0) AS fees,
			COALESCE(ich.interest,       0) AS charge_interest,
			COALESCE(ich.penalty,        0) AS penalty,
			COALESCE(ich.purchase,       0) AS purchase,
			COALESCE(ich.cash_advance,   0) AS cash_advance,
			COALESCE(ib.billed_bal,      0) AS billed_bal,
			COALESCE(ib.current_bal,     0) AS current_bal,
			COALESCE(ib.outstanding_bal, 0) AS outstanding_bal,
			COALESCE(ib.overdue,         0) AS overdue,
			COALESCE(ib.min_payment,     0) AS min_payment,
			COALESCE(il.current_loc,     0) AS current_loc,
			COALESCE(il.loc_change,      0) AS loc_change
		FROM income_interest ii
		LEFT JOIN income_charges  ich ON ich.cif=ii.cif AND ich.cycle_id=ii.cycle_id AND ich.account=ii.account
		LEFT JOIN income_balances ib  ON ib.cif =ii.cif AND ib.cycle_id =ii.cycle_id AND ib.account =ii.account
		LEFT JOIN income_loc      il  ON il.cif =ii.cif AND il.cycle_id =ii.cycle_id AND il.account =ii.account
		LEFT JOIN income_customers ic ON ic.cif =ii.cif AND ic.cycle_id =ii.cycle_id
		LEFT JOIN "Accounts"       a  ON a."CIF Number" = ii.cif
		WHERE %s`, where)

	return qSQL, args, n
}

// ── Register ──────────────────────────────────────────────────────────────────

func RegisterIncome(r chi.Router, db *core.DB) {
	access := core.RequirePages("income")
	r.With(access).Post("/upload", incUpload(db))
	r.With(access).Get("/cycles", incListCycles(db))
	r.With(access).Delete("/cycles/{id}", incDeleteCycle(db))
	r.With(access).Get("/summary", incSummary(db))
	r.With(access).Get("/by-product", incByProduct(db))
	r.With(access).Get("/accounts", incAccounts(db))
	r.With(access).Get("/accounts/export", incAccountsExport(db))
	r.With(access).Get("/trend", incTrend(db))
}

// ── Upload ────────────────────────────────────────────────────────────────────

func incUpload(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseMultipartForm(200 << 20); err != nil {
			respondErr(w, 400, "Cannot parse multipart form")
			return
		}
		files := r.MultipartForm.File["files"]
		if len(files) == 0 {
			respondErr(w, 400, "No files provided")
			return
		}

		type parseResult struct {
			rows []map[string]any
			date time.Time
		}
		parsedFiles := map[string]parseResult{}
		var detectedDate time.Time

		const maxBytes = 50 * 1024 * 1024
		for _, fh := range files {
			if fh.Size > maxBytes {
				respondErr(w, 413, "File "+fh.Filename+" exceeds 50 MB limit")
				return
			}
			f, err := fh.Open()
			if err != nil {
				continue
			}
			raw, _ := io.ReadAll(f)
			f.Close()

			ftype := incDetectType(fh.Filename)
			if ftype == "unknown" {
				continue
			}
			if ftype == "customers" {
				parsedFiles["customers"] = parseResult{rows: incParseCustomers(string(raw))}
			} else {
				rows, cdate := incParseReport(string(raw), ftype)
				parsedFiles[ftype] = parseResult{rows: rows, date: cdate}
				if !cdate.IsZero() {
					detectedDate = cdate
				}
			}
		}

		if len(parsedFiles) == 0 {
			respondErr(w, 422, "No recognised cycle files. Expected: cyc_int_rpt, cyc_chg_rpt, cyc_bal_rpt, cyc_loc_rpt, cust_file")
			return
		}

		cycleDate := detectedDate
		if cycleDate.IsZero() {
			cycleDate = time.Now().UTC().Truncate(24 * time.Hour)
		}
		cycleLabel := strings.TrimSpace(r.FormValue("cycle_label"))
		if cycleLabel == "" {
			cycleLabel = cycleDate.Format("January 2006")
		}

		uploadCtx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
		defer cancel()

		user := core.UserFromCtx(r.Context())

		tx, err := db.PG.BeginTx(uploadCtx, nil)
		if err != nil {
			respondErr(w, 500, "Database error")
			return
		}
		defer tx.Rollback() //nolint:errcheck

		var cycleID int64
		err = tx.QueryRowContext(uploadCtx,
			"SELECT id FROM income_cycles WHERE cycle_date = $1", cycleDate).Scan(&cycleID)
		if err == sql.ErrNoRows {
			if err2 := tx.QueryRowContext(uploadCtx,
				"INSERT INTO income_cycles (cycle_date, label, loaded_by) VALUES ($1,$2,$3) RETURNING id",
				cycleDate, cycleLabel, user.ID).Scan(&cycleID); err2 != nil {
				respondErr(w, 500, "Failed to create cycle record")
				return
			}
		} else if err != nil {
			respondErr(w, 500, "Database error")
			return
		} else {
			// Existing cycle — delete old child data and update label
			for _, tbl := range []string{
				"income_customers", "income_interest", "income_charges", "income_balances", "income_loc",
			} {
				if _, err2 := tx.ExecContext(uploadCtx, "DELETE FROM "+tbl+" WHERE cycle_id=$1", cycleID); err2 != nil {
					respondErr(w, 500, "Failed to clear old cycle data")
					return
				}
			}
			tx.ExecContext(uploadCtx, //nolint:errcheck
				"UPDATE income_cycles SET label=$1, loaded_at=NOW(), loaded_by=$2 WHERE id=$3",
				cycleLabel, user.ID, cycleID)
		}

		counts := map[string]int{}

		type tableInsert struct {
			key  string
			tbl  string
			cols []string
		}
		inserts := []tableInsert{
			{"customers", "income_customers",
				[]string{"cycle_id", "cif", "first_name", "last_name", "address", "state", "city", "phone", "email", "mobile"}},
			{"interest", "income_interest",
				[]string{"cycle_id", "apnum", "cif", "account", "currency", "product_code", "product_name", "interest"}},
			{"charges", "income_charges",
				[]string{"cycle_id", "apnum", "cif", "account", "currency", "product_code", "product_name",
					"fees", "interest", "penalty", "purchase", "cash_advance"}},
			{"balances", "income_balances",
				[]string{"cycle_id", "apnum", "cif", "account", "currency", "product_code", "product_name",
					"billed_bal", "current_bal", "outstanding_bal", "overdue", "min_payment"}},
			{"loc", "income_loc",
				[]string{"cycle_id", "apnum", "cif", "account", "currency", "product_code", "product_name",
					"current_loc", "loc_change", "temp_loc"}},
		}

		for _, ins := range inserts {
			p, ok := parsedFiles[ins.key]
			if !ok {
				continue
			}
			for i := range p.rows {
				p.rows[i]["cycle_id"] = cycleID
			}
			if err2 := incBulkInsert(uploadCtx, tx, ins.tbl, ins.cols, p.rows); err2 != nil {
				respondErr(w, 500, "Failed to insert "+ins.key+": "+err2.Error())
				return
			}
			counts[ins.key] = len(p.rows)
		}

		if err := tx.Commit(); err != nil {
			respondErr(w, 500, "Commit failed")
			return
		}

		// Audit log — non-critical, ignore errors
		var fnames []string
		for _, fh := range files {
			fnames = append(fnames, fh.Filename)
		}
		countsJSON, _ := json.Marshal(counts)
		db.PGExec(r.Context(), //nolint:errcheck
			`INSERT INTO upload_audit_log (uploaded_by, report_type, file_names, cycle_label, row_counts, status)
			 VALUES ($1,'income',$2,$3,$4,'success')`,
			user.ID, strings.Join(fnames, ", "), cycleLabel, string(countsJSON))

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"cycle_id": cycleID, "cycle_date": cycleDate.Format("2006-01-02"),
			"label": cycleLabel, "loaded": counts,
		})
	}
}

// ── Cycles list ───────────────────────────────────────────────────────────────

func incListCycles(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT c.id, c.cycle_date, c.label, c.loaded_at,
			       u.full_name AS loaded_by_name,
			       (SELECT COUNT(*) FROM income_interest WHERE cycle_id=c.id) AS interest_rows,
			       (SELECT COUNT(*) FROM income_charges  WHERE cycle_id=c.id) AS charge_rows
			FROM income_cycles c
			LEFT JOIN o3c_users u ON u.id = c.loaded_by
			ORDER BY c.cycle_date DESC`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		jsonRows(w, rows)
	}
}

// ── Delete cycle ──────────────────────────────────────────────────────────────

func incDeleteCycle(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		// Child tables deleted via ON DELETE CASCADE on income_cycles.id
		db.PGExec(r.Context(), "DELETE FROM income_cycles WHERE id=$1", id) //nolint:errcheck
		w.WriteHeader(204)
	}
}

// ── KPI Summary ───────────────────────────────────────────────────────────────

func incSummary(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cycleID := int64(qint(r, "cycle_id", 0, 1, 1<<30))
		if cycleID == 0 {
			// No cycle selected — auto-pick the latest uploaded cycle
			latestRows, err := db.PGQuery(r.Context(), `SELECT id FROM income_cycles ORDER BY cycle_date DESC, id DESC LIMIT 1`)
			if err != nil || len(latestRows) == 0 {
				// No cycles uploaded yet — return zeros
				respond(w, map[string]any{
					"total_interest": 0, "total_charges": 0,
					"total_balance": 0, "total_loc": 0,
					"by_product": []any{}, "by_currency": []any{},
				}, "pg")
				return
			}
			if id, ok := latestRows[0]["id"].(int64); ok {
				cycleID = id
			}
		}
		product  := qstr(r, "product")
		currency := qstr(r, "currency")

		n := 1
		args := []any{cycleID}
		where := fmt.Sprintf("cycle_id = $%d", n)
		n++
		if product != "" {
			where += fmt.Sprintf(" AND product_name = $%d", n)
			args = append(args, product)
			n++
		}
		if currency != "" {
			where += fmt.Sprintf(" AND currency = $%d", n)
			args = append(args, currency)
			n++
		}

		ctx := r.Context()

		scalar := func(table, col string) float64 {
			rows, _ := db.PGQuery(ctx,
				fmt.Sprintf("SELECT COALESCE(SUM(%s),0) AS v FROM %s WHERE %s", col, table, where), args...)
			if len(rows) > 0 {
				if v, ok := rows[0]["v"].(float64); ok {
					return v
				}
				return float64(toInt64(rows[0]["v"]))
			}
			return 0
		}

		interest    := scalar("income_interest", "interest")
		fees        := scalar("income_charges", "fees")
		chargeInt   := scalar("income_charges", "interest")
		penalty     := scalar("income_charges", "penalty")
		purchase    := scalar("income_charges", "purchase")
		cashAdv     := scalar("income_charges", "cash_advance")
		outstanding := scalar("income_balances", "outstanding_bal")
		overdue     := scalar("income_balances", "overdue")
		locTotal    := scalar("income_loc", "current_loc")

		countRows, _ := db.PGQuery(ctx,
			fmt.Sprintf("SELECT COUNT(*) AS n FROM income_balances WHERE %s AND overdue > 0", where), args...)
		overdueAccts := int64(0)
		if len(countRows) > 0 {
			overdueAccts = toInt64(countRows[0]["n"])
		}

		totalRows, _ := db.PGQuery(ctx,
			fmt.Sprintf("SELECT COUNT(*) AS n FROM income_interest WHERE %s", where), args...)
		totalAccts := int64(0)
		if len(totalRows) > 0 {
			totalAccts = toInt64(totalRows[0]["n"])
		}

		prodRows, _ := db.PGQuery(ctx,
			fmt.Sprintf("SELECT DISTINCT product_name FROM income_interest WHERE %s ORDER BY 1", where), args...)
		var products []string
		for _, pr := range prodRows {
			if v, ok := pr["product_name"].(string); ok {
				products = append(products, v)
			}
		}

		locUtil := 0.0
		if locTotal > 0 {
			locUtil = math.Round(outstanding/locTotal*1000) / 10
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"interest":         interest,
			"fees":             fees,
			"charge_interest":  chargeInt,
			"penalty":          penalty,
			"purchase":         purchase,
			"cash_advance":     cashAdv,
			"total_charges":    fees + chargeInt + penalty + purchase + cashAdv,
			"outstanding_bal":  outstanding,
			"overdue":          overdue,
			"overdue_accounts": overdueAccts,
			"total_accounts":   totalAccts,
			"loc_total":        locTotal,
			"loc_utilisation":  locUtil,
			"products":         products,
		})
	}
}

// ── Product breakdown ─────────────────────────────────────────────────────────

func incByProduct(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cycleID := int64(qint(r, "cycle_id", 0, 1, 1<<30))
		if cycleID == 0 {
			respond(w, []any{}, "pg")
			return
		}
		currency := qstr(r, "currency")

		n := 1
		args := []any{cycleID}
		where := fmt.Sprintf("ii.cycle_id = $%d", n)
		n++
		if currency != "" {
			where += fmt.Sprintf(" AND ii.currency = $%d", n)
			args = append(args, currency)
		}

		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT
				ii.product_name, ii.product_code,
				COUNT(DISTINCT ii.cif)               AS accounts,
				COALESCE(SUM(ii.interest),       0)  AS interest,
				COALESCE(SUM(ich.fees),          0)  AS fees,
				COALESCE(SUM(ich.cash_advance),  0)  AS cash_advance,
				COALESCE(SUM(ich.purchase),      0)  AS purchase,
				COALESCE(SUM(ib.outstanding_bal),0)  AS outstanding_bal,
				COALESCE(SUM(ib.overdue),        0)  AS overdue,
				COALESCE(SUM(il.current_loc),    0)  AS current_loc
			FROM income_interest ii
			LEFT JOIN income_charges  ich ON ich.cif=ii.cif AND ich.cycle_id=ii.cycle_id AND ich.account=ii.account
			LEFT JOIN income_balances ib  ON ib.cif =ii.cif AND ib.cycle_id =ii.cycle_id AND ib.account =ii.account
			LEFT JOIN income_loc      il  ON il.cif =ii.cif AND il.cycle_id =ii.cycle_id AND il.account =ii.account
			WHERE %s
			GROUP BY ii.product_name, ii.product_code
			ORDER BY interest DESC NULLS LAST`, where), args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		jsonRows(w, rows)
	}
}

// ── Account table ─────────────────────────────────────────────────────────────

func incAccounts(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cycleID := int64(qint(r, "cycle_id", 0, 1, 1<<30))
		if cycleID == 0 {
			respondErr(w, 422, "cycle_id is required")
			return
		}
		product     := qstr(r, "product")
		currency    := qstr(r, "currency")
		hasOverdue  := qstr(r, "has_overdue") == "true"
		hasInterest := qstr(r, "has_interest") == "true"
		q           := qstr(r, "q")
		limit       := qint(r, "limit", 200, 1, 2000)
		offset      := qint(r, "offset", 0, 0, 1<<30)

		qSQL, args, n := incAccountQuery(cycleID, product, currency, hasOverdue, hasInterest, q)
		ctx := r.Context()

		countRows, _ := db.PGQuery(ctx,
			fmt.Sprintf("SELECT COUNT(*) AS n FROM (%s) sub", qSQL), args...)
		total := int64(0)
		if len(countRows) > 0 {
			total = toInt64(countRows[0]["n"])
		}

		pageArgs := append(append([]any(nil), args...), limit, offset)
		pageSQL := qSQL + fmt.Sprintf(" ORDER BY interest DESC NULLS LAST LIMIT $%d OFFSET $%d", n, n+1)
		rows, err := db.PGQuery(ctx, pageSQL, pageArgs...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"data":  rows,
			"total": total,
		})
	}
}

// ── CSV Export ────────────────────────────────────────────────────────────────

func incAccountsExport(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cycleID := int64(qint(r, "cycle_id", 0, 1, 1<<30))
		if cycleID == 0 {
			respondErr(w, 422, "cycle_id is required")
			return
		}
		product     := qstr(r, "product")
		currency    := qstr(r, "currency")
		hasOverdue  := qstr(r, "has_overdue") == "true"
		hasInterest := qstr(r, "has_interest") == "true"
		q           := qstr(r, "q")

		qSQL, args, _ := incAccountQuery(cycleID, product, currency, hasOverdue, hasInterest, q)
		rows, err := db.PGQuery(r.Context(), qSQL+" ORDER BY interest DESC NULLS LAST", args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}

		// Get cycle label for filename
		label := "income"
		if lr, _ := db.PGQuery(r.Context(), "SELECT label FROM income_cycles WHERE id=$1", cycleID); len(lr) > 0 {
			if v, ok := lr[0]["label"].(string); ok {
				label = strings.ReplaceAll(v, " ", "_")
			}
		}

		w.Header().Set("Content-Type", "text/csv")
		w.Header().Set("Content-Disposition", `attachment; filename="income_`+label+`.csv"`)

		cw := csv.NewWriter(w)
		cw.Write([]string{ //nolint:errcheck
			"CIF", "First Name", "Last Name", "Account", "Product Code", "Product",
			"Currency", "Interest", "Fees", "Charge Interest", "Penalty",
			"Purchase", "Cash Advance", "Billed Balance", "Current Balance",
			"Outstanding Balance", "Overdue", "Min Payment", "Current LOC", "LOC Change",
		})
		cols := []string{
			"cif", "first_name", "last_name", "account", "product_code", "product_name",
			"currency", "interest", "fees", "charge_interest", "penalty",
			"purchase", "cash_advance", "billed_bal", "current_bal",
			"outstanding_bal", "overdue", "min_payment", "current_loc", "loc_change",
		}
		for _, row := range rows {
			rec := make([]string, len(cols))
			for i, c := range cols {
				if v := row[c]; v != nil {
					rec[i] = fmt.Sprintf("%v", v)
				}
			}
			cw.Write(rec) //nolint:errcheck
		}
		cw.Flush()
	}
}

// ── Month-over-month trend ────────────────────────────────────────────────────

func incTrend(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT
				c.label, c.cycle_date,
				COALESCE(SUM(i.interest),       0) AS interest,
				COALESCE(SUM(ch.fees),          0) AS fees,
				COALESCE(SUM(ch.cash_advance),  0) AS cash_advance,
				COALESCE(SUM(b.outstanding_bal),0) AS outstanding_bal,
				COALESCE(SUM(b.overdue),        0) AS overdue
			FROM income_cycles c
			LEFT JOIN income_interest i  ON i.cycle_id  = c.id
			LEFT JOIN income_charges  ch ON ch.cycle_id = c.id AND ch.cif=i.cif AND ch.account=i.account
			LEFT JOIN income_balances b  ON b.cycle_id  = c.id AND b.cif=i.cif AND b.account=i.account
			GROUP BY c.id, c.label, c.cycle_date
			ORDER BY c.cycle_date`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		jsonRows(w, rows)
	}
}

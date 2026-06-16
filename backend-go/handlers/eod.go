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

// ── Parser constants ──────────────────────────────────────────────────────────

// Known descriptions — order matters: longer/more-specific first.
var eodDescriptions = []string{
	"Cash Payment Bank Reversal", "Cash Payment Bank",
	"Cash Advance Reversal", "Cash Advance",
	"Purchase Reversal", "Purchase",
	"Utility Payment Reversal", "Utility Payment",
	"Web Transfer Out Reversal", "Web Transfer Out",
	"Web Transfer In Reversal", "Web Transfer In",
	"Re-Issue Fee",
	"Joining Fee Reversal", "Joining Fee",
	"Account Maintenance Fee Reversal", "Account Maintenance Fee",
	"Membership Fee",
}

var eodTxnCategory = map[string]string{
	"200": "Purchase", "201": "Purchase",
	"250": "Purchase Reversal", "251": "Purchase Reversal",
	"300": "Cash Advance", "301": "Cash Advance",
	"350": "Cash Advance Reversal", "351": "Cash Advance Reversal",
	"303": "Utility Payment", "353": "Utility Payment Reversal",
	"402": "Bank Payment", "452": "Bank Payment Reversal",
	"422": "Transfer In", "423": "Transfer Out",
	"472": "Transfer In Reversal", "473": "Transfer Out Reversal",
	"100": "Account Fee", "104": "Account Fee", "105": "Account Fee",
	"155": "Account Fee Reversal", "158": "Account Fee Reversal",
}

var eodProductNames = map[string]string{
	"001": "Amex Naira", "002": "Amex USD",
	"003": "PREP Temporary Virtual",
	"100": "Classic Accounts", "105": "Platinum Accounts",
	"110": "Prestige Accounts", "120": "BB Classic Account",
	"160": "Business Accounts", "205": "PREP",
	"405": "Financial Inclusion Account",
}

var (
	eodReportDateRE = regexp.MustCompile(`Report Date\s*:\s*(\d{2}/\d{2}/\d{4})`)
	eodBranchRE     = regexp.MustCompile(`BRANCH Number\s*:\s*(\w+)\s*-\s*(.+)`)
	eodProductRE    = regexp.MustCompile(`Account Product Number\s*:\s*(\w+)\s*\((.+?)\)`)
	eodAccountRE    = regexp.MustCompile(
		`Account No\.\s*:\s*(\S+)\s+CIF\s*:\s*(\S+)\s+Arrears\s*:\s*([\d,.-]+)\s+LOC\s*:\s*([\d,.-]+)\s+Bal\.\s*:\s*([\d,.-]+)\s+(.*)`)
	eodAmtSignCcyRE = regexp.MustCompile(`([\d,]+\.\d{2})\s+(DR|CR)\s+(NGN|USD)`)
	eodTxnCodeDateRE = regexp.MustCompile(`(\d{3})\s+(\d{2}/\d{2}/\d{4})`)
	eodIsTxnRE       = regexp.MustCompile(`^\s*\d+.*\b(DR|CR)\s+(NGN|USD)\b`)
	eodCardRE        = regexp.MustCompile(`^[0-9]{6}[0-9*]+[0-9]{4}$`)
	eodFnameDateRE   = regexp.MustCompile(`\.(\d{8})\.`)
)

func eodParseAmount(s string) float64 {
	f, _ := strconv.ParseFloat(strings.ReplaceAll(s, ",", ""), 64)
	return f
}

func eodExtractDesc(s string) (merchant, description string) {
	s = strings.TrimLeft(s, " \t")
	for _, desc := range eodDescriptions {
		if idx := strings.LastIndex(s, desc); idx >= 0 {
			return strings.TrimSpace(s[:idx]), desc
		}
	}
	return "", strings.TrimSpace(s)
}

func eodParseTxnLine(line string) map[string]any {
	if !eodIsTxnRE.MatchString(line) {
		return nil
	}
	mAsc := eodAmtSignCcyRE.FindStringSubmatchIndex(line)
	if mAsc == nil {
		return nil
	}
	amtStr := line[mAsc[2]:mAsc[3]]
	sign := line[mAsc[4]:mAsc[5]]
	currency := line[mAsc[6]:mAsc[7]]
	amount := eodParseAmount(amtStr)

	beforeAmt := line[:mAsc[0]]
	mCd := eodTxnCodeDateRE.FindStringSubmatchIndex(beforeAmt)
	if mCd == nil {
		return nil
	}
	txnCode := beforeAmt[mCd[2]:mCd[3]]
	txnDate, err := time.Parse("02/01/2006", beforeAmt[mCd[4]:mCd[5]])
	if err != nil {
		return nil
	}

	// Parse trace / auth / card from the segment before the txn code
	pre := strings.TrimSpace(beforeAmt[:mCd[0]])
	tokens := strings.Fields(pre)
	traceNum := ""
	if len(tokens) > 0 {
		traceNum = tokens[0]
	}
	authNum, cardNum := "", ""
	for _, tok := range tokens[1:] {
		if eodCardRE.MatchString(tok) {
			cardNum = tok
		} else if cardNum == "" && authNum == "" {
			allDigits := true
			for _, c := range tok {
				if c < '0' || c > '9' {
					allDigits = false
					break
				}
			}
			if allDigits {
				authNum = tok
			}
		}
	}

	merchantID := strings.TrimSpace(beforeAmt[mCd[1]:])
	merchantName, description := eodExtractDesc(line[mAsc[1]:])

	cat := eodTxnCategory[txnCode]
	if cat == "" {
		cat = "Other"
	}
	return map[string]any{
		"trace_num": traceNum, "auth_num": authNum, "card_num": cardNum,
		"txn_code": txnCode, "txn_category": cat,
		"txn_date": txnDate,
		"merchant_id": merchantID, "amount": amount,
		"sign": sign, "currency": currency,
		"merchant_name": merchantName, "description": description,
	}
}

func eodParseFile(content string) ([]map[string]any, time.Time) {
	txnDate := time.Now().UTC().Truncate(24 * time.Hour)
	if m := eodReportDateRE.FindStringSubmatch(content); m != nil {
		if t, err := time.Parse("02/01/2006", m[1]); err == nil {
			txnDate = t
		}
	}

	var rows []map[string]any
	branchCode, branchName := "", ""
	productCode, productName := "", ""
	accountNo, cif, customer := "", "", ""
	var arrears, loc, balance float64

	for _, line := range strings.Split(content, "\n") {
		if mb := eodBranchRE.FindStringSubmatch(line); mb != nil {
			branchCode, branchName = strings.TrimSpace(mb[1]), strings.TrimSpace(mb[2])
			continue
		}
		if mp := eodProductRE.FindStringSubmatch(line); mp != nil {
			productCode = strings.TrimSpace(mp[1])
			rawName := strings.TrimSpace(mp[2])
			productName = eodProductNames[productCode]
			if productName == "" {
				productName = rawName
			}
			continue
		}
		if ma := eodAccountRE.FindStringSubmatch(line); ma != nil {
			accountNo = strings.TrimSpace(ma[1])
			cifRaw := strings.TrimLeft(strings.TrimSpace(ma[2]), "0")
			if cifRaw == "" {
				cifRaw = "0"
			}
			cif = cifRaw
			arrears = eodParseAmount(ma[3])
			loc = eodParseAmount(ma[4])
			balance = eodParseAmount(ma[5])
			customer = strings.TrimSpace(ma[6])
			continue
		}
		txn := eodParseTxnLine(line)
		if txn == nil {
			continue
		}
		txn["branch_code"] = branchCode
		txn["branch_name"] = branchName
		txn["product_code"] = productCode
		txn["product_name"] = productName
		txn["account_no"] = accountNo
		txn["cif"] = cif
		txn["customer"] = customer
		txn["arrears"] = arrears
		txn["loc"] = loc
		txn["balance"] = balance
		rows = append(rows, txn)
	}
	return rows, txnDate
}

func eodDateFromFilename(filename string) (time.Time, bool) {
	m := eodFnameDateRE.FindStringSubmatch(filename)
	if m == nil {
		return time.Time{}, false
	}
	t, err := time.Parse("20060102", m[1])
	return t, err == nil
}

// ── Bulk insert inside a transaction ─────────────────────────────────────────

var eodTxnCols = []string{
	"upload_id", "txn_date", "branch_code", "branch_name",
	"product_code", "product_name", "account_no", "cif", "customer",
	"arrears", "loc", "balance",
	"trace_num", "auth_num", "card_num", "txn_code", "txn_category",
	"amount", "sign", "currency", "merchant_id", "merchant_name", "description",
}

func eodBulkInsert(ctx context.Context, tx *sql.Tx, rows []map[string]any, uploadID int64) error {
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
			holders := make([]string, len(eodTxnCols))
			for i, col := range eodTxnCols {
				holders[i] = fmt.Sprintf("$%d", n)
				if col == "upload_id" {
					args = append(args, uploadID)
				} else {
					args = append(args, row[col])
				}
				n++
			}
			groups = append(groups, "("+strings.Join(holders, ",")+")")
		}
		q := fmt.Sprintf("INSERT INTO eod_transactions (%s) VALUES %s",
			strings.Join(eodTxnCols, ","), strings.Join(groups, ","))
		if _, err := tx.ExecContext(ctx, q, args...); err != nil {
			return err
		}
	}
	return nil
}

// ── WHERE clause builder ──────────────────────────────────────────────────────

func eodBuildWhere(dateFrom, dateTo, branch, product, txnType, sign, q string) (string, []any, int, error) {
	filters := []string{"txn_date >= $1::date", "txn_date <= $2::date"}
	args := []any{dateFrom, dateTo}
	n := 3

	if branch != "" {
		filters = append(filters, fmt.Sprintf("branch_code = $%d", n))
		args = append(args, branch)
		n++
	}
	if product != "" {
		filters = append(filters, fmt.Sprintf("product_code = $%d", n))
		args = append(args, product)
		n++
	}
	if txnType != "" {
		filters = append(filters, fmt.Sprintf("txn_category = $%d", n))
		args = append(args, txnType)
		n++
	}
	if sign != "" {
		if sign != "DR" && sign != "CR" {
			return "", nil, 0, fmt.Errorf("sign must be DR or CR")
		}
		filters = append(filters, fmt.Sprintf("sign = $%d", n))
		args = append(args, sign)
		n++
	}
	if q != "" {
		filters = append(filters, fmt.Sprintf(
			"(cif ILIKE $%d OR customer ILIKE $%d OR account_no ILIKE $%d OR merchant_name ILIKE $%d OR trace_num = $%d)",
			n, n, n, n, n+1))
		args = append(args, "%"+q+"%", strings.TrimSpace(q))
		n += 2
	}
	return strings.Join(filters, " AND "), args, n, nil
}

// ── Register ──────────────────────────────────────────────────────────────────

func RegisterEOD(r chi.Router, db *core.DB) {
	access := core.RequirePages("eod")
	r.With(access).Post("/upload", eodUpload(db))
	r.With(access).Get("/uploads", eodListUploads(db))
	r.With(access).Delete("/uploads/{id}", eodDeleteUpload(db))
	r.With(access).Get("/summary", eodSummary(db))
	r.With(access).Get("/by-product", eodByProduct(db))
	r.With(access).Get("/by-type", eodByType(db))
	r.With(access).Get("/by-branch", eodByBranch(db))
	r.With(access).Get("/trend", eodTrend(db))
	r.With(access).Get("/transactions", eodTransactions(db))
	r.With(access).Get("/transactions/export", eodTransactionsExport(db))
}

// ── Upload ────────────────────────────────────────────────────────────────────

func eodUpload(db *core.DB) http.HandlerFunc {
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

		uploadCtx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
		defer cancel()
		user := core.UserFromCtx(r.Context())

		var results []map[string]any
		const maxBytes = 50 * 1024 * 1024

		for _, fh := range files {
			if fh.Size > maxBytes {
				respondErr(w, 413, "File "+fh.Filename+" exceeds 50 MB")
				return
			}
			if !strings.Contains(strings.ToUpper(fh.Filename), "EODTXN") {
				continue
			}
			f, err := fh.Open()
			if err != nil {
				continue
			}
			raw, _ := io.ReadAll(f)
			f.Close()

			rows, txnDate := eodParseFile(string(raw))
			if fnDate, ok := eodDateFromFilename(fh.Filename); ok {
				txnDate = fnDate
			}
			if len(rows) == 0 {
				continue
			}

			label := txnDate.Format("02 Jan 2006")

			tx, err := db.PG.BeginTx(uploadCtx, nil)
			if err != nil {
				respondErr(w, 500, "Database error")
				return
			}

			var uploadID int64
			err = tx.QueryRowContext(uploadCtx,
				"SELECT id FROM eod_uploads WHERE txn_date = $1", txnDate).Scan(&uploadID)
			if err == sql.ErrNoRows {
				if err2 := tx.QueryRowContext(uploadCtx,
					"INSERT INTO eod_uploads (txn_date, filename, txn_count, uploaded_by) VALUES ($1,$2,$3,$4) RETURNING id",
					txnDate, fh.Filename, len(rows), user.ID).Scan(&uploadID); err2 != nil {
					tx.Rollback() //nolint:errcheck
					respondErr(w, 500, "Create upload record failed")
					return
				}
			} else if err != nil {
				tx.Rollback() //nolint:errcheck
				respondErr(w, 500, "Database error")
				return
			} else {
				tx.ExecContext(uploadCtx, "DELETE FROM eod_transactions WHERE upload_id = $1", uploadID)          //nolint:errcheck
				tx.ExecContext(uploadCtx,                                                                          //nolint:errcheck
					"UPDATE eod_uploads SET filename=$1, txn_count=$2, uploaded_at=NOW(), uploaded_by=$3 WHERE id=$4",
					fh.Filename, len(rows), user.ID, uploadID)
			}

			if err := eodBulkInsert(uploadCtx, tx, rows, uploadID); err != nil {
				tx.Rollback() //nolint:errcheck
				respondErr(w, 500, "Insert failed: "+err.Error())
				return
			}
			if err := tx.Commit(); err != nil {
				respondErr(w, 500, "Commit failed")
				return
			}

			// Audit log — non-critical
			var dr, cr float64
			for _, row := range rows {
				if s, _ := row["sign"].(string); s == "DR" {
					dr += row["amount"].(float64)
				} else {
					cr += row["amount"].(float64)
				}
			}
			countsJSON, _ := json.Marshal(map[string]any{
				"transactions": len(rows),
				"dr":           math.Round(dr*100) / 100,
				"cr":           math.Round(cr*100) / 100,
			})
			db.PGExec(r.Context(), //nolint:errcheck
				`INSERT INTO upload_audit_log (uploaded_by, report_type, file_names, cycle_label, row_counts, status)
				 VALUES ($1,'eod',$2,$3,$4,'success')`,
				user.ID, fh.Filename, label, string(countsJSON))

			results = append(results, map[string]any{
				"date": txnDate.Format("2006-01-02"), "label": label,
				"txn_count": len(rows), "upload_id": uploadID,
			})
		}

		if len(results) == 0 {
			respondErr(w, 422, `No valid EODTXN files found. Filename must contain "EODTXN".`)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(results) //nolint:errcheck
	}
}

// ── Uploads list ──────────────────────────────────────────────────────────────

func eodListUploads(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT u.id, u.txn_date, u.filename, u.txn_count, u.uploaded_at,
			       usr.full_name AS uploaded_by_name
			FROM eod_uploads u
			LEFT JOIN o3c_users usr ON usr.id = u.uploaded_by
			ORDER BY u.txn_date DESC`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		jsonRows(w, rows)
	}
}

// ── Delete upload ─────────────────────────────────────────────────────────────

func eodDeleteUpload(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		// ON DELETE CASCADE handles eod_transactions
		db.PGExec(r.Context(), "DELETE FROM eod_uploads WHERE id=$1", id) //nolint:errcheck
		w.WriteHeader(204)
	}
}

// ── Summary KPIs ──────────────────────────────────────────────────────────────

func eodSummary(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dateFrom := qstr(r, "date_from")
		dateTo := qstr(r, "date_to")
		if dateFrom == "" || dateTo == "" {
			respondErr(w, 422, "date_from and date_to are required")
			return
		}
		branch  := qstr(r, "branch")
		product := qstr(r, "product")
		txnType := qstr(r, "txn_type")
		sign    := qstr(r, "sign")
		q       := qstr(r, "q")

		where, args, _, err := eodBuildWhere(dateFrom, dateTo, branch, product, txnType, sign, q)
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}

		ctx := r.Context()
		kpiRows, err := db.PGQuery(ctx, fmt.Sprintf(`
			SELECT
				COUNT(*)                                                 AS txn_count,
				COUNT(DISTINCT txn_date)                                 AS days_covered,
				COUNT(DISTINCT account_no)                               AS active_accounts,
				COUNT(DISTINCT cif)                                      AS active_cifs,
				COALESCE(SUM(CASE WHEN sign='DR' THEN amount END), 0)   AS total_dr,
				COALESCE(SUM(CASE WHEN sign='CR' THEN amount END), 0)   AS total_cr,
				COALESCE(SUM(amount), 0)                                 AS total_volume,
				COALESCE(AVG(amount), 0)                                 AS avg_txn_value
			FROM eod_transactions WHERE %s`, where), args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}

		kpi := map[string]any{}
		if len(kpiRows) > 0 {
			kpi = kpiRows[0]
		}

		// net_movement = CR - DR
		tdr, _ := kpi["total_dr"].(float64)
		tcr, _ := kpi["total_cr"].(float64)
		kpi["net_movement"] = tcr - tdr

		branchRows, _ := db.PGQuery(ctx, fmt.Sprintf(
			"SELECT DISTINCT branch_code, branch_name FROM eod_transactions WHERE %s ORDER BY 1", where), args...)
		prodRows, _ := db.PGQuery(ctx, fmt.Sprintf(
			"SELECT DISTINCT product_code, product_name FROM eod_transactions WHERE %s ORDER BY 1", where), args...)

		kpi["branches"] = branchRows
		kpi["products"] = prodRows

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(kpi) //nolint:errcheck
	}
}

// ── By-product ────────────────────────────────────────────────────────────────

func eodByProduct(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dateFrom := qstr(r, "date_from")
		dateTo := qstr(r, "date_to")
		if dateFrom == "" || dateTo == "" {
			respondErr(w, 422, "date_from and date_to are required")
			return
		}
		where, args, _, err := eodBuildWhere(dateFrom, dateTo, qstr(r, "branch"), "", qstr(r, "txn_type"), qstr(r, "sign"), "")
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT product_code, product_name,
				COUNT(*)                                              AS txn_count,
				COALESCE(SUM(CASE WHEN sign='DR' THEN amount END),0) AS total_dr,
				COALESCE(SUM(CASE WHEN sign='CR' THEN amount END),0) AS total_cr,
				COALESCE(SUM(amount),0)                              AS total_volume
			FROM eod_transactions WHERE %s
			GROUP BY product_code, product_name ORDER BY total_volume DESC`, where), args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		jsonRows(w, rows)
	}
}

// ── By-type ───────────────────────────────────────────────────────────────────

func eodByType(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dateFrom := qstr(r, "date_from")
		dateTo := qstr(r, "date_to")
		if dateFrom == "" || dateTo == "" {
			respondErr(w, 422, "date_from and date_to are required")
			return
		}
		where, args, _, err := eodBuildWhere(dateFrom, dateTo, qstr(r, "branch"), qstr(r, "product"), "", qstr(r, "sign"), "")
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT txn_category,
				COUNT(*)                                              AS txn_count,
				COALESCE(SUM(CASE WHEN sign='DR' THEN amount END),0) AS total_dr,
				COALESCE(SUM(CASE WHEN sign='CR' THEN amount END),0) AS total_cr,
				COALESCE(SUM(amount),0)                              AS total_volume
			FROM eod_transactions WHERE %s
			GROUP BY txn_category ORDER BY total_volume DESC`, where), args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		jsonRows(w, rows)
	}
}

// ── By-branch ─────────────────────────────────────────────────────────────────

func eodByBranch(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dateFrom := qstr(r, "date_from")
		dateTo := qstr(r, "date_to")
		if dateFrom == "" || dateTo == "" {
			respondErr(w, 422, "date_from and date_to are required")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT branch_code, branch_name,
				COUNT(*)                                              AS txn_count,
				COUNT(DISTINCT account_no)                           AS accounts,
				COALESCE(SUM(CASE WHEN sign='DR' THEN amount END),0) AS total_dr,
				COALESCE(SUM(CASE WHEN sign='CR' THEN amount END),0) AS total_cr
			FROM eod_transactions
			WHERE txn_date >= $1::date AND txn_date <= $2::date
			GROUP BY branch_code, branch_name ORDER BY total_dr DESC`,
			dateFrom, dateTo)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		jsonRows(w, rows)
	}
}

// ── Daily trend ───────────────────────────────────────────────────────────────

func eodTrend(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dateFrom := qstr(r, "date_from")
		dateTo := qstr(r, "date_to")
		if dateFrom == "" || dateTo == "" {
			respondErr(w, 422, "date_from and date_to are required")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT
				txn_date,
				TO_CHAR(txn_date, 'DD Mon') AS label,
				COUNT(*)                                              AS txn_count,
				COALESCE(SUM(CASE WHEN sign='DR' THEN amount END),0) AS total_dr,
				COALESCE(SUM(CASE WHEN sign='CR' THEN amount END),0) AS total_cr,
				COALESCE(SUM(amount),0)                              AS total_volume
			FROM eod_transactions
			WHERE txn_date >= $1::date AND txn_date <= $2::date
			GROUP BY txn_date ORDER BY txn_date`,
			dateFrom, dateTo)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		jsonRows(w, rows)
	}
}

// ── Transaction table ─────────────────────────────────────────────────────────

func eodTransactions(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dateFrom := qstr(r, "date_from")
		dateTo := qstr(r, "date_to")
		if dateFrom == "" || dateTo == "" {
			respondErr(w, 422, "date_from and date_to are required")
			return
		}
		branch  := qstr(r, "branch")
		product := qstr(r, "product")
		txnType := qstr(r, "txn_type")
		sign    := qstr(r, "sign")
		q       := qstr(r, "q")
		limit   := qint(r, "limit", 200, 1, 2000)
		offset  := qint(r, "offset", 0, 0, 1<<30)

		where, args, n, err := eodBuildWhere(dateFrom, dateTo, branch, product, txnType, sign, q)
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}

		ctx := r.Context()
		countRows, _ := db.PGQuery(ctx,
			fmt.Sprintf("SELECT COUNT(*) AS n FROM eod_transactions WHERE %s", where), args...)
		total := int64(0)
		if len(countRows) > 0 {
			total = toInt64(countRows[0]["n"])
		}

		pageArgs := append(append([]any(nil), args...), limit, offset)
		rows, err := db.PGQuery(ctx, fmt.Sprintf(`
			SELECT id, txn_date, branch_code, branch_name,
			       product_code, product_name, account_no, cif, customer,
			       balance, arrears, loc,
			       trace_num, auth_num, card_num, txn_code, txn_category,
			       amount, sign, currency, merchant_id, merchant_name, description
			FROM eod_transactions WHERE %s
			ORDER BY txn_date DESC, amount DESC
			LIMIT $%d OFFSET $%d`, where, n, n+1), pageArgs...)
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

func eodTransactionsExport(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dateFrom := qstr(r, "date_from")
		dateTo := qstr(r, "date_to")
		if dateFrom == "" || dateTo == "" {
			respondErr(w, 422, "date_from and date_to are required")
			return
		}
		where, args, _, err := eodBuildWhere(
			dateFrom, dateTo,
			qstr(r, "branch"), qstr(r, "product"), qstr(r, "txn_type"), qstr(r, "sign"), qstr(r, "q"))
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}

		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT txn_date, branch_name, product_name, account_no, cif, customer,
			       trace_num, auth_num, card_num, txn_code, txn_category,
			       amount, sign, currency, merchant_name, description, balance, arrears
			FROM eod_transactions WHERE %s
			ORDER BY txn_date DESC, amount DESC`, where), args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}

		label := dateFrom + "_" + dateTo
		w.Header().Set("Content-Type", "text/csv")
		w.Header().Set("Content-Disposition", `attachment; filename="eod_`+label+`.csv"`)

		cw := csv.NewWriter(w)
		cw.Write([]string{ //nolint:errcheck
			"Date", "Branch", "Product", "Account No", "CIF", "Customer",
			"Trace #", "Auth #", "Card", "Txn Code", "Category",
			"Amount", "DR/CR", "Currency", "Merchant", "Description", "Balance", "Arrears",
		})
		cols := []string{
			"txn_date", "branch_name", "product_name", "account_no", "cif", "customer",
			"trace_num", "auth_num", "card_num", "txn_code", "txn_category",
			"amount", "sign", "currency", "merchant_name", "description", "balance", "arrears",
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

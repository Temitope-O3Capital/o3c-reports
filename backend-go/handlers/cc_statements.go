package handlers

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// ── Public registration ───────────────────────────────────────────────────────

func RegisterCCStatements(r chi.Router, db *core.DB) {
	access := core.RequirePages("statements", "reports", "cards")
	r.With(access).Get("/", ccList(db))
	r.With(access).Post("/upload", ccUpload(db))
	r.With(access).Post("/bulk", ccBulk(db))
	r.With(access).Post("/from-db", ccFromDB(db))
	registerCCTemplateRoutes(r, db)   // /{id}/render, /{id}/send
	r.With(access).Get("/{id}", ccDetail(db))
}

// ── Parsed data structures ────────────────────────────────────────────────────

type ccHeader struct {
	CustomerName    string
	CustomerAddress string
	AccountNumber   string
	StatementDate   time.Time
	PaymentDueDate  time.Time
	LineOfCredit    int64
	OpeningBalance  int64
	TotalDebit      int64
	TotalCredit     int64
	ClosingBalance  int64
	MinPayment      int64
	FinanceCharge   int64
}

type ccTxn struct {
	CardPAN         string
	TxnDate         time.Time
	PostingDate     time.Time
	TraceNo         string
	Description     string
	DebitKobo       int64
	CreditKobo      int64
	IsFinanceCharge bool
	Seq             int
}

// ── Text parser ───────────────────────────────────────────────────────────────

var (
	// Matches MM/DD/YY or MM/DD/YYYY at start of a line
	reTxnLine = regexp.MustCompile(`^(\d{2}/\d{2}/\d{2,4})\s+(\d{2}/\d{2}/\d{2,4})\s+(\d+)\s+(.+?)\s{2,}([\d,]+\.\d{2})?\s*([\d,]+\.\d{2})?\s*$`)
	// Finance charge lines: no leading dates, just description + amount
	reFinanceLine = regexp.MustCompile(`(?i)finance\s+charge\s+([\d,]+\.\d{2})`)
	// Card PAN line
	reCardPAN = regexp.MustCompile(`(?i)card#\s*(\S+)`)
	// Header key-value: e.g. "Account Number      000108531566"
	reHeaderKV = regexp.MustCompile(`^(.+?)\s{3,}(.+?)\s*$`)
	// Amounts with commas: 1,234,567.89
	reAmount = regexp.MustCompile(`[\d,]+\.\d{2}`)
)

// parseAmount converts "1,234,567.89" → kobo (int64).
func parseAmount(s string) int64 {
	s = strings.ReplaceAll(strings.TrimSpace(s), ",", "")
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0
	}
	return int64(math.Round(f * 100))
}

// parseDate handles MM/DD/YY and MM/DD/YYYY.
func parseDate(s string) time.Time {
	for _, layout := range []string{"01/02/2006", "01/02/06"} {
		if t, err := time.Parse(layout, strings.TrimSpace(s)); err == nil {
			return t
		}
	}
	return time.Time{}
}

// extractAmountsByColumn uses the column positions of the Dr/Cr header to correctly
// classify a transaction line's amounts. Numbers are right-aligned, so a credit
// amount can START before the midpoint between the two headers even though it
// clearly belongs to the Cr column. We therefore classify by the END position of
// the amount rather than its start — a number whose right edge falls before the
// midpoint is a debit; one whose right edge falls at or after the midpoint is a credit.
func extractAmountsByColumn(line string, drCol, crCol int) (drKobo, crKobo int64) {
	mid := (drCol + crCol) / 2
	// Search from 15 chars before drCol (amounts may start before header position).
	searchFrom := drCol - 15
	if searchFrom < 0 {
		searchFrom = 0
	}
	if searchFrom >= len(line) {
		return
	}
	suffix := line[searchFrom:]
	for _, loc := range reAmount.FindAllStringIndex(suffix, -1) {
		absEnd := searchFrom + loc[1]
		if absEnd <= mid {
			drKobo = parseAmount(suffix[loc[0]:loc[1]])
		} else {
			crKobo = parseAmount(suffix[loc[0]:loc[1]])
		}
	}
	return
}

// parseStatementText parses the fixed-format credit-card statement text file.
func parseStatementText(text string) (ccHeader, []ccTxn, error) {
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")

	var h ccHeader
	var txns []ccTxn

	// ── Phase 1: Header section ──────────────────────────────────────────────
	// First non-empty line = customer name.
	// Subsequent non-empty lines until the key-value block = address.
	// Key-value block detected when a line has 3+ spaces separating key from value.
	// Header ends when we hit the transaction table header ("Txn Date").

	inHeader := true
	nameSet := false
	var addrLines []string
	inTxnSection := false
	currentCardPAN := ""
	seq := 0
	// Column positions of Amount(Dr) and Amount(Cr) in the header row.
	// Used to correctly classify amounts when only one is present per line.
	drCol, crCol := -1, -1

	for _, raw := range lines {
		line := raw // preserve spacing for column detection

		if inHeader {
			trimmed := strings.TrimSpace(line)
			if trimmed == "" {
				continue
			}

			// Detect transaction table header — record Dr/Cr column positions.
			if strings.HasPrefix(strings.ToLower(trimmed), "txn date") {
				inHeader = false
				inTxnSection = true
				lineLower := strings.ToLower(line)
				drCol = strings.Index(lineLower, "amount(dr)")
				crCol = strings.Index(lineLower, "amount(cr)")
				continue
			}

			// Try key-value header pair
			if m := reHeaderKV.FindStringSubmatch(trimmed); m != nil {
				key := strings.ToLower(strings.TrimSpace(m[1]))
				val := strings.TrimSpace(m[2])

				switch {
				case strings.Contains(key, "account number"):
					h.AccountNumber = val
				case strings.Contains(key, "statement date"):
					h.StatementDate = parseDate(val)
				case strings.Contains(key, "payment due"):
					h.PaymentDueDate = parseDate(val)
				case strings.Contains(key, "line of credit"):
					h.LineOfCredit = parseAmount(val)
				case strings.Contains(key, "opening balance"):
					h.OpeningBalance = parseAmount(val)
				case strings.Contains(key, "total debit"):
					h.TotalDebit = parseAmount(val)
				case strings.Contains(key, "total credit"):
					h.TotalCredit = parseAmount(val)
				case strings.Contains(key, "closing balance"):
					h.ClosingBalance = parseAmount(val)
				case strings.Contains(key, "minimum payment"):
					h.MinPayment = parseAmount(val)
				}
				continue
			}

			// Otherwise it's customer name or address
			if !nameSet {
				h.CustomerName = trimmed
				nameSet = true
			} else {
				addrLines = append(addrLines, trimmed)
			}
			continue
		}

		// ── Phase 2: Transaction section ──────────────────────────────────────
		if !inTxnSection {
			continue
		}

		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}

		// Card PAN line
		if m := reCardPAN.FindStringSubmatch(trimmed); m != nil {
			currentCardPAN = m[1]
			continue
		}

		// Sub-total / total lines — skip
		lower := strings.ToLower(trimmed)
		if strings.Contains(lower, "sub total") || strings.Contains(lower, "total cycle") {
			continue
		}

		// Finance charge line (no leading date)
		if m := reFinanceLine.FindStringSubmatch(trimmed); m != nil {
			amt := parseAmount(m[1])
			if amt > 0 {
				h.FinanceCharge = amt
				seq++
				txns = append(txns, ccTxn{
					CardPAN:         currentCardPAN,
					Description:     "Finance Charge",
					DebitKobo:       amt,
					IsFinanceCharge: true,
					Seq:             seq,
				})
			}
			continue
		}

		// Standard transaction line: two dates at start
		if m := reTxnLine.FindStringSubmatch(line); m != nil {
			txnDate := parseDate(m[1])
			postDate := parseDate(m[2])
			traceNo := strings.TrimSpace(m[3])
			desc := strings.TrimSpace(m[4])

			var drKobo, crKobo int64
			if drCol > 0 && crCol > 0 && crCol > drCol {
				// Use column positions to correctly classify Dr vs Cr amounts.
				drKobo, crKobo = extractAmountsByColumn(line, drCol, crCol)
			} else {
				a5 := parseAmount(strings.TrimSpace(m[5]))
				a6 := parseAmount(strings.TrimSpace(m[6]))
				if a6 > 0 {
					// Two amounts: left group = debit, right group = credit.
					drKobo, crKobo = a5, a6
				} else {
					// Single amount — the regex can't distinguish Dr vs Cr column.
					// Classify by description: payments/refunds/credits go to Cr;
					// everything else (purchases, withdrawals, fees) goes to Dr.
					descLow := strings.ToLower(desc)
					if strings.Contains(descLow, "payment") ||
						strings.Contains(descLow, "refund") ||
						strings.Contains(descLow, "reversal") ||
						strings.Contains(descLow, "chargeback") ||
						strings.Contains(descLow, "credit") {
						crKobo = a5
					} else {
						drKobo = a5
					}
				}
			}

			seq++
			txns = append(txns, ccTxn{
				CardPAN:     currentCardPAN,
				TxnDate:     txnDate,
				PostingDate: postDate,
				TraceNo:     traceNo,
				Description: desc,
				DebitKobo:   drKobo,
				CreditKobo:  crKobo,
				Seq:         seq,
			})
			continue
		}

		// Fallback: line starts with a date but didn't match the full regex
		// (some files have inconsistent spacing) — try a looser parse
		parts := strings.Fields(trimmed)
		if len(parts) >= 4 {
			d1 := parseDate(parts[0])
			d2 := parseDate(parts[1])
			if !d1.IsZero() && !d2.IsZero() {
				var drKobo, crKobo int64
				var descEnd int
				if drCol > 0 && crCol > 0 && crCol > drCol {
					// Prefer column-based extraction when we know the header positions.
					drKobo, crKobo = extractAmountsByColumn(line, drCol, crCol)
					// Description = everything from part[3] up to the Dr column.
					descEnd = len(parts)
					for i := len(parts) - 1; i >= 3; i-- {
						if reAmount.MatchString(parts[i]) {
							descEnd = i
						} else {
							break
						}
					}
				} else {
					// last 1 or 2 tokens should be amounts
					descEnd = len(parts)
					for i := len(parts) - 1; i >= 3; i-- {
						if reAmount.MatchString(parts[i]) {
							if crKobo == 0 && drKobo == 0 {
								crKobo = parseAmount(parts[i])
							} else {
								drKobo = crKobo
								crKobo = parseAmount(parts[i])
							}
							descEnd = i
						} else {
							break
						}
					}
					// heuristic: "transfer out" lines are debits
					if drKobo == 0 && crKobo > 0 && strings.Contains(strings.ToLower(trimmed), "transfer out") {
						drKobo = crKobo
						crKobo = 0
					}
				}
				desc := strings.Join(parts[3:descEnd], " ")
				traceNo := ""
				if len(parts) > 2 {
					traceNo = parts[2]
				}
				seq++
				txns = append(txns, ccTxn{
					CardPAN:     currentCardPAN,
					TxnDate:     d1,
					PostingDate: d2,
					TraceNo:     traceNo,
					Description: desc,
					DebitKobo:   drKobo,
					CreditKobo:  crKobo,
					Seq:         seq,
				})
			}
		}
	}

	h.CustomerAddress = strings.Join(addrLines, ", ")

	if h.AccountNumber == "" && h.CustomerName == "" {
		return h, nil, fmt.Errorf("could not parse statement: no account number or customer name found")
	}

	return h, txns, nil
}

// ── DB save helpers ───────────────────────────────────────────────────────────

func saveCCStatement(ctx interface{ Deadline() (time.Time, bool); Done() <-chan struct{}; Err() error; Value(interface{}) interface{} },
	db *core.DB, h ccHeader, txns []ccTxn, source, filename string, userID int64) (int64, error) {

	rows, err := db.PGQuery(ctx, `
		INSERT INTO cc_statements
			(customer_name, customer_address, account_number, statement_date, payment_due_date,
			 line_of_credit_kobo, opening_balance_kobo, total_debit_kobo, total_credit_kobo,
			 closing_balance_kobo, min_payment_kobo, finance_charge_kobo,
			 source, source_filename, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
		RETURNING id`,
		h.CustomerName, h.CustomerAddress, h.AccountNumber,
		ccNullTime(h.StatementDate), ccNullTime(h.PaymentDueDate),
		ccNullI64(h.LineOfCredit), h.OpeningBalance,
		h.TotalDebit, h.TotalCredit, h.ClosingBalance,
		ccNullI64(h.MinPayment), ccNullI64(h.FinanceCharge),
		source, ccNullStr(filename), userID,
	)
	if err != nil {
		return 0, err
	}
	if len(rows) == 0 {
		return 0, fmt.Errorf("insert returned no id")
	}
	stmtID := toInt64(rows[0]["id"])

	for _, t := range txns {
		_, err := db.PGExec(ctx, `
			INSERT INTO cc_transactions
				(statement_id, card_pan, txn_date, posting_date, trace_no,
				 description, debit_kobo, credit_kobo, is_finance_charge, seq)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
			stmtID,
			ccNullStr(t.CardPAN),
			ccNullTime(t.TxnDate),
			ccNullTime(t.PostingDate),
			ccNullStr(t.TraceNo),
			t.Description,
			t.DebitKobo,
			t.CreditKobo,
			t.IsFinanceCharge,
			t.Seq,
		)
		if err != nil {
			return stmtID, fmt.Errorf("insert transaction seq %d: %w", t.Seq, err)
		}
	}
	return stmtID, nil
}

func ccNullTime(t time.Time) interface{} {
	if t.IsZero() {
		return nil
	}
	return t
}
func ccNullI64(v int64) interface{} {
	if v == 0 {
		return nil
	}
	return v
}
func ccNullStr(s string) interface{} {
	if s == "" {
		return nil
	}
	return s
}

// ── Route handlers ────────────────────────────────────────────────────────────

// GET /api/cc-statements
func ccList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		q := `SELECT s.id, s.customer_name, s.account_number, s.statement_date,
			         s.payment_due_date, s.line_of_credit_kobo,
			         s.opening_balance_kobo, s.total_debit_kobo, s.total_credit_kobo,
			         s.closing_balance_kobo, s.min_payment_kobo, s.finance_charge_kobo,
			         s.source, s.source_filename, s.created_at,
			         u.full_name AS created_by_name,
			         COUNT(t.id) AS txn_count
			  FROM cc_statements s
			  LEFT JOIN o3c_users u ON u.id = s.created_by
			  LEFT JOIN cc_transactions t ON t.statement_id = s.id`

		var wheres []string
		var args []interface{}
		n := 1

		if v := r.URL.Query().Get("account_number"); v != "" {
			wheres = append(wheres, fmt.Sprintf("s.account_number ILIKE $%d", n))
			args = append(args, "%"+v+"%")
			n++
		}
		if v := r.URL.Query().Get("source"); v != "" {
			wheres = append(wheres, fmt.Sprintf("s.source = $%d", n))
			args = append(args, v)
			n++
		}
		if v := r.URL.Query().Get("date_from"); v != "" {
			wheres = append(wheres, fmt.Sprintf("s.statement_date >= $%d", n))
			args = append(args, v)
			n++
		}
		if v := r.URL.Query().Get("date_to"); v != "" {
			wheres = append(wheres, fmt.Sprintf("s.statement_date <= $%d", n))
			args = append(args, v)
			n++
		}
		if v := r.URL.Query().Get("from"); v != "" {
			wheres = append(wheres, fmt.Sprintf("s.created_at::date >= $%d::date", n))
			args = append(args, v)
			n++
		}
		if v := r.URL.Query().Get("to"); v != "" {
			wheres = append(wheres, fmt.Sprintf("s.created_at::date <= $%d::date", n))
			args = append(args, v)
			n++
		}
		if len(wheres) > 0 {
			q += " WHERE " + strings.Join(wheres, " AND ")
		}
		q += " GROUP BY s.id, u.full_name ORDER BY s.created_at DESC LIMIT 500"

		rows, err := db.PGQuery(ctx, q, args...)
		if err != nil {
			respondErr(w, 500, "query failed")
			return
		}
		respond(w, rows, "pg")
	}
}

// GET /api/cc-statements/{id}
func ccDetail(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		id := chi.URLParam(r, "id")

		stmts, err := db.PGQuery(ctx, `
			SELECT s.*, u.full_name AS created_by_name
			FROM cc_statements s
			LEFT JOIN o3c_users u ON u.id = s.created_by
			WHERE s.id = $1`, id)
		if err != nil {
			respondErr(w, 500, "db error: "+err.Error())
			return
		}
		if len(stmts) == 0 {
			respondErr(w, 404, "statement not found")
			return
		}

		txns, err := db.PGQuery(ctx, `
			SELECT * FROM cc_transactions
			WHERE statement_id = $1
			ORDER BY seq, id`, id)
		if err != nil {
			respondErr(w, 500, "query failed")
			return
		}

		respond(w, map[string]any{
			"statement":    stmts[0],
			"transactions": txns,
		}, "pg")
	}
}

// POST /api/cc-statements/upload  (single file)
func ccUpload(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(r.Context())

		if err := r.ParseMultipartForm(8 << 20); err != nil {
			respondErr(w, 400, "parse form: "+err.Error())
			return
		}

		file, header, err := r.FormFile("file")
		if err != nil {
			respondErr(w, 400, "missing file field")
			return
		}
		defer file.Close()

		data, err := io.ReadAll(file)
		if err != nil {
			respondErr(w, 400, "read file: "+err.Error())
			return
		}

		hdr, txns, err := parseStatementText(string(data))
		if err != nil {
			respondErr(w, 422, "parse error: "+err.Error())
			return
		}

		// preview=true → return parsed data without saving
		if r.FormValue("preview") == "true" {
			respond(w, map[string]any{"header": hdr, "transactions": txns}, "parsed")
			return
		}

		stmtID, err := saveCCStatement(ctx, db, hdr, txns, "upload", header.Filename, user.ID)
		if err != nil {
			respondErr(w, 500, "save failed: "+err.Error())
			return
		}

		respond(w, map[string]any{"id": stmtID, "txn_count": len(txns)}, "pg")
	}
}

// POST /api/cc-statements/bulk  (multiple files, multipart)
func ccBulk(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(r.Context())

		if err := r.ParseMultipartForm(64 << 20); err != nil { // 64 MB cap for bulk
			respondErr(w, 400, "parse form: "+err.Error())
			return
		}

		files := r.MultipartForm.File["files"]
		if len(files) == 0 {
			respondErr(w, 400, "no files uploaded (field name: files)")
			return
		}

		type result struct {
			Filename string `json:"filename"`
			ID       int64  `json:"id,omitempty"`
			TxnCount int    `json:"txn_count,omitempty"`
			Error    string `json:"error,omitempty"`
			OK       bool   `json:"ok"`
		}

		var results []result
		succeeded, failed := 0, 0

		for _, fh := range files {
			f, err := fh.Open()
			if err != nil {
				results = append(results, result{Filename: fh.Filename, Error: "open: " + err.Error()})
				failed++
				continue
			}

			data, err := io.ReadAll(f)
			f.Close()
			if err != nil {
				results = append(results, result{Filename: fh.Filename, Error: "read: " + err.Error()})
				failed++
				continue
			}

			hdr, txns, err := parseStatementText(string(data))
			if err != nil {
				results = append(results, result{Filename: fh.Filename, Error: "parse: " + err.Error()})
				failed++
				continue
			}

			stmtID, err := saveCCStatement(ctx, db, hdr, txns, "upload", fh.Filename, user.ID)
			if err != nil {
				slog.Error("cc bulk save failed", "file", fh.Filename, "err", err)
				results = append(results, result{Filename: fh.Filename, Error: "save: " + err.Error()})
				failed++
				continue
			}

			results = append(results, result{Filename: fh.Filename, ID: stmtID, TxnCount: len(txns), OK: true})
			succeeded++
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"total":     len(files),
			"succeeded": succeeded,
			"failed":    failed,
			"results":   results,
		})
	}
}

// POST /api/cc-statements/from-db
// Body: { cif, account_number, customer_name, date_from, date_to,
//         line_of_credit_kobo, opening_balance_kobo, payment_due_date }
func ccFromDB(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(r.Context())

		var req struct {
			CIF               string `json:"cif"`
			AccountNumber     string `json:"account_number"`
			CustomerName      string `json:"customer_name"`
			DateFrom          string `json:"date_from"`
			DateTo            string `json:"date_to"`
			LineOfCreditKobo  int64  `json:"line_of_credit_kobo"`
			OpeningBalKobo    int64  `json:"opening_balance_kobo"`
			PaymentDueDate    string `json:"payment_due_date"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondErr(w, 400, "invalid JSON")
			return
		}
		if req.CIF == "" && req.AccountNumber == "" {
			respondErr(w, 400, "cif or account_number is required")
			return
		}
		if req.DateFrom == "" || req.DateTo == "" {
			respondErr(w, 400, "date_from and date_to are required")
			return
		}

		// Query existing transaction tables (dual-source: MSSQL + PG)
		cifFilter := req.CIF
		if cifFilter == "" {
			cifFilter = req.AccountNumber
		}

		msSQL := fmt.Sprintf(`
			SELECT Transaction_Date AS txn_date, Transaction_Date AS posting_date,
			       '' AS trace_no, Description AS description,
			       CASE WHEN Amount > 0 THEN Amount ELSE 0 END AS debit,
			       CASE WHEN Amount < 0 THEN ABS(Amount) ELSE 0 END AS credit
			FROM dbo.Transaction_Listing
			WHERE CIF = '%s' AND Transaction_Date BETWEEN '%s' AND '%s'
			ORDER BY Transaction_Date`, cifFilter, req.DateFrom, req.DateTo)

		pgSQL := fmt.Sprintf(`
			SELECT "Transaction Date" AS txn_date, "Transaction Date" AS posting_date,
			       '' AS trace_no, "Description" AS description,
			       CASE WHEN "Amount" > 0 THEN "Amount" ELSE 0 END AS debit,
			       CASE WHEN "Amount" < 0 THEN ABS("Amount") ELSE 0 END AS credit
			FROM "Transactions"
			WHERE "CIF Number" = '%s' AND "Transaction Date" BETWEEN '%s' AND '%s'
			ORDER BY "Transaction Date"`, cifFilter, req.DateFrom, req.DateTo)

		rows, _, err := db.DualQuery(ctx, msSQL, pgSQL)
		if err != nil {
			respondErr(w, 500, "query failed: "+err.Error())
			return
		}

		// Build ccTxns from DB rows
		var txns []ccTxn
		var totalDebit, totalCredit int64
		for i, row := range rows {
			debitKobo := int64(math.Round(toFloat(row["debit"]) * 100))
			creditKobo := int64(math.Round(toFloat(row["credit"]) * 100))
			desc := str(row["description"])
			if desc == "" {
				desc = str(row["Description"])
			}

			txns = append(txns, ccTxn{
				TxnDate:     toTime(row["txn_date"]),
				PostingDate: toTime(row["posting_date"]),
				TraceNo:     str(row["trace_no"]),
				Description: desc,
				DebitKobo:   debitKobo,
				CreditKobo:  creditKobo,
				Seq:         i + 1,
			})
			totalDebit += debitKobo
			totalCredit += creditKobo
		}

		// Build header
		stmtDateParsed := parseDate(req.DateTo)
		var dueDateParsed time.Time
		if req.PaymentDueDate != "" {
			dueDateParsed = parseDate(req.PaymentDueDate)
		}

		h := ccHeader{
			CustomerName:   req.CustomerName,
			AccountNumber:  req.AccountNumber,
			StatementDate:  stmtDateParsed,
			PaymentDueDate: dueDateParsed,
			LineOfCredit:   req.LineOfCreditKobo,
			OpeningBalance: req.OpeningBalKobo,
			TotalDebit:     totalDebit,
			TotalCredit:    totalCredit,
			ClosingBalance: req.OpeningBalKobo + totalDebit - totalCredit,
		}

		stmtID, err := saveCCStatement(ctx, db, h, txns, "db", "", user.ID)
		if err != nil {
			respondErr(w, 500, "save failed: "+err.Error())
			return
		}

		respond(w, map[string]any{
			"id":        stmtID,
			"txn_count": len(txns),
			"totals": map[string]any{
				"total_debit_kobo":     totalDebit,
				"total_credit_kobo":    totalCredit,
				"closing_balance_kobo": h.ClosingBalance,
			},
		}, "pg")
	}
}

// ── helpers ───────────────────────────────────────────────────────────────────

func toTime(v interface{}) time.Time {
	if v == nil {
		return time.Time{}
	}
	switch t := v.(type) {
	case time.Time:
		return t
	case string:
		return parseDate(t)
	}
	return time.Time{}
}

// scanLines is a helper for testing; keep it unexported.
func scanLines(text string) []string {
	var out []string
	sc := bufio.NewScanner(strings.NewReader(text))
	for sc.Scan() {
		out = append(out, sc.Text())
	}
	return out
}

package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// RegisterFinance mounts the Finance module API. Finance is a read-only
// *reporting* surface: it summarises income, fixed-deposit and treasury
// positions derived from other modules' data. It performs no financial
// actions — GL postings live in the shared GL engine, manual journals in the
// Settlements module, and P&L / Budget / Cost Tracking / Chart of Accounts
// were retired. Every route below is therefore a GET; no mutations belong here.
func RegisterFinance(r chi.Router, db *core.DB) {
	access := core.RequirePages("finance", "income")

	// Income reporting (derived from card-cycle and loan data)
	r.With(access).Get("/income",           finIncomeList(db))
	r.With(access).Get("/income/chart",     finIncomeChart(db))
	r.With(access).Get("/income/loans",     finIncomeLoans(db))
	r.With(access).Get("/income/fee-types", finIncomeFeeTypes(db))
	r.With(access).Get("/income/summary",   finIncomeSummary(db))

	// Fixed-deposit reporting (derived from fd_transactions)
	r.With(access).Get("/fd-accrual", finFDAccrual(db)) // per-FD daily interest accrual
	r.With(access).Get("/fd-kpis",    finFDKPIs(db))    // headline FD metrics

	// Treasury & transaction reporting (derived from EOD + FD positions)
	r.With(access).Get("/treasury",         finTreasury(db))
	r.With(access).Get("/transaction-kpis", finTransactionKPIs(db))

	// My Dashboard — the finance desk's personal station
	r.With(access).Get("/my-dashboard", finMyDashboard(db))
}

// finMyDashboard — the finance desk station: cash position, today's EOD load
// status, income month-to-date, the fixed-deposit register and maturities coming
// due. Every query is defensive; a missing table simply omits that field.
func finMyDashboard(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		dash := map[string]any{}

		// Cash position — net EOD (CR − DR) over the last 30 days
		if rows, _ := db.PGQuery(ctx, `
			SELECT COALESCE(SUM(amount) FILTER (WHERE sign='CR'), 0)
			     - COALESCE(SUM(amount) FILTER (WHERE sign='DR'), 0) AS net
			FROM eod_transactions WHERE txn_date >= CURRENT_DATE - INTERVAL '30 days'`); len(rows) > 0 {
			dash["cash_position_kobo"] = rows[0]["net"]
		}

		// EOD load status — is today's file in, and the recent run list
		if rows, _ := db.PGQuery(ctx, `SELECT txn_date, txn_count FROM eod_uploads ORDER BY txn_date DESC LIMIT 1`); len(rows) > 0 {
			dash["eod_last_date"] = rows[0]["txn_date"]
			dash["eod_last_count"] = rows[0]["txn_count"]
		}
		if rows, _ := db.PGQuery(ctx, `SELECT COUNT(*) AS count FROM eod_uploads WHERE txn_date = CURRENT_DATE`); len(rows) > 0 {
			dash["eod_today_loaded"] = toInt64(rows[0]["count"]) > 0
		}
		recent, _ := db.PGQuery(ctx, `SELECT txn_date, filename, txn_count, uploaded_at FROM eod_uploads ORDER BY txn_date DESC LIMIT 8`)
		if recent == nil {
			recent = []core.Row{}
		}
		dash["recent_uploads"] = recent

		// Income month-to-date (card cycle interest + fees + penalty)
		if rows, _ := db.PGQuery(ctx, `
			SELECT COALESCE(SUM(interest_charged_kobo + fees_kobo + penalty_kobo), 0) AS income
			FROM card_cycle_data WHERE DATE_TRUNC('month', cycle_date) = DATE_TRUNC('month', CURRENT_DATE)`); len(rows) > 0 {
			dash["income_mtd_kobo"] = rows[0]["income"]
		}

		// Fixed-deposit register + maturities coming due
		if rows, _ := db.PGQuery(ctx, `
			SELECT
			    COUNT(*) FILTER (WHERE maturity_date >= CURRENT_DATE)                                       AS active,
			    COALESCE(SUM(principal_kobo) FILTER (WHERE maturity_date >= CURRENT_DATE), 0)               AS principal,
			    COUNT(*) FILTER (WHERE DATE_TRUNC('month', maturity_date) = DATE_TRUNC('month', CURRENT_DATE)) AS matured_month,
			    COUNT(*) FILTER (WHERE maturity_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days') AS maturing_7d,
			    COALESCE(SUM(principal_kobo) FILTER (WHERE maturity_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'), 0) AS maturing_7d_kobo
			FROM cbs_fixed_deposits`); len(rows) > 0 {
			dash["fd_active"] = rows[0]["active"]
			dash["fd_principal_kobo"] = rows[0]["principal"]
			dash["fd_matured_this_month"] = rows[0]["matured_month"]
			dash["fd_maturing_7d"] = rows[0]["maturing_7d"]
			dash["fd_maturing_7d_kobo"] = rows[0]["maturing_7d_kobo"]
		}
		maturities, _ := db.PGQuery(ctx, `
			SELECT
			    COALESCE((SELECT NULLIF(trim(a.first_name||' '||COALESCE(a.last_name,'')),'')
			              FROM app.customers a WHERE a.cif = cf.cbs_customer_id LIMIT 1),
			             cf.raw->>'name') AS customer_name,
			    cf.principal_kobo, cf.maturity_date, cf.interest_rate
			FROM cbs_fixed_deposits cf
			WHERE cf.maturity_date >= CURRENT_DATE AND cf.principal_kobo IS NOT NULL AND cf.principal_kobo > 0
			ORDER BY cf.maturity_date ASC LIMIT 8`)
		if maturities == nil {
			maturities = []core.Row{}
		}
		dash["upcoming_maturities"] = maturities

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(dash) //nolint:errcheck
	}
}

/* ── Treasury ────────────────────────────────────────────────────────────── */

func finTreasury(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// EOD net position as cash proxy
		eodRows, _ := db.PGQuery(r.Context(), `
			SELECT
			    COALESCE(SUM(amount) FILTER (WHERE sign='CR'), 0) AS total_cr,
			    COALESCE(SUM(amount) FILTER (WHERE sign='DR'), 0) AS total_dr,
			    COALESCE(SUM(amount) FILTER (WHERE sign='CR'), 0)
			    - COALESCE(SUM(amount) FILTER (WHERE sign='DR'), 0) AS net_position
			FROM eod_transactions
			WHERE txn_date >= CURRENT_DATE - INTERVAL '30 days'`)

		// FD outstanding as liability — live Udara/CBS register (principal + accrued).
		fdRows, _ := db.PGQuery(r.Context(), `
			SELECT
			    COALESCE(SUM(principal_kobo), 0)                                     AS fd_liabilities,
			    COALESCE(SUM(accrued_interest_kobo), 0)                              AS fd_paid_out,
			    COUNT(*) FILTER (WHERE maturity_date >= CURRENT_DATE)                AS active_fds
			FROM cbs_fixed_deposits`)

		cashPos, fdLiab := int64(0), int64(0)
		if len(eodRows) > 0 {
			cashPos = toInt64(eodRows[0]["net_position"])
		}
		if len(fdRows) > 0 {
			fdLiab = toInt64(fdRows[0]["fd_liabilities"])
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"cash_position":  cashPos,
			"fd_liabilities": fdLiab,
			"net_liquidity":  cashPos - fdLiab,
			"eod_summary":    eodRows,
			"fd_summary":     fdRows,
		})
	}
}

/* ── FD Accrual ──────────────────────────────────────────────────────────── */

func finFDAccrual(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		asOf, _ := validDate(r, "date")
		if asOf == "" {
			asOf = "CURRENT_DATE"
		} else {
			asOf = fmt.Sprintf("'%s'::date", asOf)
		}

		// Live CBS fixed-deposit register; accrued interest is carried by the record.
		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT
			    cf.cbs_id AS id,
			    COALESCE((SELECT NULLIF(trim(a.first_name||' '||COALESCE(a.last_name,'')),'')
			              FROM app.customers a WHERE a.cif = cf.cbs_customer_id LIMIT 1),
			             cf.raw->>'name') AS customer_name,
			    cf.principal_kobo AS principal,
			    cf.interest_rate AS rate,
			    cf.commencement_date AS start_date,
			    cf.maturity_date,
			    cf.tenor_days,
			    GREATEST(0, %s - cf.commencement_date::date) AS days_elapsed,
			    cf.accrued_interest_kobo,
			    ROUND(cf.principal_kobo::numeric * COALESCE(cf.interest_rate,0) / 100 / 365)::bigint AS daily_interest_kobo
			FROM cbs_fixed_deposits cf
			WHERE cf.maturity_date >= CURRENT_DATE
			  AND cf.principal_kobo IS NOT NULL AND cf.principal_kobo > 0
			ORDER BY cf.accrued_interest_kobo DESC`, asOf))
		if err != nil {
			respondErr(w, 500, "FD accrual query failed: "+err.Error())
			return
		}
		jsonRows(w, rows)
	}
}

/* ── FD KPIs ─────────────────────────────────────────────────────────────────
   Headline metrics for the Fixed Deposit page. Reads fd_transactions.
*/

func finFDKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Live Udara/CBS fixed-deposit register. Accrued interest is carried by the CBS
		// record directly (no per-day recompute needed).
		rows, err := db.PGQuery(r.Context(), `
			SELECT
			    COUNT(*)                                                                 AS total_fds,
			    COUNT(*) FILTER (WHERE maturity_date >= CURRENT_DATE)                     AS active_fds,
			    COALESCE(SUM(principal_kobo) FILTER (WHERE maturity_date >= CURRENT_DATE), 0) AS total_principal_kobo,
			    COALESCE(SUM(accrued_interest_kobo), 0)                                   AS total_interest_accrued_kobo,
			    COUNT(*) FILTER (WHERE DATE_TRUNC('month', maturity_date) = DATE_TRUNC('month', CURRENT_DATE)) AS matured_this_month,
			    COALESCE(AVG(tenor_days), 0)::bigint                                      AS avg_tenor_days,
			    COALESCE(ROUND(AVG(interest_rate)::numeric, 1), 0)                        AS avg_rate_pct
			FROM cbs_fixed_deposits`)
		if err != nil || len(rows) == 0 {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
				"total_fds": 0, "active_fds": 0,
				"total_principal_kobo": 0, "total_interest_accrued_kobo": 0,
				"matured_this_month": 0, "avg_tenor_days": 0, "avg_rate_pct": 0,
			})
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

/* ── Income ledger ────────────────────────────────────────────────────────────
   Flattens card_cycle_data into income line items per product per cycle.
   Each row: date, source (product name), type (Interest/Fees/Penalty), amount_kobo, ref.
   Filters: type, date_from, date_to.
*/

func finIncomeList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		typeFilter := qstr(r, "type")
		dateFrom   := qstr(r, "date_from")
		dateTo     := qstr(r, "date_to")
		limit      := qint(r, "limit", 200, 1, 1000)
		offset     := qint(r, "offset", 0, 0, 1<<30)

		dateWhere := "1=1"
		var dateArgs []any
		n := 1
		if dateFrom != "" {
			dateWhere += fmt.Sprintf(" AND d.cycle_date >= $%d::date", n)
			dateArgs = append(dateArgs, dateFrom); n++
		}
		if dateTo != "" {
			dateWhere += fmt.Sprintf(" AND d.cycle_date <= $%d::date", n)
			dateArgs = append(dateArgs, dateTo); n++
		}

		buildPart := func(incomeType, col string) string {
			return fmt.Sprintf(`
			SELECT
			  d.cycle_date                              AS date,
			  COALESCE(p.product_name, d.product_code) AS source,
			  '%s'                                      AS type,
			  SUM(d.%s)                                 AS amount_kobo,
			  d.product_code                            AS ref
			FROM card_cycle_data d
			LEFT JOIN card_products p ON p.product_code = d.product_code
			WHERE %s AND d.%s > 0
			GROUP BY d.cycle_date, p.product_name, d.product_code`, incomeType, col, dateWhere, col)
		}

		allTypes := []struct{ label, col string }{
			{"Interest", "interest_charged_kobo"},
			{"Fees",     "fees_kobo"},
			{"Penalty",  "penalty_kobo"},
		}

		var parts []string
		var partCount int
		for _, t := range allTypes {
			if typeFilter == "" || typeFilter == t.label {
				parts = append(parts, buildPart(t.label, t.col))
				partCount++
			}
		}

		// PostgreSQL $N placeholders are global to the whole query — each $1 in every
		// UNION branch refers to the same first argument. Do NOT duplicate dateArgs.
		args := make([]any, 0, len(dateArgs)+2)
		args = append(args, dateArgs...)
		args = append(args, limit, offset)

		finalSQL := fmt.Sprintf(`
			SELECT * FROM (%s) inc
			ORDER BY date DESC, amount_kobo DESC
			LIMIT $%d OFFSET $%d`, strings.Join(parts, " UNION ALL "), n, n+1)

		rows, err := db.PGQuery(r.Context(), finalSQL, args...)
		if err != nil {
			respondErr(w, 500, "income query failed: "+err.Error())
			return
		}
		jsonRows(w, rows)
	}
}

/* ── Income chart ─────────────────────────────────────────────────────────────
   Returns income by type comparing the two most recent cycle dates.
   Response: [{ type, current, previous }]
*/

func finIncomeChart(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dateRows, err := db.PGQuery(r.Context(),
			`SELECT DISTINCT TO_CHAR(cycle_date,'YYYY-MM-DD') AS d FROM card_cycle_data ORDER BY d DESC LIMIT 2`)
		if err != nil || len(dateRows) == 0 {
			respond(w, []map[string]any{}, "pg")
			return
		}
		current  := fmt.Sprintf("%v", dateRows[0]["d"])
		previous := ""
		if len(dateRows) > 1 {
			previous = fmt.Sprintf("%v", dateRows[1]["d"])
		}

		var prevArg any
		if previous != "" {
			prevArg = previous
		}
		pivotRows, pivotErr := db.PGQuery(r.Context(), `
			SELECT
				COALESCE(SUM(CASE WHEN cycle_date=$1::date THEN interest_charged_kobo END),0) AS interest_cur,
				COALESCE(SUM(CASE WHEN cycle_date=$1::date THEN fees_kobo END),0)             AS fees_cur,
				COALESCE(SUM(CASE WHEN cycle_date=$1::date THEN penalty_kobo END),0)          AS penalty_cur,
				COALESCE(SUM(CASE WHEN cycle_date=$2::date THEN interest_charged_kobo END),0) AS interest_prev,
				COALESCE(SUM(CASE WHEN cycle_date=$2::date THEN fees_kobo END),0)             AS fees_prev,
				COALESCE(SUM(CASE WHEN cycle_date=$2::date THEN penalty_kobo END),0)          AS penalty_prev
			FROM card_cycle_data
			WHERE cycle_date = $1::date OR cycle_date = $2::date`,
			current, prevArg)
		if pivotErr != nil || len(pivotRows) == 0 {
			respond(w, []map[string]any{}, "pg")
			return
		}
		p := pivotRows[0]
		out := []map[string]any{
			{"type": "Interest", "current": toInt64(p["interest_cur"]), "previous": toInt64(p["interest_prev"])},
			{"type": "Fees",     "current": toInt64(p["fees_cur"]),     "previous": toInt64(p["fees_prev"])},
			{"type": "Penalty",  "current": toInt64(p["penalty_cur"]),  "previous": toInt64(p["penalty_prev"])},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(out) //nolint:errcheck
	}
}

/* ── Income summary (KPIs) ────────────────────────────────────────────────────
   Returns headline totals for the most recent cycle:
   card_interest, card_fees, card_penalty, loan_interest, fee_type_income.
*/

func finIncomeSummary(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cycleDate := qstr(r, "cycle_date")

		// Default to most recent cycle
		if cycleDate == "" {
			rows, _ := db.PGQuery(r.Context(),
				`SELECT TO_CHAR(cycle_date,'YYYY-MM-DD') AS d FROM card_cycle_data ORDER BY cycle_date DESC LIMIT 1`)
			if len(rows) > 0 {
				cycleDate = fmt.Sprintf("%v", rows[0]["d"])
			}
		}

		// Per-currency card totals — exact values, no rounding
		cardQ := `
			SELECT
			  currency,
			  COALESCE(SUM(interest_charged_kobo),   0)::BIGINT AS card_interest,
			  COALESCE(SUM(fees_kobo),               0)::BIGINT AS card_fees,
			  COALESCE(SUM(penalty_kobo),            0)::BIGINT AS card_penalty,
			  COALESCE(SUM(outstanding_balance_kobo),0)::BIGINT AS card_outstanding,
			  COALESCE(SUM(billed_balance_kobo),     0)::BIGINT AS card_billed,
			  COALESCE(SUM(credit_limit_kobo),       0)::BIGINT AS card_credit_limit,
			  COALESCE(SUM(purchase_amount_kobo),    0)::BIGINT AS card_purchases,
			  COALESCE(SUM(cash_advance_kobo),       0)::BIGINT AS card_cash_advance,
			  COUNT(*)::BIGINT                                   AS card_accounts
			FROM card_cycle_data
			WHERE cycle_date = $1::date
			GROUP BY currency`

		cardRows, err := db.PGQuery(r.Context(), cardQ, cycleDate)
		if err != nil {
			respondErr(w, 500, "summary query failed")
			return
		}

		// Live Udara/CBS credit book (open loans).
		loanRows, _ := db.PGQuery(r.Context(), `
			SELECT
			  COALESCE(SUM(loan_amount_kobo), 0)::BIGINT AS total_disbursed_kobo,
			  COUNT(*)::BIGINT AS active_loans
			FROM cbs_loans
			WHERE status NOT IN ('Closed','Revoked')`)

		feeRows, _ := db.PGQuery(r.Context(), `
			SELECT COALESCE(SUM(amount_kobo), 0)::BIGINT AS fee_type_income_kobo
			FROM fee_income`)

		// Flatten by currency suffix: _ngn / _usd
		summary := map[string]any{"cycle_date": cycleDate}
		for _, cr := range cardRows {
			sfx := "_" + strings.ToLower(fmt.Sprintf("%v", cr["currency"]))
			summary["card_interest"+sfx]    = toInt64(cr["card_interest"])
			summary["card_fees"+sfx]        = toInt64(cr["card_fees"])
			summary["card_penalty"+sfx]     = toInt64(cr["card_penalty"])
			summary["card_outstanding"+sfx] = toInt64(cr["card_outstanding"])
			summary["card_billed"+sfx]      = toInt64(cr["card_billed"])
			summary["card_credit_limit"+sfx]= toInt64(cr["card_credit_limit"])
			summary["card_purchases"+sfx]   = toInt64(cr["card_purchases"])
			summary["card_cash_advance"+sfx]= toInt64(cr["card_cash_advance"])
			summary["card_accounts"+sfx]    = toInt64(cr["card_accounts"])
		}
		// Ensure NGN and USD keys always present so frontend never gets undefined
		for _, sfx := range []string{"_ngn", "_usd"} {
			for _, k := range []string{"card_interest","card_fees","card_penalty",
				"card_outstanding","card_billed","card_credit_limit",
				"card_purchases","card_cash_advance","card_accounts"} {
				if _, ok := summary[k+sfx]; !ok {
					summary[k+sfx] = int64(0)
				}
			}
		}

		summary["loan_disbursed_kobo"]  = int64(0)
		summary["active_loans"]         = int64(0)
		summary["fee_type_income_kobo"] = int64(0)
		if len(loanRows) > 0 {
			summary["loan_disbursed_kobo"] = toInt64(loanRows[0]["total_disbursed_kobo"])
			summary["active_loans"]        = toInt64(loanRows[0]["active_loans"])
		}
		if len(feeRows) > 0 {
			summary["fee_type_income_kobo"] = toInt64(feeRows[0]["fee_type_income_kobo"])
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(summary) //nolint:errcheck
	}
}

/* ── Income — loans ───────────────────────────────────────────────────────────
   Returns disbursed loans with rate and estimated interest earned to date.
*/

func finIncomeLoans(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit        := qint(r, "limit",  100, 1, 500)
		offset       := qint(r, "offset", 0,   0, 1<<30)
		dateFrom, _  := validDate(r, "date_from")
		dateTo, _    := validDate(r, "date_to")

		where := "disbursed_at IS NOT NULL"
		var args []any
		n := 1
		if dateFrom != "" {
			where += fmt.Sprintf(" AND disbursed_at::date >= $%d::date", n); args = append(args, dateFrom); n++
		}
		if dateTo != "" {
			where += fmt.Sprintf(" AND disbursed_at::date <= $%d::date", n); args = append(args, dateTo); n++
		}
		args = append(args, limit, offset)

		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT
			  id,
			  reference                                                        AS loan_ref,
			  applicant_name,
			  loan_product                                                     AS product,
			  disbursed_amount_kobo,
			  interest_rate_bps,
			  ROUND(interest_rate_bps::numeric / 100, 2)                      AS rate_pct,
			  TO_CHAR(disbursed_at, 'YYYY-MM-DD')                             AS disbursed_at,
			  TO_CHAR(maturity_date, 'YYYY-MM-DD')                            AS maturity_date,
			  status,
			  CASE
			    WHEN maturity_date IS NOT NULL AND maturity_date::date < CURRENT_DATE
			      THEN (maturity_date::date - disbursed_at::date)
			    ELSE GREATEST(CURRENT_DATE - disbursed_at::date, 0)
			  END                                                              AS days_active,
			  ROUND(
			    disbursed_amount_kobo::numeric
			    * (interest_rate_bps::numeric / 10000)
			    * CASE
			        WHEN maturity_date IS NOT NULL AND maturity_date::date < CURRENT_DATE
			          THEN (maturity_date::date - disbursed_at::date)
			        ELSE GREATEST(CURRENT_DATE - disbursed_at::date, 0)
			      END / 365
			  )::bigint                                                        AS interest_earned_kobo,
			  CASE
			    WHEN maturity_date IS NULL THEN 'Unknown'
			    WHEN maturity_date::date < CURRENT_DATE THEN 'Matured'
			    WHEN maturity_date::date <= CURRENT_DATE + INTERVAL '30 days' THEN 'Maturing Soon'
			    ELSE 'Active'
			  END                                                              AS maturity_status
			FROM loan_applications
			WHERE %s
			ORDER BY disbursed_at DESC
			LIMIT $%d OFFSET $%d`, where, n, n+1), args...)
		if err != nil {
			respondErr(w, 500, "loan income query failed: "+err.Error())
			return
		}
		jsonRows(w, rows)
	}
}

/* ── Income — fee types ───────────────────────────────────────────────────────
   Returns fee income grouped by fee_type and date from the fee_income table.
   Table is empty until a fee-type-level report is connected.
*/

func finIncomeFeeTypes(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		feeType  := qstr(r, "fee_type")
		dateFrom := qstr(r, "date_from")
		dateTo   := qstr(r, "date_to")

		where := "1=1"
		var args []any
		n := 1
		if feeType != "" {
			parts := strings.Split(feeType, ",")
			phs := make([]string, len(parts))
			for i, p := range parts { phs[i] = fmt.Sprintf("$%d", n+i); args = append(args, strings.TrimSpace(p)) }
			n += len(parts)
			if len(parts) == 1 {
				where += fmt.Sprintf(" AND fee_type=%s", phs[0])
			} else {
				where += fmt.Sprintf(" AND fee_type IN (%s)", strings.Join(phs, ","))
			}
		}
		if dateFrom != "" {
			where += fmt.Sprintf(" AND fee_date>=$%d::date", n); args = append(args, dateFrom); n++
		}
		if dateTo != "" {
			where += fmt.Sprintf(" AND fee_date<=$%d::date", n); args = append(args, dateTo); n++
		}
		_ = n

		// Summary by fee type
		summaryRows, _ := db.PGQuery(r.Context(), `
			SELECT fee_type,
			  COUNT(*)           AS count,
			  SUM(amount_kobo)   AS total_kobo
			FROM fee_income
			GROUP BY fee_type
			ORDER BY total_kobo DESC`)

		// Detail rows
		detailRows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT
			  TO_CHAR(fee_date,'YYYY-MM-DD') AS fee_date,
			  fee_type,
			  product_code,
			  COALESCE(p.product_name, fi.product_code) AS product_name,
			  SUM(fi.amount_kobo) AS amount_kobo,
			  fi.currency
			FROM fee_income fi
			LEFT JOIN card_products p ON p.product_code = fi.product_code
			WHERE %s
			GROUP BY fee_date, fee_type, fi.product_code, p.product_name, fi.currency
			ORDER BY fee_date DESC, amount_kobo DESC`, where), args...)
		if err != nil {
			respondErr(w, 500, "fee types query failed: "+err.Error())
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"summary": summaryRows,
			"detail":  detailRows,
		})
	}
}

func finTransactionKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT
			  COUNT(*)                                                            AS total_count,
			  COALESCE(SUM(amount) FILTER (WHERE sign = 'CR'), 0)                AS total_credits_kobo,
			  COALESCE(SUM(amount) FILTER (WHERE sign = 'DR'), 0)                AS total_debits_kobo,
			  COALESCE(SUM(amount) FILTER (WHERE sign = 'CR'), 0)
			    - COALESCE(SUM(amount) FILTER (WHERE sign = 'DR'), 0)            AS net_position_kobo
			FROM eod_transactions
			WHERE txn_date >= date_trunc('month', CURRENT_DATE)::date`)
		if err != nil || len(rows) == 0 {
			respond(w, map[string]any{
				"total_count": 0, "total_credits_kobo": 0, "total_debits_kobo": 0, "net_position_kobo": 0,
			}, "pg")
			return
		}
		respond(w, rows[0], "pg")
	}
}

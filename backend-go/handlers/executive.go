package handlers

import (
	"fmt"
	"net/http"
	"sort"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

func RegisterExecutive(r chi.Router, db *core.DB) {
	r.Use(core.RequirePages("executive"))
	r.Get("/summary",     executiveSummary(db))
	r.Get("/cards",       execCardsHandler(db))
	r.Get("/finance",     execFinanceHandler(db))
	r.Get("/sales",       execSalesHandler(db))
	r.Get("/collections", execCollectionsHandler(db))
	r.Get("/risk",        execRiskHandler(db))
	r.Get("/hr",          execHRHandler(db))
	r.Get("/settlements", execSettlementsHandler(db))
}

// periodDates returns (currentStart, currentEnd, prevStart, prevEnd) for the given period.
func periodDates(period, startStr, endStr string) (cs, ce, ps, pe time.Time, err error) {
	today := time.Now().UTC().Truncate(24 * time.Hour)

	switch period {
	case "month":
		cs = today.AddDate(0, 0, -today.Day()+1)
		ce = today
		prev := cs.AddDate(0, -1, 0)
		ps = prev
		pe = ps.AddDate(0, 0, int(ce.Sub(cs).Hours()/24))

	case "quarter":
		q := (int(today.Month()) - 1) / 3
		cs = time.Date(today.Year(), time.Month(q*3+1), 1, 0, 0, 0, 0, time.UTC)
		ce = today
		var pqStart time.Time
		if q == 0 {
			pqStart = time.Date(today.Year()-1, 10, 1, 0, 0, 0, 0, time.UTC)
		} else {
			pqStart = time.Date(today.Year(), time.Month((q-1)*3+1), 1, 0, 0, 0, 0, time.UTC)
		}
		ps = pqStart
		pe = ps.AddDate(0, 0, int(ce.Sub(cs).Hours()/24))

	case "year":
		cs = time.Date(today.Year(), 1, 1, 0, 0, 0, 0, time.UTC)
		ce = today
		ps = time.Date(today.Year()-1, 1, 1, 0, 0, 0, 0, time.UTC)
		pe = ps.AddDate(0, 0, int(ce.Sub(cs).Hours()/24))

	case "custom":
		if startStr == "" || endStr == "" {
			return cs, ce, ps, pe, fmt.Errorf("start and end required for custom period")
		}
		cs, err = time.Parse("2006-01-02", startStr)
		if err != nil {
			return cs, ce, ps, pe, fmt.Errorf("invalid start date")
		}
		ce, err = time.Parse("2006-01-02", endStr)
		if err != nil {
			return cs, ce, ps, pe, fmt.Errorf("invalid end date")
		}
		if ce.Before(cs) {
			return cs, ce, ps, pe, fmt.Errorf("end must be >= start")
		}
		delta := int(ce.Sub(cs).Hours()/24) + 1
		pe = cs.AddDate(0, 0, -1)
		ps = pe.AddDate(0, 0, -(delta - 1))
	default:
		return cs, ce, ps, pe, fmt.Errorf("unknown period: %s", period)
	}
	return
}

func periodLabel(period string, cs, ce time.Time) string {
	switch period {
	case "month":
		return cs.Format("January 2006")
	case "quarter":
		q := (int(cs.Month())-1)/3 + 1
		return fmt.Sprintf("Q%d %d", q, cs.Year())
	case "year":
		return fmt.Sprintf("%d", cs.Year())
	default:
		return fmt.Sprintf("%s – %s", cs.Format("2006-01-02"), ce.Format("2006-01-02"))
	}
}

func pctChange(curr, prev float64) any {
	if prev == 0 {
		return nil
	}
	return round1((curr-prev)/abs64(prev)*100)
}

func abs64(f float64) float64 {
	if f < 0 {
		return -f
	}
	return f
}

func d(t time.Time) string { return t.Format("2006-01-02") }

// ── Department handlers ───────────────────────────────────────────────────────

func execCardsHandler(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		period := qstr(r, "period")
		if period == "" {
			period = "month"
		}
		cs, ce, _, _, err := periodDates(period, qstr(r, "start"), qstr(r, "end"))
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		ctx := r.Context()

		var pendingIssuance, approved, dispatched int64
		if rows, e := db.PGQuery(ctx, `
			SELECT
				COUNT(*) FILTER (WHERE status = 'pending')    AS pending_issuance,
				COUNT(*) FILTER (WHERE status = 'approved')   AS approved,
				COUNT(*) FILTER (WHERE status = 'dispatched') AS dispatched
			FROM card_issuance_requests`); e == nil && len(rows) > 0 {
			pendingIssuance = toInt64(rows[0]["pending_issuance"])
			approved = toInt64(rows[0]["approved"])
			dispatched = toInt64(rows[0]["dispatched"])
		}

		var openDisputes, resolvedDisputesPeriod int64
		if rows, e := db.PGQuery(ctx, `
			SELECT
				COUNT(*) FILTER (WHERE status = 'filed') AS open_disputes,
				COUNT(*) FILTER (WHERE status IN ('resolved','closed') AND filed_at::date BETWEEN $1 AND $2) AS resolved_disputes_period
			FROM card_disputes`, d(cs), d(ce)); e == nil && len(rows) > 0 {
			openDisputes = toInt64(rows[0]["open_disputes"])
			resolvedDisputesPeriod = toInt64(rows[0]["resolved_disputes_period"])
		}

		var pendingCreditReviews int64
		if rows, e := db.PGQuery(ctx, `
			SELECT COUNT(*) AS cnt
			FROM card_credit_limit_reviews
			WHERE status = 'pending_review'`); e == nil && len(rows) > 0 {
			pendingCreditReviews = toInt64(rows[0]["cnt"])
		}

		respond(w, map[string]any{
			"period":                  map[string]any{"type": period, "start": d(cs), "end": d(ce)},
			"pending_issuance":        pendingIssuance,
			"approved":                approved,
			"dispatched":              dispatched,
			"open_disputes":           openDisputes,
			"resolved_disputes_period": resolvedDisputesPeriod,
			"pending_credit_reviews":  pendingCreditReviews,
		}, "pg")
	}
}

func execFinanceHandler(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		period := qstr(r, "period")
		if period == "" {
			period = "month"
		}
		cs, ce, _, _, err := periodDates(period, qstr(r, "start"), qstr(r, "end"))
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		ctx := r.Context()

		var revenueKobo int64
		if rows, e := db.PGQuery(ctx, `
			SELECT COALESCE(SUM(je.amount_kobo), 0) AS revenue_kobo
			FROM gl_journal_entries je
			JOIN gl_accounts a ON a.id = je.account_id
			WHERE je.direction = 'CR'
			  AND a.type = 'revenue'
			  AND je.created_at::date BETWEEN $1 AND $2`, d(cs), d(ce)); e == nil && len(rows) > 0 {
			revenueKobo = toInt64(rows[0]["revenue_kobo"])
		}

		var expensesKobo int64
		if rows, e := db.PGQuery(ctx, `
			SELECT COALESCE(SUM(je.amount_kobo), 0) AS expenses_kobo
			FROM gl_journal_entries je
			JOIN gl_accounts a ON a.id = je.account_id
			WHERE je.direction = 'DR'
			  AND a.type = 'expense'
			  AND je.created_at::date BETWEEN $1 AND $2`, d(cs), d(ce)); e == nil && len(rows) > 0 {
			expensesKobo = toInt64(rows[0]["expenses_kobo"])
		}

		var glEntriesCount int64
		if rows, e := db.PGQuery(ctx, `
			SELECT COUNT(*) AS cnt
			FROM gl_journal_entries
			WHERE created_at::date BETWEEN $1 AND $2`, d(cs), d(ce)); e == nil && len(rows) > 0 {
			glEntriesCount = toInt64(rows[0]["cnt"])
		}

		var pendingSettlements, settledPeriod int64
		if rows, e := db.PGQuery(ctx, `
			SELECT
				COUNT(*) FILTER (WHERE status = 'pending') AS pending_settlements,
				COUNT(*) FILTER (WHERE status = 'settled' AND created_at::date BETWEEN $1 AND $2) AS settled_period
			FROM settlement_batches`, d(cs), d(ce)); e == nil && len(rows) > 0 {
			pendingSettlements = toInt64(rows[0]["pending_settlements"])
			settledPeriod = toInt64(rows[0]["settled_period"])
		}

		respond(w, map[string]any{
			"period":              map[string]any{"type": period, "start": d(cs), "end": d(ce)},
			"revenue_kobo":        revenueKobo,
			"expenses_kobo":       expensesKobo,
			"net_income_kobo":     revenueKobo - expensesKobo,
			"gl_entries_count":    glEntriesCount,
			"pending_settlements": pendingSettlements,
			"settled_period":      settledPeriod,
			"paystack_wallet_kobo": paystackWalletKobo(ctx, db),
		}, "pg")
	}
}

func execSalesHandler(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		period := qstr(r, "period")
		if period == "" {
			period = "month"
		}
		cs, ce, _, _, err := periodDates(period, qstr(r, "start"), qstr(r, "end"))
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		ctx := r.Context()

		var submittedPeriod, approvedPeriod int64
		var disbursedKoboPeriod, totalPipelineKobo int64
		if rows, e := db.PGQuery(ctx, `
			SELECT
				COUNT(*) FILTER (WHERE created_at::date BETWEEN $1 AND $2) AS submitted_period,
				COUNT(*) FILTER (WHERE stage IN ('approved','active','disbursed') AND created_at::date BETWEEN $1 AND $2) AS approved_period,
				COALESCE(SUM(disbursed_amount_kobo) FILTER (WHERE stage = 'active' AND created_at::date BETWEEN $1 AND $2), 0) AS disbursed_kobo_period,
				COALESCE(SUM(amount_requested_kobo) FILTER (WHERE stage NOT IN ('declined','cancelled')), 0) AS total_pipeline_kobo
			FROM loan_applications`, d(cs), d(ce)); e == nil && len(rows) > 0 {
			submittedPeriod = toInt64(rows[0]["submitted_period"])
			approvedPeriod = toInt64(rows[0]["approved_period"])
			disbursedKoboPeriod = toInt64(rows[0]["disbursed_kobo_period"])
			totalPipelineKobo = toInt64(rows[0]["total_pipeline_kobo"])
		}

		var conversionRate float64
		if submittedPeriod > 0 {
			conversionRate = round1(float64(approvedPeriod) / float64(submittedPeriod) * 100)
		}

		stageBreakdown := make([]map[string]any, 0)
		if rows, e := db.PGQuery(ctx, `
			SELECT stage, COUNT(*) AS count
			FROM loan_applications
			GROUP BY stage
			ORDER BY count DESC`); e == nil {
			for _, row := range rows {
				stageBreakdown = append(stageBreakdown, map[string]any{
					"stage": str(row["stage"]),
					"count": toInt64(row["count"]),
				})
			}
		}

		respond(w, map[string]any{
			"period":                 map[string]any{"type": period, "start": d(cs), "end": d(ce)},
			"submitted_period":       submittedPeriod,
			"approved_period":        approvedPeriod,
			"disbursed_kobo_period":  disbursedKoboPeriod,
			"total_pipeline_kobo":    totalPipelineKobo,
			"conversion_rate":        conversionRate,
			"stage_breakdown":        stageBreakdown,
		}, "pg")
	}
}

func execCollectionsHandler(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		period := qstr(r, "period")
		if period == "" {
			period = "month"
		}
		cs, ce, _, _, err := periodDates(period, qstr(r, "start"), qstr(r, "end"))
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		ctx := r.Context()

		var totalAssigned, totalOutstandingKobo int64
		if rows, e := db.PGQuery(ctx, `
			SELECT COUNT(*) AS total_assigned, COALESCE(SUM(outstanding_kobo), 0) AS total_outstanding_kobo
			FROM collection_assignments`); e == nil && len(rows) > 0 {
			totalAssigned = toInt64(rows[0]["total_assigned"])
			totalOutstandingKobo = toInt64(rows[0]["total_outstanding_kobo"])
		}

		var contactsThisPeriod int64
		if rows, e := db.PGQuery(ctx, `
			SELECT COUNT(*) AS cnt
			FROM collection_contacts
			WHERE created_at::date BETWEEN $1 AND $2`, d(cs), d(ce)); e == nil && len(rows) > 0 {
			contactsThisPeriod = toInt64(rows[0]["cnt"])
		}

		var ptpsActive int64
		if rows, e := db.PGQuery(ctx, `
			SELECT COUNT(*) AS cnt
			FROM collection_promises
			WHERE is_kept = FALSE AND promised_date >= CURRENT_DATE`); e == nil && len(rows) > 0 {
			ptpsActive = toInt64(rows[0]["cnt"])
		}

		bucketBreakdown := make([]map[string]any, 0)
		if rows, e := db.PGQuery(ctx, `
			SELECT dpd_bucket, COUNT(*) AS count, COALESCE(SUM(outstanding_kobo), 0) AS outstanding_kobo
			FROM collection_assignments
			WHERE dpd_bucket IS NOT NULL
			GROUP BY dpd_bucket
			ORDER BY dpd_bucket`); e == nil {
			for _, row := range rows {
				bucketBreakdown = append(bucketBreakdown, map[string]any{
					"dpd_bucket":      str(row["dpd_bucket"]),
					"count":           toInt64(row["count"]),
					"outstanding_kobo": toInt64(row["outstanding_kobo"]),
				})
			}
		}

		respond(w, map[string]any{
			"period":                  map[string]any{"type": period, "start": d(cs), "end": d(ce)},
			"total_assigned":          totalAssigned,
			"total_outstanding_kobo":  totalOutstandingKobo,
			"contacts_this_period":    contactsThisPeriod,
			"ptps_active":             ptpsActive,
			"bucket_breakdown":        bucketBreakdown,
		}, "pg")
	}
}

func execRiskHandler(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		period := qstr(r, "period")
		if period == "" {
			period = "month"
		}
		cs, ce, _, _, err := periodDates(period, qstr(r, "start"), qstr(r, "end"))
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		ctx := r.Context()

		var totalPortfolioKobo, delinquentKobo, nplKobo int64
		if rows, e := db.PGQuery(ctx, `
			SELECT
				COALESCE(SUM(outstanding_kobo), 0) AS total_portfolio_kobo,
				COALESCE(SUM(outstanding_kobo) FILTER (WHERE dpd > 0), 0) AS delinquent_kobo,
				COALESCE(SUM(outstanding_kobo) FILTER (WHERE dpd > 90), 0) AS npl_kobo
			FROM loan_applications
			WHERE stage = 'active'`); e == nil && len(rows) > 0 {
			totalPortfolioKobo = toInt64(rows[0]["total_portfolio_kobo"])
			delinquentKobo = toInt64(rows[0]["delinquent_kobo"])
			nplKobo = toInt64(rows[0]["npl_kobo"])
		}

		var nplPct, delinquencyRate float64
		if totalPortfolioKobo > 0 {
			nplPct = round1(float64(nplKobo) / float64(totalPortfolioKobo) * 100)
			delinquencyRate = round1(float64(delinquentKobo) / float64(totalPortfolioKobo) * 100)
		}

		var recoveryCasesOpen, recoveredPeriodKobo int64
		if rows, e := db.PGQuery(ctx, `
			SELECT
				COUNT(*) FILTER (WHERE status NOT IN ('closed','written_off')) AS recovery_cases_open,
				COALESCE(SUM(recovered_kobo) FILTER (WHERE opened_at::date BETWEEN $1 AND $2), 0) AS recovered_period_kobo
			FROM recovery_cases`, d(cs), d(ce)); e == nil && len(rows) > 0 {
			recoveryCasesOpen = toInt64(rows[0]["recovery_cases_open"])
			recoveredPeriodKobo = toInt64(rows[0]["recovered_period_kobo"])
		}

		respond(w, map[string]any{
			"period":                 map[string]any{"type": period, "start": d(cs), "end": d(ce)},
			"total_portfolio_kobo":   totalPortfolioKobo,
			"delinquent_kobo":        delinquentKobo,
			"npl_kobo":               nplKobo,
			"npl_pct":                nplPct,
			"par90_pct":              nplPct,
			"delinquency_rate":       delinquencyRate,
			"recovery_cases_open":    recoveryCasesOpen,
			"recovered_period_kobo":  recoveredPeriodKobo,
		}, "pg")
	}
}

func execHRHandler(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		period := qstr(r, "period")
		if period == "" {
			period = "month"
		}
		cs, ce, _, _, err := periodDates(period, qstr(r, "start"), qstr(r, "end"))
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		ctx := r.Context()

		var totalEmployees, activeEmployees, onLeaveToday, newHiresPeriod int64
		if rows, e := db.PGQuery(ctx, `
			SELECT
				COUNT(*) AS total_employees,
				COUNT(*) FILTER (WHERE employment_status = 'active') AS active_employees,
				COUNT(*) FILTER (WHERE employment_status = 'on_leave') AS on_leave_today,
				COUNT(*) FILTER (WHERE created_at::date BETWEEN $1 AND $2) AS new_hires_period
			FROM employees`, d(cs), d(ce)); e == nil && len(rows) > 0 {
			totalEmployees = toInt64(rows[0]["total_employees"])
			activeEmployees = toInt64(rows[0]["active_employees"])
			onLeaveToday = toInt64(rows[0]["on_leave_today"])
			newHiresPeriod = toInt64(rows[0]["new_hires_period"])
		}

		var pendingLeaveRequests int64
		if rows, e := db.PGQuery(ctx, `
			SELECT COUNT(*) AS cnt
			FROM leave_applications
			WHERE status = 'pending'`); e == nil && len(rows) > 0 {
			pendingLeaveRequests = toInt64(rows[0]["cnt"])
		}

		deptBreakdown := make([]map[string]any, 0)
		if rows, e := db.PGQuery(ctx, `
			SELECT department, COUNT(*) AS count
			FROM employees
			WHERE department IS NOT NULL
			GROUP BY department
			ORDER BY count DESC`); e == nil {
			for _, row := range rows {
				deptBreakdown = append(deptBreakdown, map[string]any{
					"department": str(row["department"]),
					"count":      toInt64(row["count"]),
				})
			}
		}

		respond(w, map[string]any{
			"period":                  map[string]any{"type": period, "start": d(cs), "end": d(ce)},
			"total_employees":         totalEmployees,
			"active_employees":        activeEmployees,
			"on_leave_today":          onLeaveToday,
			"new_hires_period":        newHiresPeriod,
			"pending_leave_requests":  pendingLeaveRequests,
			"dept_breakdown":          deptBreakdown,
		}, "pg")
	}
}

func execSettlementsHandler(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		period := qstr(r, "period")
		if period == "" {
			period = "month"
		}
		cs, ce, _, _, err := periodDates(period, qstr(r, "start"), qstr(r, "end"))
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		ctx := r.Context()

		var pendingCount, settledPeriodCount, failedPeriod int64
		var pendingAmountKobo, settledPeriodKobo, totalSettledAllTimeKobo int64
		if rows, e := db.PGQuery(ctx, `
			SELECT
				COUNT(*) FILTER (WHERE status = 'pending') AS pending_count,
				COALESCE(SUM(total_amount) FILTER (WHERE status = 'pending'), 0) AS pending_amount_kobo,
				COUNT(*) FILTER (WHERE status = 'settled' AND created_at::date BETWEEN $1 AND $2) AS settled_period_count,
				COALESCE(SUM(total_amount) FILTER (WHERE status = 'settled' AND created_at::date BETWEEN $1 AND $2), 0) AS settled_period_kobo,
				COUNT(*) FILTER (WHERE status = 'failed' AND created_at::date BETWEEN $1 AND $2) AS failed_period,
				COALESCE(SUM(total_amount) FILTER (WHERE status = 'settled'), 0) AS total_settled_all_time_kobo
			FROM settlement_batches`, d(cs), d(ce)); e == nil && len(rows) > 0 {
			pendingCount = toInt64(rows[0]["pending_count"])
			pendingAmountKobo = toInt64(rows[0]["pending_amount_kobo"])
			settledPeriodCount = toInt64(rows[0]["settled_period_count"])
			settledPeriodKobo = toInt64(rows[0]["settled_period_kobo"])
			failedPeriod = toInt64(rows[0]["failed_period"])
			totalSettledAllTimeKobo = toInt64(rows[0]["total_settled_all_time_kobo"])
		}

		respond(w, map[string]any{
			"period":                      map[string]any{"type": period, "start": d(cs), "end": d(ce)},
			"pending_count":               pendingCount,
			"pending_amount_kobo":         pendingAmountKobo,
			"settled_period_count":        settledPeriodCount,
			"settled_period_kobo":         settledPeriodKobo,
			"failed_period":               failedPeriod,
			"total_settled_all_time_kobo": totalSettledAllTimeKobo,
			"paystack_wallet_kobo":        paystackWalletKobo(ctx, db),
		}, "pg")
	}
}

// ── Executive summary ─────────────────────────────────────────────────────────

func executiveSummary(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		period := qstr(r, "period")
		if period == "" {
			period = "month"
		}
		cs, ce, ps, pe, err := periodDates(period, qstr(r, "start"), qstr(r, "end"))
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}

		var sources []string
		// scalar helper
		sc := func(msQ, pgQ string) float64 {
			val, src, e := db.DualScalar(r.Context(), "val", msQ, pgQ)
			if e == nil {
				sources = append(sources, src)
				return toFloat(val)
			}
			return 0
		}
		// query helper
		qh := func(msQ, pgQ string) []core.Row {
			rows, src, e := db.DualQuery(r.Context(), msQ, pgQ)
			if e == nil {
				sources = append(sources, src)
				return rows
			}
			return nil
		}

		// ── Collections ───────────────────────────────────────────────────────
		collCurr := sc(
			fmt.Sprintf("SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.o3_loan_Repayment WHERE Repayment_Date BETWEEN '%s' AND '%s'", d(cs), d(ce)),
			fmt.Sprintf(`SELECT COALESCE(SUM("Amount"),0) AS val FROM "Collections Log" WHERE "Date" BETWEEN '%s' AND '%s'`, d(cs), d(ce)))
		collPrev := sc(
			fmt.Sprintf("SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.o3_loan_Repayment WHERE Repayment_Date BETWEEN '%s' AND '%s'", d(ps), d(pe)),
			fmt.Sprintf(`SELECT COALESCE(SUM("Amount"),0) AS val FROM "Collections Log" WHERE "Date" BETWEEN '%s' AND '%s'`, d(ps), d(pe)))
		collCountCurr := sc(
			fmt.Sprintf("SELECT COUNT(*) AS val FROM dbo.o3_loan_Repayment WHERE Repayment_Date BETWEEN '%s' AND '%s'", d(cs), d(ce)),
			fmt.Sprintf(`SELECT COUNT(*) AS val FROM "Collections Log" WHERE "Date" BETWEEN '%s' AND '%s'`, d(cs), d(ce)))

		// ── Recovery ─────────────────────────────────────────────────────────
		recCurr := sc(
			fmt.Sprintf("SELECT ISNULL(SUM([Recovery Amount]),0) AS val FROM dbo.RecoveryMasterSheet WHERE [Recovery Date] BETWEEN '%s' AND '%s'", d(cs), d(ce)),
			fmt.Sprintf(`SELECT COALESCE(SUM("Recovery Amount"),0) AS val FROM "Recovery Master Sheet" WHERE "Recovery Date" BETWEEN '%s' AND '%s'`, d(cs), d(ce)))
		recPrev := sc(
			fmt.Sprintf("SELECT ISNULL(SUM([Recovery Amount]),0) AS val FROM dbo.RecoveryMasterSheet WHERE [Recovery Date] BETWEEN '%s' AND '%s'", d(ps), d(pe)),
			fmt.Sprintf(`SELECT COALESCE(SUM("Recovery Amount"),0) AS val FROM "Recovery Master Sheet" WHERE "Recovery Date" BETWEEN '%s' AND '%s'`, d(ps), d(pe)))

		// ── Transactions ──────────────────────────────────────────────────────
		txnVolCurr := sc(
			fmt.Sprintf("SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.Transaction_Listing WHERE Transaction_Date BETWEEN '%s' AND '%s'", d(cs), d(ce)),
			fmt.Sprintf(`SELECT COALESCE(SUM("Amount"),0) AS val FROM "Transactions" WHERE "Transaction Date" BETWEEN '%s' AND '%s'`, d(cs), d(ce)))
		txnVolPrev := sc(
			fmt.Sprintf("SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.Transaction_Listing WHERE Transaction_Date BETWEEN '%s' AND '%s'", d(ps), d(pe)),
			fmt.Sprintf(`SELECT COALESCE(SUM("Amount"),0) AS val FROM "Transactions" WHERE "Transaction Date" BETWEEN '%s' AND '%s'`, d(ps), d(pe)))
		txnCntCurr := sc(
			fmt.Sprintf("SELECT COUNT(*) AS val FROM dbo.Transaction_Listing WHERE Transaction_Date BETWEEN '%s' AND '%s'", d(cs), d(ce)),
			fmt.Sprintf(`SELECT COUNT(*) AS val FROM "Transactions" WHERE "Transaction Date" BETWEEN '%s' AND '%s'`, d(cs), d(ce)))
		txnCntPrev := sc(
			fmt.Sprintf("SELECT COUNT(*) AS val FROM dbo.Transaction_Listing WHERE Transaction_Date BETWEEN '%s' AND '%s'", d(ps), d(pe)),
			fmt.Sprintf(`SELECT COUNT(*) AS val FROM "Transactions" WHERE "Transaction Date" BETWEEN '%s' AND '%s'`, d(ps), d(pe)))
		var avgTxn float64
		if txnCntCurr > 0 {
			avgTxn = round1(txnVolCurr / txnCntCurr)
		}

		// ── Customer acquisition ──────────────────────────────────────────────
		newCurr := sc(
			fmt.Sprintf("SELECT COUNT(*) AS val FROM dbo.Contact WHERE Account_Created BETWEEN '%s' AND '%s'", d(cs), d(ce)),
			fmt.Sprintf(`SELECT COUNT(*) AS val FROM "Accounts" WHERE "Account Created Date" BETWEEN '%s' AND '%s'`, d(cs), d(ce)))
		newPrev := sc(
			fmt.Sprintf("SELECT COUNT(*) AS val FROM dbo.Contact WHERE Account_Created BETWEEN '%s' AND '%s'", d(ps), d(pe)),
			fmt.Sprintf(`SELECT COUNT(*) AS val FROM "Accounts" WHERE "Account Created Date" BETWEEN '%s' AND '%s'`, d(ps), d(pe)))
		totalCustomers := sc(
			"SELECT COUNT(*) AS val FROM dbo.Contact",
			`SELECT COUNT(*) AS val FROM "Accounts"`)
		activeCards := sc(
			"SELECT COUNT(*) AS val FROM dbo.Account WHERE Status IN ('Open','Active')",
			`SELECT COUNT(*) AS val FROM "Products" WHERE "Account Status" IN ('Open','Active')`)
		totalCards := sc(
			"SELECT COUNT(*) AS val FROM dbo.Account",
			`SELECT COUNT(*) AS val FROM "Products"`)
		var activationRate float64
		if totalCards > 0 {
			activationRate = round1(activeCards / totalCards * 100)
		}

		// ── All-time recovery rate ─────────────────────────────────────────────
		totalRecoveredAll := sc(
			"SELECT ISNULL(SUM([Recovery Amount]),0) AS val FROM dbo.RecoveryMasterSheet",
			`SELECT COALESCE(SUM("Recovery Amount"),0) AS val FROM "Recovery Master Sheet"`)
		totalCollectedAll := sc(
			"SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.o3_loan_Repayment",
			`SELECT COALESCE(SUM("Amount"),0) AS val FROM "Collections Log"`)
		var recoveryRatePct float64
		if totalCollectedAll > 0 {
			recoveryRatePct = round1(totalRecoveredAll / totalCollectedAll * 100)
		}

		statesCount := sc(
			"SELECT COUNT(DISTINCT State_) AS val FROM dbo.Contact WHERE State_ IS NOT NULL AND State_!=''",
			`SELECT COUNT(DISTINCT "State") AS val FROM "Accounts" WHERE "State" IS NOT NULL AND "State"!=''`)

		// ── Trends (last 12 months) ───────────────────────────────────────────
		collTrend := qh(
			`SELECT FORMAT(Repayment_Date,'MMM yyyy') AS month, DATEFROMPARTS(YEAR(Repayment_Date),MONTH(Repayment_Date),1) AS sort_key, ISNULL(SUM(Amount),0) AS collections, COUNT(*) AS count FROM dbo.o3_loan_Repayment WHERE Repayment_Date >= DATEADD(MONTH,-11,DATEFROMPARTS(YEAR(GETDATE()),MONTH(GETDATE()),1)) GROUP BY DATEFROMPARTS(YEAR(Repayment_Date),MONTH(Repayment_Date),1), FORMAT(Repayment_Date,'MMM yyyy') ORDER BY sort_key`,
			`SELECT TO_CHAR(DATE_TRUNC('month',"Date"),'Mon YYYY') AS month, DATE_TRUNC('month',"Date") AS sort_key, COALESCE(SUM("Amount"),0) AS collections, COUNT(*) AS count FROM "Collections Log" WHERE "Date" >= DATE_TRUNC('month',CURRENT_DATE) - INTERVAL '11 months' GROUP BY DATE_TRUNC('month',"Date") ORDER BY sort_key`)
		recTrend := qh(
			`SELECT FORMAT([Recovery Date],'MMM yyyy') AS month, DATEFROMPARTS(YEAR([Recovery Date]),MONTH([Recovery Date]),1) AS sort_key, ISNULL(SUM([Recovery Amount]),0) AS recovery FROM dbo.RecoveryMasterSheet WHERE [Recovery Date] >= DATEADD(MONTH,-11,DATEFROMPARTS(YEAR(GETDATE()),MONTH(GETDATE()),1)) GROUP BY DATEFROMPARTS(YEAR([Recovery Date]),MONTH([Recovery Date]),1), FORMAT([Recovery Date],'MMM yyyy') ORDER BY sort_key`,
			`SELECT TO_CHAR(DATE_TRUNC('month',"Recovery Date"),'Mon YYYY') AS month, DATE_TRUNC('month',"Recovery Date") AS sort_key, COALESCE(SUM("Recovery Amount"),0) AS recovery FROM "Recovery Master Sheet" WHERE "Recovery Date" >= DATE_TRUNC('month',CURRENT_DATE) - INTERVAL '11 months' GROUP BY DATE_TRUNC('month',"Recovery Date") ORDER BY sort_key`)
		txnTrend := qh(
			`SELECT FORMAT(Transaction_Date,'MMM yyyy') AS month, DATEFROMPARTS(YEAR(Transaction_Date),MONTH(Transaction_Date),1) AS sort_key, ISNULL(SUM(Amount),0) AS volume, COUNT(*) AS txn_count FROM dbo.Transaction_Listing WHERE Transaction_Date >= DATEADD(MONTH,-11,DATEFROMPARTS(YEAR(GETDATE()),MONTH(GETDATE()),1)) GROUP BY DATEFROMPARTS(YEAR(Transaction_Date),MONTH(Transaction_Date),1), FORMAT(Transaction_Date,'MMM yyyy') ORDER BY sort_key`,
			`SELECT TO_CHAR(DATE_TRUNC('month',"Transaction Date"),'Mon YYYY') AS month, DATE_TRUNC('month',"Transaction Date") AS sort_key, COALESCE(SUM("Amount"),0) AS volume, COUNT(*) AS txn_count FROM "Transactions" WHERE "Transaction Date" >= DATE_TRUNC('month',CURRENT_DATE) - INTERVAL '11 months' GROUP BY DATE_TRUNC('month',"Transaction Date") ORDER BY sort_key`)
		acqTrend := qh(
			`SELECT FORMAT(Account_Created,'MMM yyyy') AS month, DATEFROMPARTS(YEAR(Account_Created),MONTH(Account_Created),1) AS sort_key, COUNT(*) AS new_accounts FROM dbo.Contact WHERE Account_Created >= DATEADD(MONTH,-11,DATEFROMPARTS(YEAR(GETDATE()),MONTH(GETDATE()),1)) GROUP BY DATEFROMPARTS(YEAR(Account_Created),MONTH(Account_Created),1), FORMAT(Account_Created,'MMM yyyy') ORDER BY sort_key`,
			`SELECT TO_CHAR(DATE_TRUNC('month',"Account Created Date"),'Mon YYYY') AS month, DATE_TRUNC('month',"Account Created Date") AS sort_key, COUNT(*) AS new_accounts FROM "Accounts" WHERE "Account Created Date" >= DATE_TRUNC('month',CURRENT_DATE) - INTERVAL '11 months' GROUP BY DATE_TRUNC('month',"Account Created Date") ORDER BY sort_key`)

		// ── Breakdowns ────────────────────────────────────────────────────────
		topStates := qh(
			"SELECT TOP 10 State_, COUNT(*) AS count FROM dbo.Contact WHERE State_ IS NOT NULL AND State_!='' GROUP BY State_ ORDER BY count DESC",
			`SELECT "State", COUNT(*) AS count FROM "Accounts" WHERE "State" IS NOT NULL AND "State"!='' GROUP BY "State" ORDER BY count DESC LIMIT 10`)
		productMix := qh(
			"SELECT Product_Name, COUNT(*) AS count FROM dbo.Account WHERE Product_Name IS NOT NULL GROUP BY Product_Name ORDER BY count DESC",
			`SELECT "Product Name", COUNT(*) AS count FROM "Products" WHERE "Product Name" IS NOT NULL GROUP BY "Product Name" ORDER BY count DESC`)
		topAgents := qh(
			fmt.Sprintf("SELECT TOP 10 Rn_Create_User AS Agent, ISNULL(SUM(Amount),0) AS total, COUNT(*) AS count FROM dbo.o3_loan_Repayment WHERE Repayment_Date BETWEEN '%s' AND '%s' AND Rn_Create_User IS NOT NULL AND Rn_Create_User!='' GROUP BY Rn_Create_User ORDER BY total DESC", d(cs), d(ce)),
			fmt.Sprintf(`SELECT "Agent", COALESCE(SUM("Amount"),0) AS total, COUNT(*) AS count FROM "Collections Log" WHERE "Date" BETWEEN '%s' AND '%s' AND "Agent" IS NOT NULL AND "Agent"!='' GROUP BY "Agent" ORDER BY total DESC LIMIT 10`, d(cs), d(ce)))

		// ── Merge trends by month ─────────────────────────────────────────────
		collByMonth := map[string]core.Row{}
		for _, row := range collTrend {
			collByMonth[str(row["month"])] = row
		}
		recByMonth := map[string]core.Row{}
		for _, row := range recTrend {
			recByMonth[str(row["month"])] = row
		}
		txnByMonth := map[string]core.Row{}
		for _, row := range txnTrend {
			txnByMonth[str(row["month"])] = row
		}
		// Build month→ISO-date-string index for chronological sorting.
		// sort_key from SQL is the first-of-month date; "2006-01-02" sorts correctly as string.
		monthSortKey := map[string]string{}
		for _, src := range [][]core.Row{collTrend, recTrend, txnTrend} {
			for _, row := range src {
				m := str(row["month"])
				if _, seen := monthSortKey[m]; seen {
					continue
				}
				switch v := row["sort_key"].(type) {
				case time.Time:
					monthSortKey[m] = v.Format("2006-01-02")
				case string:
					monthSortKey[m] = v
				}
			}
		}
		allMonths := make(map[string]bool)
		for m := range collByMonth {
			allMonths[m] = true
		}
		for m := range recByMonth {
			allMonths[m] = true
		}
		for m := range txnByMonth {
			allMonths[m] = true
		}
		monthKeys := make([]string, 0, len(allMonths))
		for m := range allMonths {
			monthKeys = append(monthKeys, m)
		}
		sort.Slice(monthKeys, func(i, j int) bool {
			return monthSortKey[monthKeys[i]] < monthSortKey[monthKeys[j]]
		})

		mergedTrend := make([]map[string]any, 0, len(monthKeys))
		for _, m := range monthKeys {
			mergedTrend = append(mergedTrend, map[string]any{
				"month":       m,
				"collections": toFloat(collByMonth[m]["collections"]),
				"recovery":    toFloat(recByMonth[m]["recovery"]),
				"volume":      toFloat(txnByMonth[m]["volume"]),
				"txn_count":   toInt64(txnByMonth[m]["txn_count"]),
			})
		}

		acqList := make([]map[string]any, 0, len(acqTrend))
		for _, row := range acqTrend {
			acqList = append(acqList, map[string]any{
				"month":        str(row["month"]),
				"new_accounts": toInt64(row["new_accounts"]),
			})
		}

		overallSource := pickSource(sources)
		respond(w, map[string]any{
			"period": map[string]any{
				"type":       period,
				"label":      periodLabel(period, cs, ce),
				"start":      d(cs),
				"end":        d(ce),
				"prev_start": d(ps),
				"prev_end":   d(pe),
			},
			"financial": map[string]any{
				"collections":          collCurr,
				"collections_prev":     collPrev,
				"collections_change":   pctChange(collCurr, collPrev),
				"collections_count":    int(collCountCurr),
				"recovery":             recCurr,
				"recovery_prev":        recPrev,
				"recovery_change":      pctChange(recCurr, recPrev),
				"txn_volume":           txnVolCurr,
				"txn_volume_prev":      txnVolPrev,
				"txn_volume_change":    pctChange(txnVolCurr, txnVolPrev),
				"txn_count":            int(txnCntCurr),
				"txn_count_prev":       int(txnCntPrev),
				"txn_count_change":     pctChange(txnCntCurr, txnCntPrev),
				"avg_txn_value":        avgTxn,
				"recovery_rate":        recoveryRatePct,
				"total_collected_all":  totalCollectedAll,
				"total_recovered_all":  totalRecoveredAll,
			},
			"growth": map[string]any{
				"new_customers":        int(newCurr),
				"new_customers_prev":   int(newPrev),
				"new_customers_change": pctChange(newCurr, newPrev),
				"total_customers":      int(totalCustomers),
				"active_cards":         int(activeCards),
				"total_cards":          int(totalCards),
				"activation_rate":      activationRate,
				"states_covered":       int(statesCount),
			},
			"trends": map[string]any{
				"monthly":     mergedTrend,
				"acquisition": acqList,
			},
			"breakdowns": map[string]any{
				"top_states":  topStates,
				"product_mix": productMix,
				"top_agents":  topAgents,
			},
		}, overallSource)
	}
}

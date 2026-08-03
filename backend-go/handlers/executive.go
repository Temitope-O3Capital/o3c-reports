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
	r.Get("/fixed-deposits", execFixedDepositsHandler(db))
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

// execRange resolves the drilldown pages' period vocabulary (mtd|l30d|l90d|ytd)
// as well as the standard month|quarter|year|custom into current + previous windows.
// Prevents the 400 the drilldowns used to get (they send mtd/l30d/l90d/ytd, which
// periodDates rejects).
func execRange(r *http.Request) (cs, ce, ps, pe time.Time) {
	today := time.Now().UTC().Truncate(24 * time.Hour)
	switch qstr(r, "period") {
	case "l30d", "l90d":
		n := 30
		if qstr(r, "period") == "l90d" {
			n = 90
		}
		cs = today.AddDate(0, 0, -(n - 1))
		ce = today
		pe = cs.AddDate(0, 0, -1)
		ps = pe.AddDate(0, 0, -(n - 1))
		return
	case "ytd", "year":
		if a, b, c, dd, err := periodDates("year", "", ""); err == nil {
			return a, b, c, dd
		}
	case "quarter":
		if a, b, c, dd, err := periodDates("quarter", "", ""); err == nil {
			return a, b, c, dd
		}
	case "custom":
		if a, b, c, dd, err := periodDates("custom", qstr(r, "start"), qstr(r, "end")); err == nil {
			return a, b, c, dd
		}
	}
	a, b, c, dd, _ := periodDates("month", "", "")
	return a, b, c, dd
}

// execCardsHandler returns the Cards drilldown shape. Real card counts come from the
// live card book (MSSQL dbo.Account, or the synced Postgres "Products" view when MSSQL
// is not configured). No card-transaction / dispute / merchant ledger is synced yet,
// so those series are returned empty rather than fabricated.
func execCardsHandler(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cs, ce, _, _ := execRange(r)
		ctx := r.Context()

		var activeCards, totalCards int64
		if rows, _, e := db.DualQuery(ctx,
			`SELECT
			   SUM(CASE WHEN Status IN ('Open','Active') THEN 1 ELSE 0 END) AS active_cards,
			   COUNT(*) AS total_cards
			 FROM dbo.Account`,
			`SELECT
			   COUNT(*) FILTER (WHERE "Account Status" IN ('Open','Active')) AS active_cards,
			   COUNT(*) AS total_cards
			 FROM "Products"`); e == nil && len(rows) > 0 {
			activeCards = toInt64(rows[0]["active_cards"])
			totalCards = toInt64(rows[0]["total_cards"])
		}
		activation := 0.0
		if totalCards > 0 {
			activation = round1(float64(activeCards) / float64(totalCards) * 100)
		}

		respond(w, map[string]any{
			"period":               map[string]any{"type": qstr(r, "period"), "start": d(cs), "end": d(ce)},
			"active_cards":         activeCards,
			"total_cards":          totalCards,
			"activation_rate_pct":  activation,
			"txn_volume_kobo":      0,
			"txn_change_pct":       0,
			"txn_count":            0,
			"credit_book_kobo":     0,
			"disputes_open":        0,
			"disputes_resolved_mtd": 0,
			"channel_mix":          []any{},
			"monthly_trend":        []any{},
			"top_merchants":        []any{},
		}, "pg")
	}
}

// execFinanceHandler returns the Finance drilldown shape. The FD book is real (CBS
// cbs_fixed_deposits); the GL (gl_journal_entries/gl_accounts) is empty, so revenue /
// expenses / P&L series come back zero/empty rather than fabricated.
func execFinanceHandler(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cs, ce, ps, pe := execRange(r)
		ctx := r.Context()

		var revenueKobo, expensesKobo, prevRevenueKobo int64
		if rows, e := db.PGQuery(ctx, `
			SELECT
				COALESCE(SUM(je.amount_kobo) FILTER (WHERE je.direction='CR' AND a.type='revenue' AND je.created_at::date BETWEEN $1 AND $2), 0) AS rev,
				COALESCE(SUM(je.amount_kobo) FILTER (WHERE je.direction='DR' AND a.type='expense' AND je.created_at::date BETWEEN $1 AND $2), 0) AS exp,
				COALESCE(SUM(je.amount_kobo) FILTER (WHERE je.direction='CR' AND a.type='revenue' AND je.created_at::date BETWEEN $3 AND $4), 0) AS prev_rev
			FROM gl_journal_entries je
			JOIN gl_accounts a ON a.id = je.account_id`, d(cs), d(ce), d(ps), d(pe)); e == nil && len(rows) > 0 {
			revenueKobo = toInt64(rows[0]["rev"])
			expensesKobo = toInt64(rows[0]["exp"])
			prevRevenueKobo = toInt64(rows[0]["prev_rev"])
		}
		netIncome := revenueKobo - expensesKobo
		netMargin := 0.0
		if revenueKobo > 0 {
			netMargin = round1(float64(netIncome) / float64(revenueKobo) * 100)
		}
		revChange := 0.0
		if prevRevenueKobo != 0 {
			revChange = round1(float64(revenueKobo-prevRevenueKobo) / abs64(float64(prevRevenueKobo)) * 100)
		}

		// FD book — real, from the CBS/Udara register.
		var fdBookKobo, fdCount, fdMaturing30d int64
		if rows, e := db.PGQuery(ctx, `
			SELECT
				COALESCE(SUM(principal_kobo) FILTER (WHERE status='Active'), 0) AS book,
				COUNT(*) FILTER (WHERE status='Active')                        AS cnt,
				COUNT(*) FILTER (WHERE status='Active'
					AND maturity_date BETWEEN NOW()::date AND (NOW()+INTERVAL '30 days')::date) AS maturing
			FROM cbs_fixed_deposits`); e == nil && len(rows) > 0 {
			fdBookKobo = toInt64(rows[0]["book"])
			fdCount = toInt64(rows[0]["cnt"])
			fdMaturing30d = toInt64(rows[0]["maturing"])
		}

		respond(w, map[string]any{
			"period":                  map[string]any{"type": qstr(r, "period"), "start": d(cs), "end": d(ce)},
			"total_revenue_kobo":      revenueKobo,
			"revenue_change_pct":      revChange,
			"total_cost_kobo":         expensesKobo,
			"net_income_kobo":         netIncome,
			"net_margin_pct":          netMargin,
			"fd_book_kobo":            fdBookKobo,
			"fd_count":                fdCount,
			"fd_maturing_30d":         fdMaturing30d,
			"settlement_balance_kobo": 0,
			"paystack_wallet_kobo":    paystackWalletKobo(ctx, db),
			"monthly_pnl":             []any{},
			"revenue_breakdown":       []any{},
		}, "pg")
	}
}

// execSalesHandler returns the Sales drilldown shape from the CBS loan book (the
// native LOS pipeline tables are empty). Pipeline = the open loan book; stages = loan
// status mix; top performers = loan officers by book. There is no LOS funnel / activity
// data, so conversion rate / targets / meetings and the calls series are zero/empty.
func execSalesHandler(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cs, ce, _, _ := execRange(r)
		ctx := r.Context()

		var pipelineValueKobo, pipelineCount, conversionsMtd int64
		if rows, e := db.PGQuery(ctx, `
			SELECT
				COALESCE(SUM(outstanding_principal_kobo) FILTER (WHERE status NOT IN ('Closed','Revoked')), 0) AS pipeline_value_kobo,
				COUNT(*) FILTER (WHERE status NOT IN ('Closed','Revoked'))                                     AS pipeline_count,
				COUNT(*) FILTER (WHERE start_date::date BETWEEN $1 AND $2)                                      AS conversions_period
			FROM cbs_loans`, d(cs), d(ce)); e == nil && len(rows) > 0 {
			pipelineValueKobo = toInt64(rows[0]["pipeline_value_kobo"])
			pipelineCount = toInt64(rows[0]["pipeline_count"])
			conversionsMtd = toInt64(rows[0]["conversions_period"])
		}

		// Pipeline stages = loan status mix (open book).
		pipelineStages := make([]map[string]any, 0)
		if rows, e := db.PGQuery(ctx, `
			SELECT status AS stage, COUNT(*) AS count,
			       COALESCE(SUM(outstanding_principal_kobo), 0) AS value_kobo
			FROM cbs_loans
			WHERE status NOT IN ('Closed','Revoked')
			GROUP BY status ORDER BY value_kobo DESC`); e == nil {
			for _, row := range rows {
				pipelineStages = append(pipelineStages, map[string]any{
					"stage": str(row["stage"]), "count": toInt64(row["count"]), "value_kobo": toInt64(row["value_kobo"]),
				})
			}
		}

		// Top performers = loan officers by book size.
		topPerformers := make([]map[string]any, 0)
		if rows, e := db.PGQuery(ctx, `
			SELECT officer_name AS name, COUNT(*) AS conversions,
			       COALESCE(SUM(outstanding_principal_kobo), 0) AS value_kobo
			FROM cbs_loans
			WHERE status NOT IN ('Closed','Revoked') AND officer_name IS NOT NULL AND officer_name <> ''
			GROUP BY officer_name ORDER BY value_kobo DESC LIMIT 10`); e == nil {
			for _, row := range rows {
				topPerformers = append(topPerformers, map[string]any{
					"name": str(row["name"]), "conversions": toInt64(row["conversions"]), "value_kobo": toInt64(row["value_kobo"]),
				})
			}
		}

		// Monthly trend = loans booked per month (real "conversions"); no call data.
		monthlyTrend := make([]map[string]any, 0)
		if rows, e := db.PGQuery(ctx, `
			WITH months AS (
				SELECT generate_series(DATE_TRUNC('month', NOW()) - INTERVAL '5 months',
				                       DATE_TRUNC('month', NOW()), '1 month'::interval) AS m)
			SELECT TO_CHAR(mo.m, 'Mon YY') AS month,
			       COALESCE((SELECT COUNT(*) FROM cbs_loans l WHERE DATE_TRUNC('month', l.start_date) = mo.m), 0) AS conversions
			FROM months mo ORDER BY mo.m`); e == nil {
			for _, row := range rows {
				monthlyTrend = append(monthlyTrend, map[string]any{
					"month": str(row["month"]), "calls": 0, "conversions": toInt64(row["conversions"]),
				})
			}
		}

		respond(w, map[string]any{
			"period":              map[string]any{"type": qstr(r, "period"), "start": d(cs), "end": d(ce)},
			"pipeline_value_kobo": pipelineValueKobo,
			"pipeline_count":      pipelineCount,
			"conversions_mtd":     conversionsMtd,
			"conversion_rate_pct": 0,
			"targets_achieved_pct": 0,
			"meetings_held_mtd":   0,
			"pipeline_stages":     pipelineStages,
			"top_performers":      topPerformers,
			"monthly_trend":       monthlyTrend,
		}, "pg")
	}
}

// execCollectionsHandler returns the Collections drilldown shape derived from the CBS
// loan book (native collections tables are empty). DPD buckets are computed from days
// past maturity_date on the open book. There is no collections-activity ledger (agent
// contacts, promises, collected amounts), so those KPIs / trend / agents are zero/empty.
func execCollectionsHandler(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cs, ce, _, _ := execRange(r)
		ctx := r.Context()

		var v30, v60, v90p int64
		var c30, c60, c6190, c90p, cCurCnt int64
		if rows, e := db.PGQuery(ctx, `
			WITH b AS (
				SELECT outstanding_principal_kobo AS op, (CURRENT_DATE - maturity_date::date) AS od
				FROM cbs_loans WHERE status NOT IN ('Closed','Revoked'))
			SELECT
				COUNT(*) FILTER (WHERE od <= 0)             AS c_cur,
				COUNT(*) FILTER (WHERE od BETWEEN 1 AND 30) AS c_30,
				COALESCE(SUM(op) FILTER (WHERE od BETWEEN 1 AND 30), 0)  AS v_30,
				COUNT(*) FILTER (WHERE od BETWEEN 31 AND 60) AS c_60,
				COALESCE(SUM(op) FILTER (WHERE od BETWEEN 31 AND 60), 0) AS v_60,
				COUNT(*) FILTER (WHERE od BETWEEN 61 AND 90) AS c_6190,
				COUNT(*) FILTER (WHERE od > 90)              AS c_90p,
				COALESCE(SUM(op) FILTER (WHERE od > 90), 0)  AS v_90p
			FROM b`); e == nil && len(rows) > 0 {
			cCurCnt = toInt64(rows[0]["c_cur"])
			c30 = toInt64(rows[0]["c_30"])
			v30 = toInt64(rows[0]["v_30"])
			c60 = toInt64(rows[0]["c_60"])
			v60 = toInt64(rows[0]["v_60"])
			c6190 = toInt64(rows[0]["c_6190"])
			c90p = toInt64(rows[0]["c_90p"])
			v90p = toInt64(rows[0]["v_90p"])
		}

		dpdBreakdown := []map[string]any{
			{"bucket": "Current", "count": cCurCnt},
			{"bucket": "1-30", "count": c30},
			{"bucket": "31-60", "count": c60},
			{"bucket": "61-90", "count": c6190},
			{"bucket": "90+", "count": c90p},
		}

		respond(w, map[string]any{
			"period":              map[string]any{"type": qstr(r, "period"), "start": d(cs), "end": d(ce)},
			"collected_mtd_kobo":  0,
			"collected_change_pct": 0,
			"collection_rate_pct": 0,
			"promise_rate_pct":    0,
			"par30_value_kobo":    v30,
			"par30_count":         c30,
			"par60_value_kobo":    v60,
			"par60_count":         c60,
			"par90_value_kobo":    v90p,
			"par90_count":         c90p,
			"recovery_rate_pct":   0,
			"writeoff_mtd_kobo":   0,
			"dpd_breakdown":       dpdBreakdown,
			"monthly_trend":       []any{},
			"top_agents":          []any{},
		}, "pg")
	}
}

// execRiskHandler returns the Risk drilldown shape from the CBS loan book. Portfolio,
// NPL (Defaulting/Expired), average loan size, top-10 concentration and product
// concentration are real. DPD "trend" is the current point-in-time bucket (there is no
// stored per-month DPD history); vintage performance has no source yet → empty.
func execRiskHandler(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cs, ce, _, _ := execRange(r)
		ctx := r.Context()

		var portfolioKobo, nplKobo, avgLoanKobo, top10Kobo int64
		if rows, e := db.PGQuery(ctx, `
			WITH o AS (
				SELECT outstanding_principal_kobo AS op, loan_amount_kobo AS la, status
				FROM cbs_loans WHERE status NOT IN ('Closed','Revoked'))
			SELECT
				COALESCE(SUM(op), 0)                                                  AS portfolio,
				COALESCE(SUM(op) FILTER (WHERE status IN ('Defaulting','Expired')), 0) AS npl,
				COALESCE(AVG(la), 0)::bigint                                          AS avg_loan,
				(SELECT COALESCE(SUM(op2), 0) FROM (SELECT op AS op2 FROM o ORDER BY op DESC LIMIT 10) t) AS top10
			FROM o`); e == nil && len(rows) > 0 {
			portfolioKobo = toInt64(rows[0]["portfolio"])
			nplKobo = toInt64(rows[0]["npl"])
			avgLoanKobo = toInt64(rows[0]["avg_loan"])
			top10Kobo = toInt64(rows[0]["top10"])
		}
		nplPct, concTop10 := 0.0, 0.0
		if portfolioKobo > 0 {
			nplPct = round1(float64(nplKobo) / float64(portfolioKobo) * 100)
			concTop10 = round1(float64(top10Kobo) / float64(portfolioKobo) * 100)
		}

		productConc := make([]map[string]any, 0)
		if rows, e := db.PGQuery(ctx, `
			SELECT COALESCE(NULLIF(product_name,''),'Other') AS product, COUNT(*) AS count,
			       COALESCE(SUM(outstanding_principal_kobo), 0) AS outstanding_kobo
			FROM cbs_loans WHERE status NOT IN ('Closed','Revoked')
			GROUP BY 1 ORDER BY outstanding_kobo DESC`); e == nil {
			for _, row := range rows {
				productConc = append(productConc, map[string]any{
					"product": str(row["product"]), "count": toInt64(row["count"]), "outstanding_kobo": toInt64(row["outstanding_kobo"]),
				})
			}
		}

		// DPD "trend" — current point-in-time buckets (no per-month history stored).
		dpdTrend := make([]map[string]any, 0)
		if rows, e := db.PGQuery(ctx, `
			WITH b AS (SELECT (CURRENT_DATE - maturity_date::date) AS od
			           FROM cbs_loans WHERE status NOT IN ('Closed','Revoked'))
			SELECT
				COUNT(*) FILTER (WHERE od BETWEEN 1 AND 30)  AS par30,
				COUNT(*) FILTER (WHERE od BETWEEN 31 AND 60) AS par60,
				COUNT(*) FILTER (WHERE od > 90)              AS par90
			FROM b`); e == nil && len(rows) > 0 {
			dpdTrend = append(dpdTrend, map[string]any{
				"month": time.Now().Format("Jan 06"),
				"par30": toInt64(rows[0]["par30"]),
				"par60": toInt64(rows[0]["par60"]),
				"par90": toInt64(rows[0]["par90"]),
			})
		}

		respond(w, map[string]any{
			"period":                    map[string]any{"type": qstr(r, "period"), "start": d(cs), "end": d(ce)},
			"portfolio_outstanding_kobo": portfolioKobo,
			"npl_rate_pct":              nplPct,
			"concentration_top10_pct":   concTop10,
			"avg_loan_size_kobo":        avgLoanKobo,
			"dpd_trend":                 dpdTrend,
			"product_concentration":     productConc,
			"vintage_performance":       []any{},
		}, "pg")
	}
}

// execHRHandler returns the HR drilldown shape. The employees / leave_applications
// tables are currently empty (HR not yet integrated), so these come back zero/empty —
// the queries use the real column names so numbers appear automatically once data lands.
// Returns both the rich drilldown fields and the thin fields the Overview HR tile reads.
func execHRHandler(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cs, ce, _, _ := execRange(r)
		ctx := r.Context()

		var totalEmployees, activeEmployees, newHires, payrollKobo int64
		if rows, e := db.PGQuery(ctx, `
			SELECT
				COUNT(*)                                                       AS total_employees,
				COUNT(*) FILTER (WHERE status = 'active')                      AS active_employees,
				COUNT(*) FILTER (WHERE employment_date BETWEEN $1 AND $2)       AS new_hires,
				COALESCE(SUM(salary_kobo) FILTER (WHERE status = 'active'), 0)  AS payroll_kobo
			FROM employees`, d(cs), d(ce)); e == nil && len(rows) > 0 {
			totalEmployees = toInt64(rows[0]["total_employees"])
			activeEmployees = toInt64(rows[0]["active_employees"])
			newHires = toInt64(rows[0]["new_hires"])
			payrollKobo = toInt64(rows[0]["payroll_kobo"])
		}

		var leavesPending, leavesActive int64
		if rows, e := db.PGQuery(ctx, `
			SELECT
				COUNT(*) FILTER (WHERE status = 'pending')                                                       AS pending,
				COUNT(*) FILTER (WHERE status = 'approved' AND CURRENT_DATE BETWEEN start_date AND end_date)      AS active
			FROM leave_applications`); e == nil && len(rows) > 0 {
			leavesPending = toInt64(rows[0]["pending"])
			leavesActive = toInt64(rows[0]["active"])
		}

		deptBreakdown := make([]map[string]any, 0)
		if rows, e := db.PGQuery(ctx, `
			SELECT COALESCE(dp.name, 'Unassigned') AS dept, COUNT(*) AS count
			FROM employees e LEFT JOIN departments dp ON dp.id = e.department_id
			WHERE e.status = 'active'
			GROUP BY dp.name ORDER BY count DESC`); e == nil {
			for _, row := range rows {
				deptBreakdown = append(deptBreakdown, map[string]any{
					"dept": str(row["dept"]), "count": toInt64(row["count"]),
				})
			}
		}

		respond(w, map[string]any{
			"period":                 map[string]any{"type": qstr(r, "period"), "start": d(cs), "end": d(ce)},
			"headcount":              activeEmployees,
			"headcount_change":       0,
			"new_hires_mtd":          newHires,
			"departures_mtd":         0,
			"attrition_rate_pct":     0,
			"payroll_cost_kobo":      payrollKobo,
			"payroll_change_pct":     0,
			"headcount_trend":        []any{},
			"dept_breakdown":         deptBreakdown,
			"leaves_pending":         leavesPending,
			"leaves_active":          leavesActive,
			"total_employees":        totalEmployees,
			"active_employees":       activeEmployees,
			"new_hires_period":       newHires,
			"pending_leave_requests": leavesPending,
		}, "pg")
	}
}

// execSettlementsHandler returns the Settlements drilldown shape. settlement_batches is
// currently empty (settlements not yet integrated), so amounts/series come back
// zero/empty. Returns both the rich drilldown fields and the thin fields the Overview
// Settlements tile reads.
func execSettlementsHandler(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cs, ce, _, _ := execRange(r)
		ctx := r.Context()

		var pendingCount, settledPeriodCount, failedPeriod int64
		var pendingKobo, settledPeriodKobo int64
		if rows, e := db.PGQuery(ctx, `
			SELECT
				COUNT(*) FILTER (WHERE status = 'pending') AS pending_count,
				COALESCE(SUM(total_amount) FILTER (WHERE status = 'pending'), 0) AS pending_kobo,
				COUNT(*) FILTER (WHERE status = 'settled' AND created_at::date BETWEEN $1 AND $2) AS settled_count,
				COALESCE(SUM(total_amount) FILTER (WHERE status = 'settled' AND created_at::date BETWEEN $1 AND $2), 0) AS settled_kobo,
				COUNT(*) FILTER (WHERE status = 'failed' AND created_at::date BETWEEN $1 AND $2) AS failed_period
			FROM settlement_batches`, d(cs), d(ce)); e == nil && len(rows) > 0 {
			pendingCount = toInt64(rows[0]["pending_count"])
			pendingKobo = toInt64(rows[0]["pending_kobo"])
			settledPeriodCount = toInt64(rows[0]["settled_count"])
			settledPeriodKobo = toInt64(rows[0]["settled_kobo"])
			failedPeriod = toInt64(rows[0]["failed_period"])
		}

		respond(w, map[string]any{
			"period":               map[string]any{"type": qstr(r, "period"), "start": d(cs), "end": d(ce)},
			"settled_today_kobo":   settledPeriodKobo,
			"pending_kobo":         pendingKobo,
			"paystack_wallet_kobo": paystackWalletKobo(ctx, db),
			"nip_success_rate_pct": 0,
			"recon_rate_pct":       0,
			"open_exceptions":      failedPeriod,
			"exception_value_kobo": 0,
			"failed_count":         failedPeriod,
			"daily_trend":          []any{},
			"channel_volumes":      []any{},
			"settled_period_kobo":  settledPeriodKobo,
			"pending_count":        pendingCount,
			"failed_period":        failedPeriod,
			"settled_period_count": settledPeriodCount,
		}, "pg")
	}
}

// execFixedDepositsHandler returns the Fixed Deposits executive drilldown, entirely
// from the CBS/Udara register (cbs_fixed_deposits) — FD is a first-class product line.
// principal_kobo / accrued_interest_kobo are already in kobo.
func execFixedDepositsHandler(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		out := map[string]any{
			"fd_book_kobo": 0, "fd_count": 0, "accrued_interest_kobo": 0,
			"avg_rate_pct": 0.0, "maturing_30d": 0, "maturing_90d": 0,
			"maturity_ladder": []any{}, "product_breakdown": []any{},
			"tenor_breakdown": []any{}, "top_deposits": []any{},
		}

		if rows, e := db.PGQuery(ctx, `
			SELECT
				COALESCE(SUM(principal_kobo) FILTER (WHERE status='Active'), 0)        AS book,
				COUNT(*) FILTER (WHERE status='Active')                               AS cnt,
				COALESCE(SUM(accrued_interest_kobo) FILTER (WHERE status='Active'), 0) AS accrued,
				COALESCE(ROUND(AVG(interest_rate) FILTER (WHERE status='Active'), 1), 0) AS avg_rate,
				COUNT(*) FILTER (WHERE status='Active' AND maturity_date BETWEEN NOW() AND NOW()+INTERVAL '30 days') AS mat30,
				COUNT(*) FILTER (WHERE status='Active' AND maturity_date BETWEEN NOW() AND NOW()+INTERVAL '90 days') AS mat90
			FROM cbs_fixed_deposits`); e == nil && len(rows) > 0 {
			out["fd_book_kobo"] = toInt64(rows[0]["book"])
			out["fd_count"] = toInt64(rows[0]["cnt"])
			out["accrued_interest_kobo"] = toInt64(rows[0]["accrued"])
			out["avg_rate_pct"] = toFloat(rows[0]["avg_rate"])
			out["maturing_30d"] = toInt64(rows[0]["mat30"])
			out["maturing_90d"] = toInt64(rows[0]["mat90"])
		}

		// Maturity ladder — expected payouts (principal + accrued) per month, 12 fwd.
		ladder := make([]map[string]any, 0)
		if rows, e := db.PGQuery(ctx, `
			WITH months AS (
				SELECT generate_series(DATE_TRUNC('month', NOW()),
				                       DATE_TRUNC('month', NOW()) + INTERVAL '11 months', '1 month'::interval) AS m)
			SELECT TO_CHAR(mo.m, 'Mon YY') AS month,
			       COALESCE((SELECT SUM(principal_kobo + COALESCE(accrued_interest_kobo, 0))
			                 FROM cbs_fixed_deposits f
			                 WHERE f.status='Active' AND DATE_TRUNC('month', f.maturity_date) = mo.m), 0) AS payout_kobo
			FROM months mo ORDER BY mo.m`); e == nil {
			for _, row := range rows {
				ladder = append(ladder, map[string]any{"month": str(row["month"]), "payout_kobo": toInt64(row["payout_kobo"])})
			}
		}
		out["maturity_ladder"] = ladder

		// Product breakdown by principal.
		products := make([]map[string]any, 0)
		if rows, e := db.PGQuery(ctx, `
			SELECT COALESCE(NULLIF(product_name,''),'Other') AS product, COUNT(*) AS count,
			       COALESCE(SUM(principal_kobo), 0) AS principal_kobo
			FROM cbs_fixed_deposits WHERE status='Active'
			GROUP BY 1 ORDER BY principal_kobo DESC`); e == nil {
			for _, row := range rows {
				products = append(products, map[string]any{
					"product": str(row["product"]), "count": toInt64(row["count"]), "principal_kobo": toInt64(row["principal_kobo"]),
				})
			}
		}
		out["product_breakdown"] = products

		// Tenor buckets.
		tenor := make([]map[string]any, 0)
		if rows, e := db.PGQuery(ctx, `
			SELECT bucket, COUNT(*) AS count, COALESCE(SUM(principal_kobo),0) AS principal_kobo FROM (
				SELECT principal_kobo,
					CASE WHEN tenor_days <= 90 THEN '0-90d'
					     WHEN tenor_days <= 180 THEN '91-180d'
					     WHEN tenor_days <= 365 THEN '181-365d'
					     ELSE '365d+' END AS bucket,
					CASE WHEN tenor_days <= 90 THEN 1 WHEN tenor_days <= 180 THEN 2 WHEN tenor_days <= 365 THEN 3 ELSE 4 END AS ord
				FROM cbs_fixed_deposits WHERE status='Active') s
			GROUP BY bucket, ord ORDER BY ord`); e == nil {
			for _, row := range rows {
				tenor = append(tenor, map[string]any{
					"bucket": str(row["bucket"]), "count": toInt64(row["count"]), "principal_kobo": toInt64(row["principal_kobo"]),
				})
			}
		}
		out["tenor_breakdown"] = tenor

		// Largest deposits.
		top := make([]map[string]any, 0)
		if rows, e := db.PGQuery(ctx, `
			SELECT cbs_account_number AS account, COALESCE(NULLIF(product_name,''),'Other') AS product,
			       principal_kobo, COALESCE(interest_rate,0) AS rate, maturity_date::date::text AS maturity
			FROM cbs_fixed_deposits WHERE status='Active'
			ORDER BY principal_kobo DESC LIMIT 10`); e == nil {
			for _, row := range rows {
				top = append(top, map[string]any{
					"account": str(row["account"]), "product": str(row["product"]),
					"principal_kobo": toInt64(row["principal_kobo"]), "rate": toFloat(row["rate"]), "maturity": str(row["maturity"]),
				})
			}
		}
		out["top_deposits"] = top

		respond(w, out, "pg")
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

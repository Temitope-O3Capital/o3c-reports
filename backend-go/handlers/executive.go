package handlers

import (
	"fmt"
	"math"
	"net/http"
	"sort"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

func RegisterExecutive(r chi.Router, db *core.DB) {
	r.Use(core.RequirePages("executive"))
	r.Get("/summary", executiveSummary(db))
	r.Get("/cards", execCardsHandler(db))
	r.Get("/finance", execFinanceHandler(db))
	r.Get("/sales", execSalesHandler(db))
	r.Get("/collections", execCollectionsHandler(db))
	r.Get("/risk", execRiskHandler(db))
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
	return round1((curr - prev) / abs64(prev) * 100)
}

func abs64(f float64) float64 {
	if f < 0 {
		return -f
	}
	return f
}

func d(t time.Time) string { return t.Format("2006-01-02") }

// nairaColToKobo converts an app.transactions money column to kobo.
//
// That table stores NAIRA in a NUMERIC (30110.00, 6439.65) while every other money
// value on this platform is integer kobo. pgx hands NUMERIC back as a normalized
// string, which toFloat already parses. Rounding is explicit because 6439.65 * 100 is
// 643964.9999... in binary floating point and a truncating int64() would lose the kobo.
//
// The magnitudes involved (≈₦1.5e10 → 1.5e12 kobo) sit far inside float64's exact
// integer range, so no precision is lost in the multiply.
func nairaColToKobo(v any) int64 {
	return int64(math.Round(toFloat(v) * 100))
}

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

// Card transaction taxonomy.
//
// app.transactions carries ~1m rows keyed by a numeric txn_code. The `channel` column
// is only populated on the Sage-decoded history — the going-forward CSV feed leaves it
// blank — so channel is useless as a current-period dimension and txn_code is what we
// classify on instead.
//
// Two traps this encodes:
//
//  1. `amount` is NAIRA with kobo as decimals (30110.00, 6439.65), not kobo. Everything
//     leaving here is multiplied by 100, because the rest of the platform is kobo.
//  2. Code 604 "Total Interest" is a SUPERSET of 600 "Purchase Txn Interest" and 601
//     "Advance Txn Interest" — verified on matching account+date pairs, where 604
//     consistently exceeds 600+601 rather than equalling it. Summing all three
//     double-counts, so 604 alone is the interest line and 600/601 are left out.
const (
	sqlCatSpend    = `'200','202','303','423','300'` // purchase, foreign, utility, web transfer out, cash advance
	sqlCatSpendRev = `'250','353','473','203'`       // matching reversals
	sqlCatRepay    = `'402','422'`                   // cash payment at bank, web transfer in
	sqlCatRepayRev = `'452','472'`
	sqlCatInterest = `'604'`                   // see note 2 — NOT 600/601
	sqlCatFees     = `'100','105','112','104'` // membership, joining, FX, re-issue
)

// txnCategoryCase buckets a card transaction for the executive mix. Reversals net off
// their own category rather than forming separate slices, so "Spend" reads as spend.
const txnCategoryCase = `
	CASE
		WHEN txn_code IN (` + sqlCatSpend + `)    THEN 'Spend'
		WHEN txn_code IN (` + sqlCatSpendRev + `) THEN 'Spend'
		WHEN txn_code IN (` + sqlCatRepay + `)    THEN 'Repayments'
		WHEN txn_code IN (` + sqlCatRepayRev + `) THEN 'Repayments'
		WHEN txn_code IN (` + sqlCatInterest + `) THEN 'Interest'
		WHEN txn_code IN (` + sqlCatFees + `)     THEN 'Fees'
		ELSE 'Other'
	END`

// signedAmt nets reversals against the category they reverse.
const signedAmt = `
	CASE WHEN txn_code IN (` + sqlCatSpendRev + `,` + sqlCatRepayRev + `)
	     THEN -ABS(amount) ELSE ABS(amount) END`

// execCardsHandler returns the Cards drilldown. Card counts come from the live card
// book (app.accounts); the credit book, limit, utilisation and delinquency come from
// the latest billing cycle in app.card_cycle_data; spend / repayments / interest / fees
// and the merchant league come from app.transactions.
func execCardsHandler(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cs, ce, ps, pe := execRange(r)
		ctx := r.Context()

		var activeCards, totalCards int64
		if rows, _, e := db.DualQuery(ctx,
			`SELECT
			   COUNT(*) FILTER (WHERE status IN ('Open','Active')) AS active_cards,
			   COUNT(*) AS total_cards
			 FROM app.accounts`); e == nil && len(rows) > 0 {
			activeCards = toInt64(rows[0]["active_cards"])
			totalCards = toInt64(rows[0]["total_cards"])
		}
		activation := 0.0
		if totalCards > 0 {
			activation = round1(float64(activeCards) / float64(totalCards) * 100)
		}

		// Credit book — the latest billing cycle is the authoritative statement of what
		// is owed. Only one cycle is loaded today, so cycle_date ships with it and the
		// UI dates the figure rather than implying it is live.
		//
		// Gross and net are reported separately on purpose. Of 18,500 cycle rows only
		// ~1,063 carry a debit balance; 4,086 sit in CREDIT (customers in front of their
		// card, from overpayment or refunds). Netting the two — which a plain SUM does —
		// reports a ₦605.8m book when receivables are actually ₦1,099.6m offset by
		// ₦493.8m owed back to customers. Those are two different facts and an exec
		// needs both: the first is credit exposure, the second is a liability.
		//
		// Delinquency is therefore measured against GROSS receivables. Against the netted
		// figure it would read above 100% and look like a bug rather than a number.
		var grossReceivable, creditBalance, netBook int64
		var creditLimit, overdue, cycleInterest, cycleFees, minPayment int64
		var overdueAccounts, cycleAccounts, debitAccounts, creditAccounts, overLimit int64
		var cycleDate string
		if rows, e := db.PGQuery(ctx, `
			SELECT cycle_date::text AS cycle_date,
			       COUNT(*)                                                                    AS accounts,
			       COALESCE(SUM(outstanding_balance_kobo) FILTER (WHERE outstanding_balance_kobo > 0), 0) AS gross,
			       COUNT(*) FILTER (WHERE outstanding_balance_kobo > 0)                         AS debit_accounts,
			       COALESCE(SUM(outstanding_balance_kobo) FILTER (WHERE outstanding_balance_kobo < 0), 0) AS credit_balance,
			       COUNT(*) FILTER (WHERE outstanding_balance_kobo < 0)                         AS credit_accounts,
			       COALESCE(SUM(outstanding_balance_kobo), 0)                                   AS net_book,
			       COALESCE(SUM(credit_limit_kobo) FILTER (WHERE outstanding_balance_kobo > 0), 0) AS credit_limit,
			       COALESCE(SUM(overdue_amount_kobo), 0)                                        AS overdue,
			       COUNT(*) FILTER (WHERE overdue_amount_kobo > 0)                              AS overdue_accounts,
			       COUNT(*) FILTER (WHERE outstanding_balance_kobo > credit_limit_kobo AND credit_limit_kobo > 0) AS over_limit,
			       COALESCE(SUM(interest_charged_kobo), 0)                                      AS interest,
			       COALESCE(SUM(fees_kobo), 0)                                                  AS fees,
			       COALESCE(SUM(minimum_payment_kobo), 0)                                       AS min_payment
			  FROM app.card_cycle_data
			 WHERE cycle_date = (SELECT MAX(cycle_date) FROM app.card_cycle_data)
			 GROUP BY cycle_date`); e == nil && len(rows) > 0 {
			cycleDate = str(rows[0]["cycle_date"])
			cycleAccounts = toInt64(rows[0]["accounts"])
			grossReceivable = toInt64(rows[0]["gross"])
			debitAccounts = toInt64(rows[0]["debit_accounts"])
			creditBalance = toInt64(rows[0]["credit_balance"])
			creditAccounts = toInt64(rows[0]["credit_accounts"])
			netBook = toInt64(rows[0]["net_book"])
			creditLimit = toInt64(rows[0]["credit_limit"])
			overdue = toInt64(rows[0]["overdue"])
			overdueAccounts = toInt64(rows[0]["overdue_accounts"])
			overLimit = toInt64(rows[0]["over_limit"])
			cycleInterest = toInt64(rows[0]["interest"])
			cycleFees = toInt64(rows[0]["fees"])
			minPayment = toInt64(rows[0]["min_payment"])
		}
		utilisation, delinquency := 0.0, 0.0
		if creditLimit > 0 {
			utilisation = round1(float64(grossReceivable) / float64(creditLimit) * 100)
		}
		if grossReceivable > 0 {
			delinquency = round1(float64(overdue) / float64(grossReceivable) * 100)
		}

		// Period activity, split by category, with the prior window for the delta.
		var spend, repayments, interest, fees, prevSpend int64
		var txnCount int64
		if rows, e := db.PGQuery(ctx, `
			SELECT
			  COALESCE(SUM(`+signedAmt+`) FILTER (WHERE txn_code IN (`+sqlCatSpend+`,`+sqlCatSpendRev+`) AND txn_date BETWEEN $1 AND $2), 0) AS spend,
			  COALESCE(SUM(`+signedAmt+`) FILTER (WHERE txn_code IN (`+sqlCatRepay+`,`+sqlCatRepayRev+`) AND txn_date BETWEEN $1 AND $2), 0) AS repayments,
			  COALESCE(SUM(ABS(amount))  FILTER (WHERE txn_code IN (`+sqlCatInterest+`) AND txn_date BETWEEN $1 AND $2), 0) AS interest,
			  COALESCE(SUM(ABS(amount))  FILTER (WHERE txn_code IN (`+sqlCatFees+`) AND txn_date BETWEEN $1 AND $2), 0) AS fees,
			  COUNT(*) FILTER (WHERE txn_date BETWEEN $1 AND $2) AS txn_count,
			  COALESCE(SUM(`+signedAmt+`) FILTER (WHERE txn_code IN (`+sqlCatSpend+`,`+sqlCatSpendRev+`) AND txn_date BETWEEN $3 AND $4), 0) AS prev_spend
			FROM app.transactions
			WHERE txn_date BETWEEN $3 AND $2`, d(cs), d(ce), d(ps), d(pe)); e == nil && len(rows) > 0 {
			spend = nairaColToKobo(rows[0]["spend"])
			repayments = nairaColToKobo(rows[0]["repayments"])
			interest = nairaColToKobo(rows[0]["interest"])
			fees = nairaColToKobo(rows[0]["fees"])
			txnCount = toInt64(rows[0]["txn_count"])
			prevSpend = nairaColToKobo(rows[0]["prev_spend"])
		}
		spendChange := 0.0
		if prevSpend != 0 {
			spendChange = round1(float64(spend-prevSpend) / abs64(float64(prevSpend)) * 100)
		}

		// Category mix for the period.
		categoryMix := make([]map[string]any, 0)
		if rows, e := db.PGQuery(ctx, `
			SELECT `+txnCategoryCase+` AS category,
			       COUNT(*)                     AS count,
			       COALESCE(SUM(`+signedAmt+`), 0) AS volume
			  FROM app.transactions
			 WHERE txn_date BETWEEN $1 AND $2
			 GROUP BY 1 ORDER BY 3 DESC`, d(cs), d(ce)); e == nil {
			for _, row := range rows {
				categoryMix = append(categoryMix, map[string]any{
					"category":    str(row["category"]),
					"count":       toInt64(row["count"]),
					"volume_kobo": nairaColToKobo(row["volume"]),
				})
			}
		}

		// 12-month trend. Built off a generated month series so a month with no feed
		// shows as a zero rather than vanishing and making the line look continuous —
		// there is a real gap in May 2026 (5 rows) that must stay visible.
		monthlyTrend := make([]map[string]any, 0)
		if rows, e := db.PGQuery(ctx, `
			WITH months AS (
			  SELECT generate_series(DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '11 months',
			                         DATE_TRUNC('month', CURRENT_DATE), '1 month'::interval) AS m)
			SELECT TO_CHAR(mo.m, 'Mon YY') AS month,
			  COALESCE((SELECT SUM(`+signedAmt+`) FROM app.transactions t
			             WHERE DATE_TRUNC('month', t.txn_date) = mo.m
			               AND t.txn_code IN (`+sqlCatSpend+`,`+sqlCatSpendRev+`)), 0) AS spend,
			  COALESCE((SELECT SUM(`+signedAmt+`) FROM app.transactions t
			             WHERE DATE_TRUNC('month', t.txn_date) = mo.m
			               AND t.txn_code IN (`+sqlCatRepay+`,`+sqlCatRepayRev+`)), 0) AS repayments,
			  COALESCE((SELECT SUM(ABS(amount)) FROM app.transactions t
			             WHERE DATE_TRUNC('month', t.txn_date) = mo.m
			               AND t.txn_code IN (`+sqlCatInterest+`)), 0) AS interest,
			  COALESCE((SELECT COUNT(*) FROM app.transactions t
			             WHERE DATE_TRUNC('month', t.txn_date) = mo.m), 0) AS txn_count
			FROM months mo ORDER BY mo.m`); e == nil {
			for _, row := range rows {
				monthlyTrend = append(monthlyTrend, map[string]any{
					"month":           str(row["month"]),
					"spend_kobo":      nairaColToKobo(row["spend"]),
					"repayments_kobo": nairaColToKobo(row["repayments"]),
					"interest_kobo":   nairaColToKobo(row["interest"]),
					"txn_count":       toInt64(row["txn_count"]),
				})
			}
		}

		// Merchant league — spend only. Repayments and interest have no merchant.
		topMerchants := make([]map[string]any, 0)
		if rows, e := db.PGQuery(ctx, `
			SELECT merchant_name AS name, COUNT(*) AS count,
			       COALESCE(SUM(ABS(amount)), 0) AS volume
			  FROM app.transactions
			 WHERE txn_date BETWEEN $1 AND $2
			   AND COALESCE(merchant_name,'') <> ''
			   AND txn_code IN (`+sqlCatSpend+`)
			 GROUP BY 1 ORDER BY 3 DESC LIMIT 10`, d(cs), d(ce)); e == nil {
			for _, row := range rows {
				topMerchants = append(topMerchants, map[string]any{
					"name":        str(row["name"]),
					"count":       toInt64(row["count"]),
					"volume_kobo": nairaColToKobo(row["volume"]),
				})
			}
		}

		// Disputes — app.card_disputes exists and is wired; it is simply empty today,
		// so zero here is a real zero rather than a missing feed.
		var disputesOpen, disputesResolved int64
		if rows, e := db.PGQuery(ctx, `
			SELECT COUNT(*) FILTER (WHERE status NOT IN ('resolved','closed'))            AS open,
			       COUNT(*) FILTER (WHERE resolved_at::date BETWEEN $1 AND $2)            AS resolved
			  FROM app.card_disputes`, d(cs), d(ce)); e == nil && len(rows) > 0 {
			disputesOpen = toInt64(rows[0]["open"])
			disputesResolved = toInt64(rows[0]["resolved"])
		}

		respond(w, map[string]any{
			"period":              map[string]any{"type": qstr(r, "period"), "start": d(cs), "end": d(ce)},
			"active_cards":        activeCards,
			"total_cards":         totalCards,
			"activation_rate_pct": activation,

			"cycle_date":     cycleDate,
			"cycle_accounts": cycleAccounts,
			// credit_book_kobo stays the NET figure for the Overview tile that already
			// reads it; the drilldown uses the gross/credit split beside it.
			"credit_book_kobo":      netBook,
			"gross_receivable_kobo": grossReceivable,
			"debit_accounts":        debitAccounts,
			"credit_balance_kobo":   creditBalance,
			"credit_accounts":       creditAccounts,
			"credit_limit_kobo":     creditLimit,
			"utilisation_pct":       utilisation,
			"overdue_kobo":          overdue,
			"overdue_accounts":      overdueAccounts,
			"over_limit_accounts":   overLimit,
			"delinquency_pct":       delinquency,
			"min_payment_kobo":      minPayment,
			"cycle_interest_kobo":   cycleInterest,
			"cycle_fees_kobo":       cycleFees,

			"spend_kobo":       spend,
			"spend_change_pct": spendChange,
			"repayments_kobo":  repayments,
			"interest_kobo":    interest,
			"fees_kobo":        fees,
			"revenue_kobo":     interest + fees,
			"txn_count":        txnCount,
			"txn_volume_kobo":  spend,
			"txn_change_pct":   spendChange,

			"category_mix":          categoryMix,
			"monthly_trend":         monthlyTrend,
			"top_merchants":         topMerchants,
			"disputes_open":         disputesOpen,
			"disputes_resolved_mtd": disputesResolved,
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

		// The GL is empty — gl_journal_entries has no rows and gl_accounts holds four
		// stub accounts — so the figures above are all zero and cannot be otherwise.
		// Rather than render an empty P&L, the rest of this handler assembles the
		// revenue and cost lines that DO have a source. It is a real operating picture,
		// built from the card and deposit books; it is explicitly not the general
		// ledger, and glAvailable below lets the page say so.
		var glEntries int64
		if rows, e := db.PGQuery(ctx, `SELECT COUNT(*) AS n FROM gl_journal_entries`); e == nil && len(rows) > 0 {
			glEntries = toInt64(rows[0]["n"])
		}

		// Card income for the window, from posted transactions.
		var cardInterest, cardFees, prevCardInterest int64
		if rows, e := db.PGQuery(ctx, `
			SELECT
			  COALESCE(SUM(ABS(amount)) FILTER (WHERE txn_code IN (`+sqlCatInterest+`) AND txn_date BETWEEN $1 AND $2), 0) AS interest,
			  COALESCE(SUM(ABS(amount)) FILTER (WHERE txn_code IN (`+sqlCatFees+`) AND txn_date BETWEEN $1 AND $2), 0) AS fees,
			  COALESCE(SUM(ABS(amount)) FILTER (WHERE txn_code IN (`+sqlCatInterest+`) AND txn_date BETWEEN $3 AND $4), 0) AS prev_interest
			FROM app.transactions
			WHERE txn_date BETWEEN $3 AND $2`, d(cs), d(ce), d(ps), d(pe)); e == nil && len(rows) > 0 {
			cardInterest = nairaColToKobo(rows[0]["interest"])
			cardFees = nairaColToKobo(rows[0]["fees"])
			prevCardInterest = nairaColToKobo(rows[0]["prev_interest"])
		}

		// Cost of deposit funding. accrued_interest_kobo is cumulative to date, not a
		// period figure, so it is reported separately as a balance-sheet number. The
		// period cost is accrued pro-rata from principal and contract rate, which is an
		// estimate and is labelled as one.
		var fdAccruedToDate, fdPeriodCost int64
		var fdAvgRate float64
		days := int64(ce.Sub(cs).Hours()/24) + 1
		if rows, e := db.PGQuery(ctx, `
			SELECT COALESCE(SUM(accrued_interest_kobo), 0) AS accrued,
			       COALESCE(AVG(interest_rate), 0)         AS avg_rate,
			       COALESCE(SUM(ROUND(principal_kobo * (COALESCE(interest_rate,0)/100.0) * ($1::numeric/365.0))), 0) AS period_cost
			  FROM cbs_fixed_deposits WHERE status='Active'`, days); e == nil && len(rows) > 0 {
			fdAccruedToDate = toInt64(rows[0]["accrued"])
			fdAvgRate = round1(toFloat(rows[0]["avg_rate"]))
			fdPeriodCost = toInt64(rows[0]["period_cost"])
		}

		// Payment processing cost.
		var processingFees int64
		if rows, e := db.PGQuery(ctx, `
			SELECT COALESCE((SELECT SUM(fee_kobo) FROM app.paystack_transfers
			                  WHERE status='success'
			                    AND COALESCE(transferred_at, created_at_ps)::date BETWEEN $1 AND $2), 0)
			     + COALESCE((SELECT SUM(fees_kobo) FROM app.paystack_transactions
			                  WHERE status='success' AND paid_at::date BETWEEN $1 AND $2), 0) AS fees`,
			d(cs), d(ce)); e == nil && len(rows) > 0 {
			processingFees = toInt64(rows[0]["fees"])
		}

		operatingRevenue := cardInterest + cardFees
		operatingCost := fdPeriodCost + processingFees
		operatingNet := operatingRevenue - operatingCost
		opMargin := 0.0
		if operatingRevenue > 0 {
			opMargin = round1(float64(operatingNet) / float64(operatingRevenue) * 100)
		}
		cardIntChange := 0.0
		if prevCardInterest != 0 {
			cardIntChange = round1(float64(cardInterest-prevCardInterest) / abs64(float64(prevCardInterest)) * 100)
		}

		revenueBreakdown := []map[string]any{
			{"source": "Card interest", "amount_kobo": cardInterest},
			{"source": "Card fees", "amount_kobo": cardFees},
		}
		costBreakdown := []map[string]any{
			{"source": "Deposit interest (est.)", "amount_kobo": fdPeriodCost},
			{"source": "Payment processing", "amount_kobo": processingFees},
		}

		// 12-month card income series — the only revenue line with real history.
		monthlyPnl := make([]map[string]any, 0)
		if rows, e := db.PGQuery(ctx, `
			WITH months AS (
			  SELECT generate_series(DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '11 months',
			                         DATE_TRUNC('month', CURRENT_DATE), '1 month'::interval) AS m)
			SELECT TO_CHAR(mo.m, 'Mon YY') AS month,
			  COALESCE((SELECT SUM(ABS(amount)) FROM app.transactions t
			             WHERE DATE_TRUNC('month', t.txn_date) = mo.m
			               AND t.txn_code IN (`+sqlCatInterest+`)), 0) AS interest,
			  COALESCE((SELECT SUM(ABS(amount)) FROM app.transactions t
			             WHERE DATE_TRUNC('month', t.txn_date) = mo.m
			               AND t.txn_code IN (`+sqlCatFees+`)), 0) AS fees
			FROM months mo ORDER BY mo.m`); e == nil {
			for _, row := range rows {
				iv := nairaColToKobo(row["interest"])
				fv := nairaColToKobo(row["fees"])
				monthlyPnl = append(monthlyPnl, map[string]any{
					"month":         str(row["month"]),
					"interest_kobo": iv,
					"fees_kobo":     fv,
					"revenue_kobo":  iv + fv,
				})
			}
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

			// Operating picture, assembled from the card and deposit books.
			"gl_available":             glEntries > 0,
			"gl_entry_count":           glEntries,
			"operating_revenue_kobo":   operatingRevenue,
			"operating_cost_kobo":      operatingCost,
			"operating_net_kobo":       operatingNet,
			"operating_margin_pct":     opMargin,
			"card_interest_kobo":       cardInterest,
			"card_interest_change_pct": cardIntChange,
			"card_fees_kobo":           cardFees,
			"fd_period_cost_kobo":      fdPeriodCost,
			"fd_accrued_to_date_kobo":  fdAccruedToDate,
			"fd_avg_rate_pct":          fdAvgRate,
			"processing_fees_kobo":     processingFees,
			"period_days":              days,
			"revenue_breakdown":        revenueBreakdown,
			"cost_breakdown":           costBreakdown,
			"monthly_pnl":              monthlyPnl,
		}, "pg")
	}
}

// execSalesHandler returns the Sales drilldown shape from the CBS loan book (the
// native LOS pipeline tables are empty). Pipeline = the open loan book; stages = loan
// status mix; top performers = loan officers by book. There is no LOS funnel / activity
// data, so conversion rate / targets / meetings and the calls series are zero/empty.
func execSalesHandler(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cs, ce, ps, pe := execRange(r)
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

		// Acquisition. For this business "sales" is mostly accounts opened, not a loan
		// pipeline — the LOS tables are empty and cbs_loans holds 19 rows, while the
		// card book records real openings every month. app.accounts.opened_date is the
		// origination date.
		var newAccounts, prevNewAccounts, newFD, newFDKobo int64
		if rows, e := db.PGQuery(ctx, `
			SELECT COUNT(*) FILTER (WHERE opened_date BETWEEN $1 AND $2) AS curr,
			       COUNT(*) FILTER (WHERE opened_date BETWEEN $3 AND $4) AS prev
			  FROM app.accounts`, d(cs), d(ce), d(ps), d(pe)); e == nil && len(rows) > 0 {
			newAccounts = toInt64(rows[0]["curr"])
			prevNewAccounts = toInt64(rows[0]["prev"])
		}
		acquisitionChange := 0.0
		if prevNewAccounts != 0 {
			acquisitionChange = round1(float64(newAccounts-prevNewAccounts) / abs64(float64(prevNewAccounts)) * 100)
		}

		if rows, e := db.PGQuery(ctx, `
			SELECT COUNT(*) AS n, COALESCE(SUM(principal_kobo), 0) AS principal
			  FROM cbs_fixed_deposits WHERE commencement_date::date BETWEEN $1 AND $2`, d(cs), d(ce)); e == nil && len(rows) > 0 {
			newFD = toInt64(rows[0]["n"])
			newFDKobo = toInt64(rows[0]["principal"])
		}

		acquisitionMix := make([]map[string]any, 0)
		if rows, e := db.PGQuery(ctx, `
			SELECT COALESCE(NULLIF(product_line,''),'unclassified') AS product_line,
			       COUNT(*) FILTER (WHERE opened_date BETWEEN $1 AND $2) AS opened,
			       COUNT(*) AS total
			  FROM app.accounts
			 GROUP BY 1 ORDER BY 2 DESC, 3 DESC`, d(cs), d(ce)); e == nil {
			for _, row := range rows {
				acquisitionMix = append(acquisitionMix, map[string]any{
					"product_line": str(row["product_line"]),
					"opened":       toInt64(row["opened"]),
					"total":        toInt64(row["total"]),
				})
			}
		}

		acquisitionTrend := make([]map[string]any, 0)
		if rows, e := db.PGQuery(ctx, `
			WITH months AS (
			  SELECT generate_series(DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '11 months',
			                         DATE_TRUNC('month', CURRENT_DATE), '1 month'::interval) AS m)
			SELECT TO_CHAR(mo.m, 'Mon YY') AS month,
			  COALESCE((SELECT COUNT(*) FROM app.accounts a
			             WHERE DATE_TRUNC('month', a.opened_date) = mo.m), 0) AS accounts,
			  COALESCE((SELECT COUNT(*) FROM cbs_fixed_deposits f
			             WHERE DATE_TRUNC('month', f.commencement_date) = mo.m), 0) AS deposits,
			  COALESCE((SELECT COUNT(*) FROM cbs_loans l
			             WHERE DATE_TRUNC('month', l.start_date) = mo.m), 0) AS loans
			FROM months mo ORDER BY mo.m`); e == nil {
			for _, row := range rows {
				acquisitionTrend = append(acquisitionTrend, map[string]any{
					"month":    str(row["month"]),
					"accounts": toInt64(row["accounts"]),
					"deposits": toInt64(row["deposits"]),
					"loans":    toInt64(row["loans"]),
				})
			}
		}

		respond(w, map[string]any{
			"period":               map[string]any{"type": qstr(r, "period"), "start": d(cs), "end": d(ce)},
			"pipeline_value_kobo":  pipelineValueKobo,
			"pipeline_count":       pipelineCount,
			"conversions_mtd":      conversionsMtd,
			"conversion_rate_pct":  0,
			"targets_achieved_pct": 0,
			"meetings_held_mtd":    0,
			"pipeline_stages":      pipelineStages,
			"top_performers":       topPerformers,
			"monthly_trend":        monthlyTrend,

			"new_accounts":           newAccounts,
			"acquisition_change_pct": acquisitionChange,
			"new_deposits":           newFD,
			"new_deposit_value_kobo": newFDKobo,
			"acquisition_mix":        acquisitionMix,
			"acquisition_trend":      acquisitionTrend,
		}, "pg")
	}
}

// execCollectionsHandler returns the Collections drilldown shape derived from the CBS
// loan book (native collections tables are empty). DPD buckets are computed from days
// the rebuilt amortisation schedule on the open book (app.cbs_loan_dpd, migration 151).
// There is no collections-activity ledger (agent contacts, promises, collected amounts),
// so those KPIs / trend / agents are zero/empty.
func execCollectionsHandler(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cs, ce, _, _ := execRange(r)
		ctx := r.Context()

		var v30, v60, v90p int64
		var c30, c60, c6190, c90p, cCurCnt int64
		if rows, e := db.PGQuery(ctx, `
			WITH b AS (
				SELECT outstanding_principal_kobo AS op, `+cbsLoanDPDBare+` AS od
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

		// The assigned book. app.collection_assignments is where collections actually
		// lives — cbs_loans holds 19 loans, while 1,228 accounts worth billions sit
		// assigned to agents here. The DPD ladder below is the real one.
		var assignedKobo, assignedCount, agentCount, targetKobo int64
		if rows, e := db.PGQuery(ctx, `
			SELECT COUNT(*) AS n, COALESCE(SUM(outstanding_kobo), 0) AS outstanding,
			       COALESCE(SUM(target_amount_kobo), 0) AS target,
			       COUNT(DISTINCT agent_user_id) AS agents
			  FROM app.collection_assignments WHERE status='active'`); e == nil && len(rows) > 0 {
			assignedCount = toInt64(rows[0]["n"])
			assignedKobo = toInt64(rows[0]["outstanding"])
			targetKobo = toInt64(rows[0]["target"])
			agentCount = toInt64(rows[0]["agents"])
		}

		// Ordered by real delinquency depth, not alphabetically — an exec reads this
		// ladder left to right expecting it to get worse.
		assignedLadder := make([]map[string]any, 0)
		if rows, e := db.PGQuery(ctx, `
			SELECT COALESCE(NULLIF(dpd_bucket,''),'unclassified') AS bucket,
			       COUNT(*) AS count, COALESCE(SUM(outstanding_kobo), 0) AS value_kobo
			  FROM app.collection_assignments WHERE status='active'
			 GROUP BY 1
			 ORDER BY CASE COALESCE(NULLIF(dpd_bucket,''),'unclassified')
			            WHEN '1-30' THEN 1 WHEN '31-60' THEN 2 WHEN '61-90' THEN 3
			            WHEN '91-180' THEN 4 WHEN '181-360' THEN 5 WHEN '360+' THEN 6
			            ELSE 7 END`); e == nil {
			for _, row := range rows {
				assignedLadder = append(assignedLadder, map[string]any{
					"bucket": str(row["bucket"]), "count": toInt64(row["count"]), "value_kobo": toInt64(row["value_kobo"]),
				})
			}
		}

		// Who is carrying what.
		topAgents := make([]map[string]any, 0)
		if rows, e := db.PGQuery(ctx, `
			SELECT COALESCE(NULLIF(u.full_name,''), 'Agent ' || a.agent_user_id::text) AS name,
			       COUNT(*) AS accounts,
			       COALESCE(SUM(a.outstanding_kobo), 0)   AS assigned_kobo,
			       COALESCE(SUM(a.target_amount_kobo), 0) AS target_kobo,
			       COUNT(*) FILTER (WHERE a.dpd_bucket IN ('181-360','360+')) AS deep_accounts
			  FROM app.collection_assignments a
			  LEFT JOIN o3c_users u ON u.id = a.agent_user_id
			 WHERE a.status='active'
			 GROUP BY 1 ORDER BY 3 DESC LIMIT 12`); e == nil {
			for _, row := range rows {
				topAgents = append(topAgents, map[string]any{
					"name":          str(row["name"]),
					"accounts":      toInt64(row["accounts"]),
					"assigned_kobo": toInt64(row["assigned_kobo"]),
					"target_kobo":   toInt64(row["target_kobo"]),
					"deep_accounts": toInt64(row["deep_accounts"]),
				})
			}
		}

		// Card delinquency — the card book dwarfs the loan book, so a collections view
		// that ignores it is describing the smaller half of the problem.
		var cardOverdue, cardOverdueAccts int64
		if rows, e := db.PGQuery(ctx, `
			SELECT COALESCE(SUM(overdue_amount_kobo), 0) AS overdue,
			       COUNT(*) FILTER (WHERE overdue_amount_kobo > 0) AS accts
			  FROM app.card_cycle_data
			 WHERE cycle_date = (SELECT MAX(cycle_date) FROM app.card_cycle_data)`); e == nil && len(rows) > 0 {
			cardOverdue = toInt64(rows[0]["overdue"])
			cardOverdueAccts = toInt64(rows[0]["accts"])
		}

		// Recorded collections activity. These tables exist and are wired; all are
		// empty, so the page can state that no contact, promise or payment has been
		// logged rather than showing a zero that looks like a quiet week.
		var contactsN, promisesN, paymentsN, collectedKobo int64
		if rows, e := db.PGQuery(ctx, `
			SELECT (SELECT COUNT(*) FROM app.collection_contacts WHERE created_at::date BETWEEN $1 AND $2) AS contacts,
			       (SELECT COUNT(*) FROM app.collection_promises WHERE created_at::date BETWEEN $1 AND $2) AS promises,
			       (SELECT COUNT(*) FROM app.collection_payments WHERE created_at::date BETWEEN $1 AND $2) AS payments,
			       (SELECT COALESCE(SUM(amount_kobo),0) FROM app.collection_payments WHERE created_at::date BETWEEN $1 AND $2) AS collected`,
			d(cs), d(ce)); e == nil && len(rows) > 0 {
			contactsN = toInt64(rows[0]["contacts"])
			promisesN = toInt64(rows[0]["promises"])
			paymentsN = toInt64(rows[0]["payments"])
			collectedKobo = toInt64(rows[0]["collected"])
		}

		respond(w, map[string]any{
			"period":               map[string]any{"type": qstr(r, "period"), "start": d(cs), "end": d(ce)},
			"collected_mtd_kobo":   collectedKobo,
			"collected_change_pct": 0,
			"collection_rate_pct":  0,
			"promise_rate_pct":     0,
			"par30_value_kobo":     v30,
			"par30_count":          c30,
			"par60_value_kobo":     v60,
			"par60_count":          c60,
			"par90_value_kobo":     v90p,
			"par90_count":          c90p,
			"recovery_rate_pct":    0,
			"writeoff_mtd_kobo":    0,
			"dpd_breakdown":        dpdBreakdown,
			"monthly_trend":        []any{},

			"assigned_kobo":         assignedKobo,
			"assigned_count":        assignedCount,
			"assigned_target_kobo":  targetKobo,
			"agent_count":           agentCount,
			"assigned_ladder":       assignedLadder,
			"top_agents":            topAgents,
			"card_overdue_kobo":     cardOverdue,
			"card_overdue_accounts": cardOverdueAccts,
			"activity_contacts":     contactsN,
			"activity_promises":     promisesN,
			"activity_payments":     paymentsN,
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
			WITH b AS (SELECT `+cbsLoanDPDBare+` AS od
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

		// Card exposure. The card book is the larger credit asset, so a risk view drawn
		// only from cbs_loans understates total exposure by roughly two thirds.
		var cardGross, cardOverdue, cardTop10, cardTop50 int64
		var cardAccounts int64
		if rows, e := db.PGQuery(ctx, `
			WITH g AS (
			  SELECT outstanding_balance_kobo AS v, overdue_amount_kobo AS od
			    FROM app.card_cycle_data
			   WHERE cycle_date = (SELECT MAX(cycle_date) FROM app.card_cycle_data)
			     AND outstanding_balance_kobo > 0)
			SELECT COALESCE(SUM(v), 0) AS gross, COUNT(*) AS accounts,
			       COALESCE(SUM(od), 0) AS overdue,
			       COALESCE((SELECT SUM(v) FROM (SELECT v FROM g ORDER BY v DESC LIMIT 10) t), 0) AS top10,
			       COALESCE((SELECT SUM(v) FROM (SELECT v FROM g ORDER BY v DESC LIMIT 50) t), 0) AS top50
			  FROM g`); e == nil && len(rows) > 0 {
			cardGross = toInt64(rows[0]["gross"])
			cardAccounts = toInt64(rows[0]["accounts"])
			cardOverdue = toInt64(rows[0]["overdue"])
			cardTop10 = toInt64(rows[0]["top10"])
			cardTop50 = toInt64(rows[0]["top50"])
		}
		cardTop10Pct, cardTop50Pct, cardNplPct := 0.0, 0.0, 0.0
		if cardGross > 0 {
			cardTop10Pct = round1(float64(cardTop10) / float64(cardGross) * 100)
			cardTop50Pct = round1(float64(cardTop50) / float64(cardGross) * 100)
			cardNplPct = round1(float64(cardOverdue) / float64(cardGross) * 100)
		}

		// Card product risk — delinquency per product, worst first.
		cardProducts := make([]map[string]any, 0)
		if rows, e := db.PGQuery(ctx, `
			SELECT COALESCE(NULLIF(product_code,''),'?') AS product,
			       COUNT(*) FILTER (WHERE outstanding_balance_kobo > 0) AS count,
			       COALESCE(SUM(outstanding_balance_kobo) FILTER (WHERE outstanding_balance_kobo > 0), 0) AS outstanding_kobo,
			       COALESCE(SUM(overdue_amount_kobo), 0) AS overdue_kobo
			  FROM app.card_cycle_data
			 WHERE cycle_date = (SELECT MAX(cycle_date) FROM app.card_cycle_data)
			 GROUP BY 1 HAVING COALESCE(SUM(outstanding_balance_kobo) FILTER (WHERE outstanding_balance_kobo > 0), 0) > 0
			 ORDER BY 3 DESC LIMIT 10`); e == nil {
			for _, row := range rows {
				out := toInt64(row["outstanding_kobo"])
				od := toInt64(row["overdue_kobo"])
				rate := 0.0
				if out > 0 {
					rate = round1(float64(od) / float64(out) * 100)
				}
				cardProducts = append(cardProducts, map[string]any{
					"product":          str(row["product"]),
					"count":            toInt64(row["count"]),
					"outstanding_kobo": out,
					"overdue_kobo":     od,
					"delinquency_pct":  rate,
				})
			}
		}

		// Funding side. Fixed deposits are a liability — money owed back to depositors —
		// and they are several times the size of the credit book. Reporting assets
		// without them makes the balance sheet look far smaller than it is.
		var fdLiability, fdCount, fdMaturing30, fdMaturing90 int64
		if rows, e := db.PGQuery(ctx, `
			SELECT COALESCE(SUM(principal_kobo + COALESCE(accrued_interest_kobo,0)), 0) AS liability,
			       COUNT(*) AS cnt,
			       COALESCE(SUM(principal_kobo + COALESCE(accrued_interest_kobo,0))
			                FILTER (WHERE maturity_date BETWEEN NOW() AND NOW()+INTERVAL '30 days'), 0) AS mat30,
			       COALESCE(SUM(principal_kobo + COALESCE(accrued_interest_kobo,0))
			                FILTER (WHERE maturity_date BETWEEN NOW() AND NOW()+INTERVAL '90 days'), 0) AS mat90
			  FROM cbs_fixed_deposits WHERE status='Active'`); e == nil && len(rows) > 0 {
			fdLiability = toInt64(rows[0]["liability"])
			fdCount = toInt64(rows[0]["cnt"])
			fdMaturing30 = toInt64(rows[0]["mat30"])
			fdMaturing90 = toInt64(rows[0]["mat90"])
		}

		creditAssets := cardGross + portfolioKobo
		coverage := 0.0
		if fdLiability > 0 {
			coverage = round1(float64(creditAssets) / float64(fdLiability) * 100)
		}

		respond(w, map[string]any{
			"period":                     map[string]any{"type": qstr(r, "period"), "start": d(cs), "end": d(ce)},
			"portfolio_outstanding_kobo": portfolioKobo,
			"npl_rate_pct":               nplPct,
			"concentration_top10_pct":    concTop10,
			"avg_loan_size_kobo":         avgLoanKobo,
			"dpd_trend":                  dpdTrend,
			"product_concentration":      productConc,
			"vintage_performance":        []any{},

			"card_exposure_kobo":   cardGross,
			"card_accounts":        cardAccounts,
			"card_overdue_kobo":    cardOverdue,
			"card_npl_pct":         cardNplPct,
			"card_top10_pct":       cardTop10Pct,
			"card_top50_pct":       cardTop50Pct,
			"card_products":        cardProducts,
			"credit_assets_kobo":   creditAssets,
			"fd_liability_kobo":    fdLiability,
			"fd_count":             fdCount,
			"fd_maturing_30d_kobo": fdMaturing30,
			"fd_maturing_90d_kobo": fdMaturing90,
			"asset_coverage_pct":   coverage,
		}, "pg")
	}
}

// execSettlementsHandler returns the Settlements drilldown.
//
// It used to read settlement_batches, which has never held a row — so the page showed
// zeros while the real money movement sat in the Paystack mirror and the reconciliation
// engine. Money out is app.paystack_transfers (payouts), money in is
// app.paystack_transactions (collections), and the matched/unmatched position comes
// from app.recon_matches / app.recon_exceptions.
func execSettlementsHandler(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cs, ce, ps, pe := execRange(r)
		ctx := r.Context()

		// Payouts. transferred_at is null until a transfer lands, so fall back to the
		// Paystack create time rather than dropping in-flight transfers from the count.
		var payoutKobo, payoutCount, payoutFailedKobo, payoutFailedCount, payoutFeeKobo, prevPayoutKobo int64
		if rows, e := db.PGQuery(ctx, `
			SELECT
			  COALESCE(SUM(amount_kobo) FILTER (WHERE status='success' AND dt BETWEEN $1 AND $2), 0) AS paid,
			  COUNT(*)                  FILTER (WHERE status='success' AND dt BETWEEN $1 AND $2)     AS paid_n,
			  COALESCE(SUM(amount_kobo) FILTER (WHERE status='failed'  AND dt BETWEEN $1 AND $2), 0) AS failed,
			  COUNT(*)                  FILTER (WHERE status='failed'  AND dt BETWEEN $1 AND $2)     AS failed_n,
			  COALESCE(SUM(fee_kobo)    FILTER (WHERE status='success' AND dt BETWEEN $1 AND $2), 0) AS fees,
			  COALESCE(SUM(amount_kobo) FILTER (WHERE status='success' AND dt BETWEEN $3 AND $4), 0) AS prev_paid
			FROM (SELECT status, amount_kobo, fee_kobo,
			             COALESCE(transferred_at, created_at_ps)::date AS dt
			        FROM app.paystack_transfers) t`, d(cs), d(ce), d(ps), d(pe)); e == nil && len(rows) > 0 {
			payoutKobo = toInt64(rows[0]["paid"])
			payoutCount = toInt64(rows[0]["paid_n"])
			payoutFailedKobo = toInt64(rows[0]["failed"])
			payoutFailedCount = toInt64(rows[0]["failed_n"])
			payoutFeeKobo = toInt64(rows[0]["fees"])
			prevPayoutKobo = toInt64(rows[0]["prev_paid"])
		}
		payoutChange := 0.0
		if prevPayoutKobo != 0 {
			payoutChange = round1(float64(payoutKobo-prevPayoutKobo) / abs64(float64(prevPayoutKobo)) * 100)
		}
		successRate := 0.0
		if payoutCount+payoutFailedCount > 0 {
			successRate = round1(float64(payoutCount) / float64(payoutCount+payoutFailedCount) * 100)
		}

		// Collections in.
		var collectKobo, collectCount, collectFeeKobo int64
		if rows, e := db.PGQuery(ctx, `
			SELECT COALESCE(SUM(amount_kobo), 0) AS amt, COUNT(*) AS n,
			       COALESCE(SUM(fees_kobo), 0)   AS fees
			  FROM app.paystack_transactions
			 WHERE status='success' AND paid_at::date BETWEEN $1 AND $2`, d(cs), d(ce)); e == nil && len(rows) > 0 {
			collectKobo = toInt64(rows[0]["amt"])
			collectCount = toInt64(rows[0]["n"])
			collectFeeKobo = toInt64(rows[0]["fees"])
		}

		channelVolumes := make([]map[string]any, 0)
		if rows, e := db.PGQuery(ctx, `
			SELECT COALESCE(NULLIF(channel,''),'other') AS channel, COUNT(*) AS count,
			       COALESCE(SUM(amount_kobo), 0) AS volume_kobo,
			       COALESCE(SUM(fees_kobo), 0)   AS fees_kobo
			  FROM app.paystack_transactions
			 WHERE status='success' AND paid_at::date BETWEEN $1 AND $2
			 GROUP BY 1 ORDER BY 3 DESC`, d(cs), d(ce)); e == nil {
			for _, row := range rows {
				channelVolumes = append(channelVolumes, map[string]any{
					"channel":     str(row["channel"]),
					"count":       toInt64(row["count"]),
					"volume_kobo": toInt64(row["volume_kobo"]),
					"fees_kobo":   toInt64(row["fees_kobo"]),
				})
			}
		}

		// Reconciliation position. Exceptions are the whole open book, not the period —
		// an unmatched item from March is still unmatched today and is exactly what an
		// exec needs to see. Everything else here is period-scoped.
		var matched, unmatched, exceptionKobo int64
		var lastRun string
		if rows, e := db.PGQuery(ctx, `
			SELECT COALESCE(SUM(matched_n), 0) AS matched, COALESCE(SUM(unmatched_n), 0) AS unmatched,
			       MAX(finished_at)::date::text AS last_run
			  FROM app.recon_runs WHERE status='ok'`); e == nil && len(rows) > 0 {
			matched = toInt64(rows[0]["matched"])
			unmatched = toInt64(rows[0]["unmatched"])
			lastRun = str(rows[0]["last_run"])
		}
		reconRate := 0.0
		if matched+unmatched > 0 {
			reconRate = round1(float64(matched) / float64(matched+unmatched) * 100)
		}

		var openExceptions int64
		if rows, e := db.PGQuery(ctx, `
			SELECT COUNT(*) AS n, COALESCE(SUM(amount_kobo), 0) AS val
			  FROM app.recon_exceptions WHERE status='open'`); e == nil && len(rows) > 0 {
			openExceptions = toInt64(rows[0]["n"])
			exceptionKobo = toInt64(rows[0]["val"])
		}

		exceptionReasons := make([]map[string]any, 0)
		if rows, e := db.PGQuery(ctx, `
			SELECT COALESCE(NULLIF(reason,''),'unclassified') AS reason, COUNT(*) AS count,
			       COALESCE(SUM(amount_kobo), 0) AS value_kobo
			  FROM app.recon_exceptions WHERE status='open'
			 GROUP BY 1 ORDER BY 3 DESC`); e == nil {
			for _, row := range rows {
				exceptionReasons = append(exceptionReasons, map[string]any{
					"reason": str(row["reason"]), "count": toInt64(row["count"]), "value_kobo": toInt64(row["value_kobo"]),
				})
			}
		}

		// Ageing — how long the unmatched money has been sitting there.
		exceptionAgeing := make([]map[string]any, 0)
		if rows, e := db.PGQuery(ctx, `
			SELECT bucket, COUNT(*) AS count, COALESCE(SUM(amount_kobo), 0) AS value_kobo FROM (
			  SELECT amount_kobo,
			    CASE WHEN CURRENT_DATE - txn_date <= 7  THEN '0-7d'
			         WHEN CURRENT_DATE - txn_date <= 30 THEN '8-30d'
			         WHEN CURRENT_DATE - txn_date <= 90 THEN '31-90d'
			         ELSE '90d+' END AS bucket,
			    CASE WHEN CURRENT_DATE - txn_date <= 7  THEN 1
			         WHEN CURRENT_DATE - txn_date <= 30 THEN 2
			         WHEN CURRENT_DATE - txn_date <= 90 THEN 3 ELSE 4 END AS ord
			    FROM app.recon_exceptions WHERE status='open') s
			GROUP BY bucket, ord ORDER BY ord`); e == nil {
			for _, row := range rows {
				exceptionAgeing = append(exceptionAgeing, map[string]any{
					"bucket": str(row["bucket"]), "count": toInt64(row["count"]), "value_kobo": toInt64(row["value_kobo"]),
				})
			}
		}

		// Daily flow across the window, zero-filled so a quiet day reads as a quiet day
		// rather than closing the gap and implying continuous settlement.
		dailyTrend := make([]map[string]any, 0)
		if rows, e := db.PGQuery(ctx, `
			WITH days AS (SELECT generate_series($1::date, $2::date, '1 day')::date AS dd)
			SELECT TO_CHAR(days.dd, 'DD Mon') AS day,
			  COALESCE((SELECT SUM(amount_kobo) FROM app.paystack_transfers t
			             WHERE t.status='success'
			               AND COALESCE(t.transferred_at, t.created_at_ps)::date = days.dd), 0) AS payouts_kobo,
			  COALESCE((SELECT SUM(amount_kobo) FROM app.paystack_transactions p
			             WHERE p.status='success' AND p.paid_at::date = days.dd), 0) AS collections_kobo
			FROM days ORDER BY days.dd`, d(cs), d(ce)); e == nil {
			for _, row := range rows {
				dailyTrend = append(dailyTrend, map[string]any{
					"day":              str(row["day"]),
					"payouts_kobo":     toInt64(row["payouts_kobo"]),
					"collections_kobo": toInt64(row["collections_kobo"]),
				})
			}
		}

		// Paystack settlements actually paid into the bank in the window.
		var settledKobo, settledCount int64
		if rows, e := db.PGQuery(ctx, `
			SELECT COALESCE(SUM(total_amount_kobo), 0) AS amt, COUNT(*) AS n
			  FROM app.paystack_settlements
			 WHERE settlement_date::date BETWEEN $1 AND $2`, d(cs), d(ce)); e == nil && len(rows) > 0 {
			settledKobo = toInt64(rows[0]["amt"])
			settledCount = toInt64(rows[0]["n"])
		}

		respond(w, map[string]any{
			"period": map[string]any{"type": qstr(r, "period"), "start": d(cs), "end": d(ce)},

			"payouts_kobo":         payoutKobo,
			"payouts_count":        payoutCount,
			"payouts_change_pct":   payoutChange,
			"payout_fees_kobo":     payoutFeeKobo,
			"failed_count":         payoutFailedCount,
			"failed_value_kobo":    payoutFailedKobo,
			"nip_success_rate_pct": successRate,

			"collections_kobo":     collectKobo,
			"collections_count":    collectCount,
			"collection_fees_kobo": collectFeeKobo,
			"net_flow_kobo":        collectKobo - payoutKobo,
			"channel_volumes":      channelVolumes,
			"paystack_wallet_kobo": paystackWalletKobo(ctx, db),
			"settled_period_kobo":  settledKobo,
			"settled_period_count": settledCount,
			"settled_today_kobo":   settledKobo,
			"recon_rate_pct":       reconRate,
			"recon_matched":        matched,
			"recon_unmatched":      unmatched,
			"recon_last_run":       lastRun,
			"open_exceptions":      openExceptions,
			"exception_value_kobo": exceptionKobo,
			"exception_reasons":    exceptionReasons,
			"exception_ageing":     exceptionAgeing,
			"daily_trend":          dailyTrend,

			// Retained for the Overview Settlements tile, which reads these names.
			"pending_kobo":  0,
			"pending_count": 0,
			"failed_period": payoutFailedCount,
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

		// Concentration and cost of funds. A deposit book is a funding source, so the
		// two questions an exec asks of it are "how much does it cost us to hold" and
		// "how exposed are we if the biggest depositors leave".
		if rows, e := db.PGQuery(ctx, `
			WITH b AS (SELECT principal_kobo AS v, interest_rate AS rate
			             FROM cbs_fixed_deposits WHERE status='Active')
			SELECT COALESCE(SUM(v), 0) AS book,
			       COALESCE((SELECT SUM(v) FROM (SELECT v FROM b ORDER BY v DESC LIMIT 10) t), 0) AS top10,
			       COALESCE(SUM(ROUND(v * (COALESCE(rate,0)/100.0) / 12.0)), 0) AS monthly_cost
			  FROM b`); e == nil && len(rows) > 0 {
			book := toInt64(rows[0]["book"])
			top10 := toInt64(rows[0]["top10"])
			out["cost_of_funds_monthly_kobo"] = toInt64(rows[0]["monthly_cost"])
			if book > 0 {
				out["top10_share_pct"] = round1(float64(top10) / float64(book) * 100)
			} else {
				out["top10_share_pct"] = 0.0
			}
			out["top10_value_kobo"] = top10
		}

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
		sc := func(pgQ string) float64 {
			val, src, e := db.DualScalar(r.Context(), "val", pgQ)
			if e == nil {
				sources = append(sources, src)
				return toFloat(val)
			}
			return 0
		}
		// query helper
		qh := func(pgQ string) []core.Row {
			rows, src, e := db.DualQuery(r.Context(), pgQ)
			if e == nil {
				sources = append(sources, src)
				return rows
			}
			return nil
		}

		// ── Collections ───────────────────────────────────────────────────────
		collCurr := sc(
			fmt.Sprintf(`SELECT COALESCE(SUM("Amount"),0) AS val FROM "Collections Log" WHERE "Date" BETWEEN '%s' AND '%s'`, d(cs), d(ce)))
		collPrev := sc(
			fmt.Sprintf(`SELECT COALESCE(SUM("Amount"),0) AS val FROM "Collections Log" WHERE "Date" BETWEEN '%s' AND '%s'`, d(ps), d(pe)))
		collCountCurr := sc(
			fmt.Sprintf(`SELECT COUNT(*) AS val FROM "Collections Log" WHERE "Date" BETWEEN '%s' AND '%s'`, d(cs), d(ce)))

		// ── Recovery ─────────────────────────────────────────────────────────
		recCurr := sc(
			fmt.Sprintf(`SELECT COALESCE(SUM("Recovery Amount"),0) AS val FROM "Recovery Master Sheet" WHERE "Recovery Date" BETWEEN '%s' AND '%s'`, d(cs), d(ce)))
		recPrev := sc(
			fmt.Sprintf(`SELECT COALESCE(SUM("Recovery Amount"),0) AS val FROM "Recovery Master Sheet" WHERE "Recovery Date" BETWEEN '%s' AND '%s'`, d(ps), d(pe)))

		// ── Transactions ──────────────────────────────────────────────────────
		txnVolCurr := sc(
			fmt.Sprintf(`SELECT COALESCE(SUM(amount),0) AS val FROM app.transactions WHERE txn_date BETWEEN '%s' AND '%s'`, d(cs), d(ce)))
		txnVolPrev := sc(
			fmt.Sprintf(`SELECT COALESCE(SUM(amount),0) AS val FROM app.transactions WHERE txn_date BETWEEN '%s' AND '%s'`, d(ps), d(pe)))
		txnCntCurr := sc(
			fmt.Sprintf(`SELECT COUNT(*) AS val FROM app.transactions WHERE txn_date BETWEEN '%s' AND '%s'`, d(cs), d(ce)))
		txnCntPrev := sc(
			fmt.Sprintf(`SELECT COUNT(*) AS val FROM app.transactions WHERE txn_date BETWEEN '%s' AND '%s'`, d(ps), d(pe)))
		var avgTxn float64
		if txnCntCurr > 0 {
			avgTxn = round1(txnVolCurr / txnCntCurr)
		}

		// ── Customer acquisition ──────────────────────────────────────────────
		newCurr := sc(
			fmt.Sprintf(`SELECT COUNT(*) AS val FROM (SELECT MIN(account_created) fc FROM app.customers GROUP BY COALESCE('p'||party_id,'c'||contact_id)) f WHERE f.fc BETWEEN '%s' AND '%s'`, d(cs), d(ce)))
		newPrev := sc(
			fmt.Sprintf(`SELECT COUNT(*) AS val FROM (SELECT MIN(account_created) fc FROM app.customers GROUP BY COALESCE('p'||party_id,'c'||contact_id)) f WHERE f.fc BETWEEN '%s' AND '%s'`, d(ps), d(pe)))
		totalCustomers := sc(
			`SELECT COUNT(DISTINCT COALESCE('p'||party_id,'c'||contact_id)) AS val FROM app.customers`)
		activeCards := sc(
			`SELECT COUNT(*) AS val FROM app.accounts WHERE status IN ('Open','Active')`)
		totalCards := sc(
			`SELECT COUNT(*) AS val FROM app.accounts`)
		var activationRate float64
		if totalCards > 0 {
			activationRate = round1(activeCards / totalCards * 100)
		}

		// ── All-time recovery rate ─────────────────────────────────────────────
		totalRecoveredAll := sc(
			`SELECT COALESCE(SUM("Recovery Amount"),0) AS val FROM "Recovery Master Sheet"`)
		totalCollectedAll := sc(
			`SELECT COALESCE(SUM("Amount"),0) AS val FROM "Collections Log"`)
		var recoveryRatePct float64
		if totalCollectedAll > 0 {
			recoveryRatePct = round1(totalRecoveredAll / totalCollectedAll * 100)
		}

		statesCount := sc(
			`SELECT COUNT(DISTINCT state) AS val FROM app.customers WHERE state IS NOT NULL AND state!=''`)

		// ── Trends (last 12 months) ───────────────────────────────────────────
		collTrend := qh(
			`SELECT TO_CHAR(DATE_TRUNC('month',"Date"),'Mon YYYY') AS month, DATE_TRUNC('month',"Date") AS sort_key, COALESCE(SUM("Amount"),0) AS collections, COUNT(*) AS count FROM "Collections Log" WHERE "Date" >= DATE_TRUNC('month',CURRENT_DATE) - INTERVAL '11 months' GROUP BY DATE_TRUNC('month',"Date") ORDER BY sort_key`)
		recTrend := qh(
			`SELECT TO_CHAR(DATE_TRUNC('month',"Recovery Date"),'Mon YYYY') AS month, DATE_TRUNC('month',"Recovery Date") AS sort_key, COALESCE(SUM("Recovery Amount"),0) AS recovery FROM "Recovery Master Sheet" WHERE "Recovery Date" >= DATE_TRUNC('month',CURRENT_DATE) - INTERVAL '11 months' GROUP BY DATE_TRUNC('month',"Recovery Date") ORDER BY sort_key`)
		txnTrend := qh(
			`SELECT TO_CHAR(DATE_TRUNC('month',txn_date),'Mon YYYY') AS month, DATE_TRUNC('month',txn_date) AS sort_key, COALESCE(SUM(amount),0) AS volume, COUNT(*) AS txn_count FROM app.transactions WHERE txn_date >= DATE_TRUNC('month',CURRENT_DATE) - INTERVAL '11 months' GROUP BY DATE_TRUNC('month',txn_date) ORDER BY sort_key`)
		acqTrend := qh(
			`SELECT TO_CHAR(DATE_TRUNC('month',account_created),'Mon YYYY') AS month, DATE_TRUNC('month',account_created) AS sort_key, COUNT(*) AS new_accounts FROM (SELECT COALESCE('p'||party_id,'c'||contact_id) pk, MIN(account_created) AS account_created FROM app.customers GROUP BY 1) f WHERE account_created >= DATE_TRUNC('month',CURRENT_DATE) - INTERVAL '11 months' GROUP BY DATE_TRUNC('month',account_created) ORDER BY sort_key`)

		// ── Breakdowns ────────────────────────────────────────────────────────
		topStates := qh(
			`SELECT state AS "State", COUNT(DISTINCT COALESCE('p'||party_id,'c'||contact_id)) AS count FROM app.customers WHERE state IS NOT NULL AND state!='' GROUP BY state ORDER BY count DESC LIMIT 10`)
		productMix := qh(
			`SELECT product_name AS "Product Name", COUNT(*) AS count FROM app.accounts WHERE product_name IS NOT NULL GROUP BY product_name ORDER BY count DESC`)
		topAgents := qh(
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
				"collections":         collCurr,
				"collections_prev":    collPrev,
				"collections_change":  pctChange(collCurr, collPrev),
				"collections_count":   int(collCountCurr),
				"recovery":            recCurr,
				"recovery_prev":       recPrev,
				"recovery_change":     pctChange(recCurr, recPrev),
				"txn_volume":          txnVolCurr,
				"txn_volume_prev":     txnVolPrev,
				"txn_volume_change":   pctChange(txnVolCurr, txnVolPrev),
				"txn_count":           int(txnCntCurr),
				"txn_count_prev":      int(txnCntPrev),
				"txn_count_change":    pctChange(txnCntCurr, txnCntPrev),
				"avg_txn_value":       avgTxn,
				"recovery_rate":       recoveryRatePct,
				"total_collected_all": totalCollectedAll,
				"total_recovered_all": totalRecoveredAll,
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

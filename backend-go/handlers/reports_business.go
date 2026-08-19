package handlers

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

/*
Business reports.

O3 is a three-product business — cards, fixed deposits and credit — and until
now the Reports Library covered only credit. There was no report on the card book
(20,620 accounts, the largest product line), no revenue report at all (₦2.93bn of
fee, interest and penalty income was invisible because the only revenue source
read an empty table), no customer acquisition report, and nothing on service
performance despite 36k tickets and 110k calls.

These are aggregate reports for reading. Row-level extracts live in the export
engine — see handlers/export_datasets.go.

Every query here was executed against the live database before being committed;
see TestBusinessReportsRunLive.
*/

// registerBusinessReports mounts the reports added in the 2026-08-17 review.
// Called from RegisterReports so they share its page guard.
func registerBusinessReports(r chi.Router, db *core.DB, read func(http.Handler) http.Handler) {
	r.With(read).Get("/income", reportIncome(db))
	r.With(read).Get("/card-portfolio", reportCardPortfolio(db))
	r.With(read).Get("/customer-acquisition", reportCustomerAcquisition(db))
	r.With(read).Get("/service-performance", reportServicePerformance(db))
	r.With(read).Get("/fd-book", reportFDBook(db))
}

// periodDefaults resolves the date range, defaulting to the current month.
func periodDefaults(r *http.Request) (string, string, error) {
	from, err := validDate(r, "date_from")
	if err != nil {
		return "", "", err
	}
	to, err := validDate(r, "date_to")
	if err != nil {
		return "", "", err
	}
	if from == "" {
		from = time.Now().UTC().Format("2006-01") + "-01"
	}
	if to == "" {
		to = time.Now().UTC().Format("2006-01-02")
	}
	return from, to, nil
}

// ── Income ────────────────────────────────────────────────────────────────────

// reportIncome is the revenue report: what O3 actually earned, by category and
// product, from the card book.
//
// Amounts here are NAIRA (app.transactions stores numeric major units), and are
// converted to kobo on the way out so the whole API speaks one unit.
func reportIncome(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		from, to, err := periodDefaults(r)
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		ctx := r.Context()

		byCategory, err := db.PGQuery(ctx, `
			SELECT category,
			       SUM(txn_count)                     AS txn_count,
			       ROUND(SUM(amount_ngn) * 100)::bigint AS amount_kobo
			FROM app.income_daily
			WHERE income_date BETWEEN $1::date AND $2::date
			GROUP BY category ORDER BY 3 DESC`, from, to)
		if err != nil {
			respondErrLog(w, 500, "Income query failed", err)
			return
		}

		byProduct, _ := db.PGQuery(ctx, `
			SELECT product_name,
			       ROUND(SUM(amount_ngn) FILTER (WHERE category='fee')      * 100)::bigint AS fee_kobo,
			       ROUND(SUM(amount_ngn) FILTER (WHERE category='interest') * 100)::bigint AS interest_kobo,
			       ROUND(SUM(amount_ngn) FILTER (WHERE category='penalty')  * 100)::bigint AS penalty_kobo,
			       ROUND(SUM(amount_ngn) * 100)::bigint                                    AS total_kobo
			FROM app.income_daily
			WHERE income_date BETWEEN $1::date AND $2::date
			GROUP BY product_name ORDER BY 5 DESC`, from, to)

		byMonth, _ := db.PGQuery(ctx, `
			SELECT TO_CHAR(DATE_TRUNC('month', income_date), 'Mon YYYY') AS period_label,
			       DATE_TRUNC('month', income_date)::date                AS period_start,
			       ROUND(SUM(amount_ngn) FILTER (WHERE category='fee')      * 100)::bigint AS fee_kobo,
			       ROUND(SUM(amount_ngn) FILTER (WHERE category='interest') * 100)::bigint AS interest_kobo,
			       ROUND(SUM(amount_ngn) FILTER (WHERE category='penalty')  * 100)::bigint AS penalty_kobo,
			       ROUND(SUM(amount_ngn) * 100)::bigint                                    AS total_kobo
			FROM app.income_daily
			WHERE income_date BETWEEN $1::date AND $2::date
			GROUP BY 1, 2 ORDER BY 2`, from, to)

		// The interest breakdown, shown separately and never added to the total —
		// code 604 already sums 600/601/603, so including both nearly doubles it.
		interestComponents, _ := db.PGQuery(ctx, `
			SELECT component, SUM(txn_count) AS txn_count,
			       ROUND(SUM(amount_ngn) * 100)::bigint AS amount_kobo
			FROM app.interest_components_daily
			WHERE income_date BETWEEN $1::date AND $2::date
			GROUP BY component ORDER BY 3 DESC`, from, to)

		var total int64
		for _, row := range byCategory {
			total += toInt64(row["amount_kobo"])
		}

		respond(w, map[string]any{
			"date_from":           from,
			"date_to":             to,
			"total_income_kobo":   total,
			"by_category":         byCategory,
			"by_product":          byProduct,
			"by_month":            byMonth,
			"interest_components": interestComponents,
			"basis": "Card book postings classified by app.card_txn_codes. " +
				"Interest is code 604 (Total Interest); components 600/601/603 are shown " +
				"separately and are already included in that total.",
		}, "pg")
	}
}

// ── Card portfolio ────────────────────────────────────────────────────────────

// reportCardPortfolio covers O3's largest product line, which had no report.
//
// Money columns on app.accounts are numeric NAIRA, not kobo — the one place in
// the workspace where that is true — so everything is converted on the way out.
func reportCardPortfolio(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		summary, err := db.PGQuery(ctx, `
			SELECT COUNT(*)                                             AS total_accounts,
			       COUNT(*) FILTER (WHERE status IN ('Open','Active'))  AS active_accounts,
			       COUNT(DISTINCT cif)                                  AS distinct_cifs,
			       ROUND(COALESCE(SUM(card_limit),0)          * 100)::bigint AS total_limit_kobo,
			       ROUND(COALESCE(SUM(current_dr_balance),0)  * 100)::bigint AS total_balance_kobo,
			       ROUND(COALESCE(SUM(min_payment_due),0)     * 100)::bigint AS total_min_due_kobo,
			       ROUND(AVG(card_utilisation)::numeric, 2)                 AS avg_utilisation_pct
			FROM app.accounts`)
		if err != nil {
			respondErrLog(w, 500, "Card portfolio query failed", err)
			return
		}

		byStatus, _ := db.PGQuery(ctx, `
			SELECT COALESCE(NULLIF(status,''),'Unspecified')             AS status,
			       COUNT(*)                                             AS accounts,
			       ROUND(COALESCE(SUM(current_dr_balance),0) * 100)::bigint AS balance_kobo
			FROM app.accounts GROUP BY 1 ORDER BY 2 DESC`)

		byProduct, _ := db.PGQuery(ctx, `
			SELECT COALESCE(NULLIF(product_name,''),'Unspecified')      AS product_name,
			       COALESCE(NULLIF(product_line,''),'Unspecified')      AS product_line,
			       COUNT(*)                                             AS accounts,
			       ROUND(COALESCE(SUM(card_limit),0)         * 100)::bigint AS limit_kobo,
			       ROUND(COALESCE(SUM(current_dr_balance),0) * 100)::bigint AS balance_kobo,
			       ROUND(AVG(card_utilisation)::numeric, 2)                 AS avg_utilisation_pct
			FROM app.accounts GROUP BY 1, 2 ORDER BY 3 DESC`)

		// Delinquency uses days_overdue, which the card book maintains itself —
		// this is the card equivalent of the loan book's DPD, not the same field.
		delinquency, _ := db.PGQuery(ctx, `
			SELECT CASE
			         WHEN COALESCE(days_overdue,0) = 0   THEN 'Current'
			         WHEN days_overdue <= 30             THEN '1-30'
			         WHEN days_overdue <= 60             THEN '31-60'
			         WHEN days_overdue <= 90             THEN '61-90'
			         WHEN days_overdue <= 180            THEN '91-180'
			         ELSE '180+' END                     AS bucket,
			       COUNT(*)                              AS accounts,
			       ROUND(COALESCE(SUM(current_dr_balance),0) * 100)::bigint AS balance_kobo
			FROM app.accounts
			WHERE status IN ('Open','Active')
			GROUP BY 1
			ORDER BY MIN(COALESCE(days_overdue,0))`)

		// Utilisation distribution: how hard customers are leaning on their limits.
		utilisation, _ := db.PGQuery(ctx, `
			SELECT CASE
			         WHEN card_utilisation IS NULL      THEN 'Unknown'
			         WHEN card_utilisation < 25         THEN '0-25%'
			         WHEN card_utilisation < 50         THEN '25-50%'
			         WHEN card_utilisation < 75         THEN '50-75%'
			         WHEN card_utilisation < 100        THEN '75-100%'
			         ELSE 'Over limit' END              AS band,
			       COUNT(*)                             AS accounts,
			       ROUND(COALESCE(SUM(current_dr_balance),0) * 100)::bigint AS balance_kobo
			FROM app.accounts WHERE status IN ('Open','Active')
			GROUP BY 1 ORDER BY 2 DESC`)

		out := map[string]any{
			"by_status":     byStatus,
			"by_product":    byProduct,
			"delinquency":   delinquency,
			"utilisation":   utilisation,
			"balance_basis": "app.accounts stores naira (numeric); converted to kobo here.",
		}
		if len(summary) > 0 {
			out["summary"] = summary[0]
		}
		respond(w, out, "pg")
	}
}

// ── Customer acquisition ──────────────────────────────────────────────────────

// reportCustomerAcquisition answers "are we winning customers, and where from".
//
// Counted by first account opened, per CIF — not by customers.account_created,
// which the feed stopped populating on 2025-07-09, and not per account, because a
// CIF is a card rather than a person and one customer holds several.
func reportCustomerAcquisition(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		from, to, err := periodDefaults(r)
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		ctx := r.Context()

		const firstAcct = `
			SELECT a.cif, MIN(a.opened_date) AS first_open
			FROM app.accounts a
			WHERE a.opened_date IS NOT NULL AND NULLIF(a.cif,'') IS NOT NULL
			GROUP BY a.cif`

		byMonth, err := db.PGQuery(ctx, `
			WITH fa AS (`+firstAcct+`)
			SELECT TO_CHAR(DATE_TRUNC('month', first_open), 'Mon YYYY') AS period_label,
			       DATE_TRUNC('month', first_open)::date                AS period_start,
			       COUNT(*)                                             AS new_customers
			FROM fa WHERE first_open BETWEEN $1::date AND $2::date
			GROUP BY 1, 2 ORDER BY 2`, from, to)
		if err != nil {
			respondErrLog(w, 500, "Acquisition query failed", err)
			return
		}

		byProduct, _ := db.PGQuery(ctx, `
			WITH fa AS (`+firstAcct+`)
			SELECT COALESCE(NULLIF(a.product_name,''),'Unspecified') AS product_name,
			       COUNT(DISTINCT fa.cif)                            AS new_customers
			FROM fa JOIN app.accounts a ON a.cif = fa.cif AND a.opened_date = fa.first_open
			WHERE fa.first_open BETWEEN $1::date AND $2::date
			GROUP BY 1 ORDER BY 2 DESC`, from, to)

		byState, _ := db.PGQuery(ctx, `
			WITH fa AS (`+firstAcct+`)
			SELECT COALESCE(NULLIF(c.state,''),'Unknown') AS state,
			       COUNT(DISTINCT fa.cif)                 AS new_customers
			FROM fa LEFT JOIN app.customers c ON c.cif = fa.cif
			WHERE fa.first_open BETWEEN $1::date AND $2::date
			GROUP BY 1 ORDER BY 2 DESC LIMIT 20`, from, to)

		// The person layer: a CIF is a card, so cards-per-person is the honest
		// measure of how many customers O3 actually has.
		parties, _ := db.PGQuery(ctx, `
			SELECT COUNT(*)                                    AS parties,
			       COALESCE(SUM(card_count), 0)                AS cards_held,
			       ROUND(AVG(card_count)::numeric, 2)          AS avg_cards_per_party
			FROM app.parties`)

		total := int64(0)
		for _, row := range byMonth {
			total += toInt64(row["new_customers"])
		}

		out := map[string]any{
			"date_from":        from,
			"date_to":          to,
			"new_customers":    total,
			"by_month":         byMonth,
			"by_first_product": byProduct,
			"by_state":         byState,
			"basis": "Counted by each CIF's earliest account opening date. " +
				"customers.account_created is not used: the feed stopped populating it on 2025-07-09.",
		}
		if len(parties) > 0 {
			out["party_summary"] = parties[0]
		}
		respond(w, out, "pg")
	}
}

// ── Service performance ───────────────────────────────────────────────────────

// reportServicePerformance covers the contact centre: tickets, SLA, CSAT and
// calls. 36k tickets and 110k calls had no report of any kind.
func reportServicePerformance(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		from, to, err := periodDefaults(r)
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		ctx := r.Context()

		summary, err := db.PGQuery(ctx, `
			SELECT COUNT(*)                                                AS tickets,
			       COUNT(*) FILTER (WHERE resolved_at IS NOT NULL)         AS resolved,
			       COUNT(*) FILTER (WHERE sla_breached)                    AS sla_breached,
			       ROUND(AVG(csat_score) FILTER (WHERE csat_score IS NOT NULL)::numeric, 2) AS avg_csat,
			       COUNT(*) FILTER (WHERE csat_score IS NOT NULL)          AS csat_responses,
			       ROUND(AVG(EXTRACT(EPOCH FROM (first_response_at - created_at))/60)
			             FILTER (WHERE first_response_at IS NOT NULL)::numeric, 1) AS avg_first_response_min,
			       ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))/3600)
			             FILTER (WHERE resolved_at IS NOT NULL)::numeric, 1)       AS avg_resolution_hours
			FROM app.helpdesk_tickets
			WHERE created_at::date BETWEEN $1::date AND $2::date`, from, to)
		if err != nil {
			respondErrLog(w, 500, "Service query failed", err)
			return
		}

		byChannel, _ := db.PGQuery(ctx, `
			SELECT COALESCE(NULLIF(channel,''),'Unspecified') AS channel,
			       COUNT(*)                                   AS tickets,
			       COUNT(*) FILTER (WHERE resolved_at IS NOT NULL) AS resolved,
			       ROUND(AVG(csat_score) FILTER (WHERE csat_score IS NOT NULL)::numeric, 2) AS avg_csat
			FROM app.helpdesk_tickets
			WHERE created_at::date BETWEEN $1::date AND $2::date
			GROUP BY 1 ORDER BY 2 DESC`, from, to)

		byStatus, _ := db.PGQuery(ctx, `
			SELECT COALESCE(NULLIF(status,''),'Unspecified') AS status, COUNT(*) AS tickets
			FROM app.helpdesk_tickets
			WHERE created_at::date BETWEEN $1::date AND $2::date
			GROUP BY 1 ORDER BY 2 DESC`, from, to)

		byAgent, _ := db.PGQuery(ctx, `
			SELECT COALESCE(u.full_name, t.zoho_assignee_name, 'Unassigned') AS agent_name,
			       COUNT(*)                                                  AS tickets,
			       COUNT(*) FILTER (WHERE t.resolved_at IS NOT NULL)         AS resolved,
			       COUNT(*) FILTER (WHERE t.sla_breached)                    AS sla_breached,
			       ROUND(AVG(t.csat_score) FILTER (WHERE t.csat_score IS NOT NULL)::numeric, 2) AS avg_csat
			FROM app.helpdesk_tickets t
			LEFT JOIN app.o3c_users u ON u.id = t.assigned_to
			WHERE t.created_at::date BETWEEN $1::date AND $2::date
			GROUP BY 1 ORDER BY 2 DESC LIMIT 25`, from, to)

		calls, _ := db.PGQuery(ctx, `
			SELECT COALESCE(NULLIF(direction,''),'Unspecified') AS direction,
			       COUNT(*)                                     AS calls,
			       ROUND(AVG(duration_sec)::numeric, 0)         AS avg_duration_sec,
			       ROUND(SUM(duration_sec)/3600.0, 1)           AS total_hours
			FROM app.helpdesk_calls
			WHERE COALESCE(started_at, created_at)::date BETWEEN $1::date AND $2::date
			GROUP BY 1 ORDER BY 2 DESC`, from, to)

		out := map[string]any{
			"date_from":  from,
			"date_to":    to,
			"by_channel": byChannel,
			"by_status":  byStatus,
			"by_agent":   byAgent,
			"calls":      calls,
		}
		if len(summary) > 0 {
			out["summary"] = summary[0]
		}
		respond(w, out, "pg")
	}
}

// ── Fixed deposits ────────────────────────────────────────────────────────────

// reportFDBook is the deposit side of the business, with a maturity ladder —
// the thing treasury actually needs and which existed nowhere.
func reportFDBook(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		summary, err := db.PGQuery(ctx, `
			SELECT COUNT(*)                                          AS deposits,
			       COUNT(DISTINCT cbs_customer_id)                   AS customers,
			       COALESCE(SUM(principal_kobo), 0)::bigint          AS principal_kobo,
			       COALESCE(SUM(accrued_interest_kobo), 0)::bigint   AS accrued_interest_kobo,
			       ROUND(AVG(interest_rate)::numeric, 2)             AS avg_rate,
			       ROUND(AVG(tenor_days)::numeric, 0)                AS avg_tenor_days
			FROM app.cbs_fixed_deposits`)
		if err != nil {
			respondErrLog(w, 500, "FD query failed", err)
			return
		}

		byStatus, _ := db.PGQuery(ctx, `
			SELECT COALESCE(NULLIF(status,''),'Unspecified') AS status, COUNT(*) AS deposits,
			       COALESCE(SUM(principal_kobo),0)::bigint   AS principal_kobo
			FROM app.cbs_fixed_deposits GROUP BY 1 ORDER BY 2 DESC`)

		byProduct, _ := db.PGQuery(ctx, `
			SELECT COALESCE(NULLIF(product_name,''),'Unspecified') AS product_name,
			       COUNT(*) AS deposits,
			       COALESCE(SUM(principal_kobo),0)::bigint AS principal_kobo,
			       ROUND(AVG(interest_rate)::numeric, 2)   AS avg_rate
			FROM app.cbs_fixed_deposits GROUP BY 1 ORDER BY 3 DESC`)

		// The maturity ladder — what has to be funded, and when.
		ladder, _ := db.PGQuery(ctx, `
			SELECT CASE
			         WHEN maturity_date IS NULL                            THEN 'Unknown'
			         WHEN maturity_date < NOW()                            THEN 'Matured'
			         WHEN maturity_date < NOW() + INTERVAL '30 days'       THEN 'Next 30 days'
			         WHEN maturity_date < NOW() + INTERVAL '90 days'       THEN '31-90 days'
			         WHEN maturity_date < NOW() + INTERVAL '180 days'      THEN '91-180 days'
			         ELSE 'Over 180 days' END                              AS bucket,
			       COUNT(*)                                                AS deposits,
			       COALESCE(SUM(principal_kobo),0)::bigint                 AS principal_kobo,
			       COALESCE(SUM(principal_kobo + COALESCE(accrued_interest_kobo,0)),0)::bigint AS payout_kobo
			FROM app.cbs_fixed_deposits
			GROUP BY 1 ORDER BY MIN(COALESCE(maturity_date, 'infinity'::timestamptz))`)

		out := map[string]any{
			"by_status":       byStatus,
			"by_product":      byProduct,
			"maturity_ladder": ladder,
		}
		if len(summary) > 0 {
			out["summary"] = summary[0]
		}
		respond(w, out, "pg")
	}
}

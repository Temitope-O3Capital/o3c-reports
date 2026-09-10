package handlers

import (
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

// RegisterGrowth mounts the customer Growth & Activity monitor at /api/growth.
//
// It answers the three questions the workspace had no home for: who is being
// onboarded (registrations), how much they transact (transaction activity), and
// who is going quiet (churn / retention). Everything is computed live off the
// 15-minute feed tables — app.accounts.opened_date for onboarding and
// app.transactions for activity — so it needs no snapshot job.
//
// Audience: the operating teams whose signals these are (Sales/CRM, Cards & Ops,
// Collections, Recovery) plus BI and the executive tier. It is gated on the page
// keys those roles already hold; admin and the management tier bypass via their
// "executive"/super-user grants. This is the same union the frontend route guard
// uses, so nav and API stay in lockstep.
//
// Money note: app.transactions.amount is stored in NAIRA (2dp), unlike the rest
// of the workspace which is kobo — so every money figure is multiplied by 100 and
// returned as *_kobo for the existing fmtKobo() formatter.
//
// Sign note: the per-source amount_debit / amount_credit columns are NOT sign-
// consistent (the feed stores credits as positive magnitudes; the mssql_baseline
// and cfile_catchup imports store them negative). The signed `amount` column plus
// the `money_in` flag IS consistent across every source, so spend and inflow are
// computed as SUM(ABS(amount)) FILTER (money_in / NOT money_in) — spend = money
// out (purchases), inflow = money in (repayments / card loads).
func RegisterGrowth(r chi.Router, db *core.DB) {
	access := core.RequirePages("sales", "cards", "collections", "recovery", "reports", "executive")
	r.With(access).Get("/summary", growthSummary(db))
	r.With(access).Get("/trends", growthTrends(db))
	r.With(access).Get("/behaviour", growthBehaviour(db))
	// Repayment-side behaviour (loan paydown tiers, card min-payment-met, installments).
	r.With(access).Get("/repayment-behaviour", repaymentBehaviour(db))
}

// growthBehaviour is the PORTFOLIO-WIDE spending & behaviour picture — the aggregated
// twin of Customer 360's per-customer panel. It answers where the whole book spends
// (merchants), on what (MCC category), how (channel), where (city) and the money-in/out
// cadence, over a bounded window (default 12 months, so it stays fast on the ~1M-row
// ledger and reflects current behaviour, not 2014). Money is naira in the feed, returned
// *_kobo (×100) for fmtKobo; spend = money out (NOT money_in), via the sign-stable
// SUM(ABS(amount)) FILTER convention used across this module.
func growthBehaviour(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		months := 12
		if q := r.URL.Query().Get("months"); q != "" {
			if n, err := strconv.Atoi(q); err == nil && n >= 1 && n <= 60 {
				months = n
			}
		}
		win := `txn_date >= date_trunc('month',CURRENT_DATE) - ` + strconv.Itoa(months) + `::int * interval '1 month'`
		out := map[string]any{}

		if rows, err := db.PGQuery(ctx, `
			SELECT COUNT(*)                                                        AS txns,
			       COUNT(*) FILTER (WHERE NOT money_in)                            AS spend_txns,
			       ROUND(SUM(ABS(amount)) FILTER (WHERE NOT money_in) * 100)::bigint AS spend_kobo,
			       ROUND(SUM(ABS(amount)) FILTER (WHERE money_in)     * 100)::bigint AS inflow_kobo,
			       COUNT(DISTINCT cif)                                             AS active_customers,
			       COUNT(DISTINCT NULLIF(TRIM(merchant_name),''))                  AS merchants,
			       MIN(txn_date) AS first_txn, MAX(txn_date) AS last_txn
			  FROM app.transactions WHERE `+win); err == nil && len(rows) > 0 {
			out["totals"] = rows[0]
		}

		// Recency cohorts — the frequency/recency lens. Segments every customer that has
		// ever transacted by how recently (NOT windowed — recency is inherently all-time),
		// so you see who's active vs going quiet. "never" is the card base that has no
		// ledger row at all. Keyed on cif (card) to match the rest of this module.
		if rows, err := db.PGQuery(ctx, `
			WITH last_txn AS (
			  SELECT cif, MAX(txn_date) AS last
			    FROM app.transactions WHERE cif <> '' GROUP BY cif
			)
			SELECT
			  COUNT(*) FILTER (WHERE last >= CURRENT_DATE - INTERVAL '90 days')  AS active,
			  COUNT(*) FILTER (WHERE last <  CURRENT_DATE - INTERVAL '90 days'
			                     AND last >= CURRENT_DATE - INTERVAL '365 days') AS lapsing,
			  COUNT(*) FILTER (WHERE last <  CURRENT_DATE - INTERVAL '365 days') AS dormant,
			  GREATEST(0, (SELECT COUNT(*) FROM app.customers WHERE cif <> '')
			              - (SELECT COUNT(*) FROM last_txn))                     AS never
			FROM last_txn`); err == nil && len(rows) > 0 {
			out["cohorts"] = rows[0]
		}

		// Same cohorts at PERSON (party) level — a person holds many cards (CIFs), so this
		// rolls every card's last-transaction up to its owner. The UI toggles between the
		// two; a person is "active" if ANY of their cards transacted recently.
		if rows, err := db.PGQuery(ctx, `
			WITH cif_last AS (
			  SELECT cif, MAX(txn_date) AS last
			    FROM app.transactions WHERE cif <> '' GROUP BY cif
			),
			person_last AS (
			  SELECT COALESCE('p'||c.party_id::text, 'c'||c.contact_id::text) AS pk,
			         MAX(cl.last) AS last
			    FROM app.customers c
			    LEFT JOIN cif_last cl ON cl.cif = c.cif
			   WHERE c.cif <> ''
			   GROUP BY 1
			)
			SELECT
			  COUNT(*) FILTER (WHERE last >= CURRENT_DATE - INTERVAL '90 days')  AS active,
			  COUNT(*) FILTER (WHERE last <  CURRENT_DATE - INTERVAL '90 days'
			                     AND last >= CURRENT_DATE - INTERVAL '365 days') AS lapsing,
			  COUNT(*) FILTER (WHERE last <  CURRENT_DATE - INTERVAL '365 days') AS dormant,
			  COUNT(*) FILTER (WHERE last IS NULL)                              AS never
			FROM person_last`); err == nil && len(rows) > 0 {
			out["cohorts_person"] = rows[0]
		}
		if rows, err := db.PGQuery(ctx, `
			SELECT TRIM(merchant_name) AS merchant, COUNT(*) AS txns,
			       ROUND(SUM(ABS(amount)) FILTER (WHERE NOT money_in) * 100)::bigint AS spend_kobo
			  FROM app.transactions
			 WHERE `+win+` AND NULLIF(TRIM(merchant_name),'') IS NOT NULL
			 GROUP BY 1 ORDER BY spend_kobo DESC NULLS LAST LIMIT 12`); err == nil {
			out["top_merchants"] = rows
		}
		if rows, err := db.PGQuery(ctx, `
			SELECT TRIM(mcc) AS mcc, COUNT(*) AS txns,
			       ROUND(SUM(ABS(amount)) FILTER (WHERE NOT money_in) * 100)::bigint AS spend_kobo
			  FROM app.transactions
			 WHERE `+win+` AND NULLIF(TRIM(mcc),'') IS NOT NULL
			 GROUP BY 1 ORDER BY spend_kobo DESC NULLS LAST LIMIT 10`); err == nil {
			out["by_category"] = rows
		}
		if rows, err := db.PGQuery(ctx, `
			SELECT COALESCE(NULLIF(TRIM(channel),''),'other') AS channel, COUNT(*) AS txns,
			       ROUND(SUM(ABS(amount)) FILTER (WHERE NOT money_in) * 100)::bigint AS spend_kobo
			  FROM app.transactions WHERE `+win+`
			 GROUP BY 1 ORDER BY txns DESC`); err == nil {
			out["by_channel"] = rows
		}
		if rows, err := db.PGQuery(ctx, `
			SELECT INITCAP(TRIM(city)) AS city, COUNT(*) AS txns,
			       ROUND(SUM(ABS(amount)) FILTER (WHERE NOT money_in) * 100)::bigint AS spend_kobo
			  FROM app.transactions
			 WHERE `+win+` AND NULLIF(TRIM(city),'') IS NOT NULL
			 GROUP BY 1 ORDER BY txns DESC LIMIT 10`); err == nil {
			out["by_city"] = rows
		}
		if rows, err := db.PGQuery(ctx, `
			SELECT to_char(date_trunc('month',txn_date),'YYYY-MM')                 AS month,
			       ROUND(SUM(ABS(amount)) FILTER (WHERE NOT money_in) * 100)::bigint AS spend_kobo,
			       ROUND(SUM(ABS(amount)) FILTER (WHERE money_in)     * 100)::bigint AS inflow_kobo,
			       COUNT(DISTINCT cif)                                             AS active
			  FROM app.transactions WHERE `+win+`
			 GROUP BY 1 ORDER BY 1`); err == nil {
			out["monthly"] = rows
		}

		respond(w, out, "pg")
	}
}

// growthSummary — headline KPIs for the current period against the previous one,
// plus the current activity distribution (the churn snapshot). Each block
// degrades independently: a failed query simply omits its key rather than
// blanking the whole card.
func growthSummary(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		out := map[string]any{}

		// Registrations — new card accounts by opened_date.
		if rows, err := db.PGQuery(ctx, `
			SELECT
			  COUNT(*) FILTER (WHERE date_trunc('month',opened_date) = date_trunc('month',CURRENT_DATE))                      AS this_month,
			  COUNT(*) FILTER (WHERE date_trunc('month',opened_date) = date_trunc('month',CURRENT_DATE) - interval '1 month') AS last_month,
			  COUNT(*) FILTER (WHERE opened_date >= date_trunc('year',CURRENT_DATE))                                          AS ytd,
			  COUNT(*)                                                                                                        AS total
			FROM app.accounts
			WHERE opened_date IS NOT NULL`); err == nil && len(rows) > 0 {
			out["registrations"] = rows[0]
		}

		// Transactions — this month vs last month (count, spend, inflow, active
		// cardholders). Windowed to the last two months so the scan is cheap.
		if rows, err := db.PGQuery(ctx, `
			SELECT
			  COUNT(*) FILTER (WHERE date_trunc('month',txn_date) = date_trunc('month',CURRENT_DATE))                      AS count_this,
			  COUNT(*) FILTER (WHERE date_trunc('month',txn_date) = date_trunc('month',CURRENT_DATE) - interval '1 month') AS count_last,
			  ROUND(COALESCE(SUM(ABS(amount)) FILTER (WHERE NOT money_in AND date_trunc('month',txn_date) = date_trunc('month',CURRENT_DATE)),0) * 100)::bigint                      AS spend_kobo_this,
			  ROUND(COALESCE(SUM(ABS(amount)) FILTER (WHERE NOT money_in AND date_trunc('month',txn_date) = date_trunc('month',CURRENT_DATE) - interval '1 month'),0) * 100)::bigint AS spend_kobo_last,
			  ROUND(COALESCE(SUM(ABS(amount)) FILTER (WHERE money_in AND date_trunc('month',txn_date) = date_trunc('month',CURRENT_DATE)),0) * 100)::bigint                          AS inflow_kobo_this,
			  COUNT(DISTINCT cif) FILTER (WHERE date_trunc('month',txn_date) = date_trunc('month',CURRENT_DATE))                      AS active_this,
			  COUNT(DISTINCT cif) FILTER (WHERE date_trunc('month',txn_date) = date_trunc('month',CURRENT_DATE) - interval '1 month') AS active_last
			FROM app.transactions
			WHERE txn_date >= date_trunc('month',CURRENT_DATE) - interval '1 month'`); err == nil && len(rows) > 0 {
			out["transactions"] = rows[0]
		}

		// Activity distribution — every customer bucketed by recency of their last
		// transaction. This is the churn snapshot: dormant + never are the book that
		// has gone quiet. Same 90d/365d thresholds Customer 360 uses, so the numbers
		// reconcile across the app.
		if rows, err := db.PGQuery(ctx, `
			WITH last_txn AS (
			  SELECT cif, MAX(txn_date) AS last_txn
			  FROM app.transactions WHERE cif <> '' GROUP BY cif
			)
			SELECT
			  COUNT(*)                                                                                                                        AS total,
			  COUNT(*) FILTER (WHERE lt.last_txn >= CURRENT_DATE - interval '90 days')                                                         AS active,
			  COUNT(*) FILTER (WHERE lt.last_txn <  CURRENT_DATE - interval '90 days' AND lt.last_txn >= CURRENT_DATE - interval '365 days')   AS lapsing,
			  COUNT(*) FILTER (WHERE lt.last_txn <  CURRENT_DATE - interval '365 days')                                                        AS dormant,
			  COUNT(*) FILTER (WHERE lt.last_txn IS NULL)                                                                                      AS never_active
			FROM app.customers c
			LEFT JOIN last_txn lt ON lt.cif = c.cif
			WHERE c.cif IS NOT NULL AND c.cif <> ''`); err == nil && len(rows) > 0 {
			out["activity"] = rows[0]
		}

		respond(w, out, "feed")
	}
}

// growthTrends — one row per month for the last N months (default 12, max 36),
// carrying registrations, transaction activity and month-over-month churn in a
// single chart-friendly array.
//
// Churn is computed from the set of customers (CIF) who transacted each month:
//   - retained    = transacted this month AND last month
//   - reactivated = transacted this month but NOT last month (new or returning)
//   - churned     = transacted last month but NOT this month
// The active-customer set is windowed to the requested range (+1 month of
// look-back) so the self-join stays bounded even though the ledger runs to 2014.
//
// Feed gaps: the 15-minute feed has occasional dead months (e.g. 2025-11/12,
// 2026-05) where almost nothing arrived. Month-over-month churn across such a
// month is meaningless — everyone "churns" into the gap and "reactivates" out of
// it. So a month whose txn_count is under 10% of the window median is flagged
// is_gap, and the churn figures for a gap month AND the month immediately after
// one are returned as NULL rather than as a fake cliff. Registrations, spend and
// active counts stay factual (they are what they are); only the derived churn is
// suppressed. The frontend renders the NULLs as a break, not a zero.
func growthTrends(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		months := 12
		if q := r.URL.Query().Get("months"); q != "" {
			if n, err := strconv.Atoi(q); err == nil && n >= 1 && n <= 36 {
				months = n
			}
		}

		rows, err := db.PGQuery(ctx, `
			WITH months AS (
			  SELECT generate_series(
			    date_trunc('month',CURRENT_DATE) - ($1::int - 1) * interval '1 month',
			    date_trunc('month',CURRENT_DATE),
			    interval '1 month') AS m
			),
			reg AS (
			  SELECT date_trunc('month',opened_date) AS m, COUNT(*) AS new_accounts
			  FROM app.accounts WHERE opened_date IS NOT NULL
			  GROUP BY 1
			),
			firstseen AS (
			  SELECT cif, date_trunc('month',MIN(opened_date)) AS m
			  FROM app.accounts WHERE opened_date IS NOT NULL AND cif <> ''
			  GROUP BY cif
			),
			newcust AS (
			  SELECT m, COUNT(*) AS new_customers FROM firstseen GROUP BY m
			),
			txn AS (
			  SELECT date_trunc('month',txn_date) AS m,
			         COUNT(*)                                                   AS txn_count,
			         ROUND(SUM(ABS(amount)) FILTER (WHERE NOT money_in) * 100)::bigint AS spend_kobo,
			         ROUND(SUM(ABS(amount)) FILTER (WHERE money_in)     * 100)::bigint AS inflow_kobo,
			         COUNT(DISTINCT cif)                                        AS active_customers
			  FROM app.transactions
			  WHERE txn_date >= date_trunc('month',CURRENT_DATE) - $1::int * interval '1 month'
			  GROUP BY 1
			),
			-- Window median of monthly volume; a month under 10% of it is a feed gap.
			-- The current (partial) month is never flagged — it is legitimately in progress.
			med AS (
			  SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY txn_count) AS v
			  FROM txn WHERE txn_count > 0
			),
			gap AS (
			  SELECT months.m,
			         (COALESCE(txn.txn_count,0) < 0.10 * COALESCE((SELECT v FROM med),0)
			          AND months.m < date_trunc('month',CURRENT_DATE)) AS is_gap
			  FROM months LEFT JOIN txn ON txn.m = months.m
			),
			act AS (
			  SELECT DISTINCT date_trunc('month',txn_date) AS m, cif
			  FROM app.transactions
			  WHERE cif <> ''
			    AND txn_date >= date_trunc('month',CURRENT_DATE) - ($1::int + 1) * interval '1 month'
			),
			retained AS (
			  SELECT cur.m,
			         COUNT(*) FILTER (WHERE prev.cif IS NOT NULL) AS retained,
			         COUNT(*) FILTER (WHERE prev.cif IS NULL)     AS reactivated
			  FROM act cur
			  LEFT JOIN act prev ON prev.cif = cur.cif AND prev.m = cur.m - interval '1 month'
			  GROUP BY cur.m
			),
			churned AS (
			  SELECT prev.m + interval '1 month' AS m, COUNT(*) AS churned
			  FROM act prev
			  LEFT JOIN act cur ON cur.cif = prev.cif AND cur.m = prev.m + interval '1 month'
			  WHERE cur.cif IS NULL
			  GROUP BY prev.m
			)
			SELECT to_char(months.m,'YYYY-MM')          AS month,
			       COALESCE(reg.new_accounts,0)         AS new_accounts,
			       COALESCE(newcust.new_customers,0)    AS new_customers,
			       COALESCE(txn.txn_count,0)            AS txn_count,
			       COALESCE(txn.spend_kobo,0)           AS spend_kobo,
			       COALESCE(txn.inflow_kobo,0)          AS inflow_kobo,
			       COALESCE(txn.active_customers,0)     AS active_customers,
			       COALESCE(g.is_gap,false)             AS is_gap,
			       -- Churn is unreliable across a gap month and the month right after it.
			       CASE WHEN COALESCE(g.is_gap,false) OR COALESCE(gp.is_gap,false) THEN NULL
			            ELSE COALESCE(retained.retained,0)    END AS retained,
			       CASE WHEN COALESCE(g.is_gap,false) OR COALESCE(gp.is_gap,false) THEN NULL
			            ELSE COALESCE(retained.reactivated,0) END AS reactivated,
			       CASE WHEN COALESCE(g.is_gap,false) OR COALESCE(gp.is_gap,false) THEN NULL
			            ELSE COALESCE(churned.churned,0)      END AS churned
			FROM months
			LEFT JOIN reg      ON reg.m      = months.m
			LEFT JOIN newcust  ON newcust.m  = months.m
			LEFT JOIN txn      ON txn.m      = months.m
			LEFT JOIN gap g    ON g.m        = months.m
			LEFT JOIN gap gp   ON gp.m       = months.m - interval '1 month'
			LEFT JOIN retained ON retained.m = months.m
			LEFT JOIN churned  ON churned.m  = months.m
			ORDER BY months.m`, months)
		if err != nil {
			respondErrLog(w, 500, "growth trends query failed", err)
			return
		}
		respond(w, rows, "feed")
	}
}

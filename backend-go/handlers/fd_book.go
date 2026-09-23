package handlers

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

/*
   Shared SQL fragments for the CBS/Udara fixed-deposit register.

   They are written against UNQUALIFIED column names, so use them only where
   cbs_fixed_deposits is the sole / unaliased table in the statement.

   sqlFDFunded — Udara books the deposit record at instruction time and only
   flips hasDisbursed once the money actually lands. 17 Active rows are unfunded
   shells: principal, ledger and accrued are all 0, so they move no money total
   but they DO inflate every count (active_count, unique_customers,
   maturing_30d, new-this-month). "The book" therefore means Active AND funded
   everywhere, and the shells are surfaced as unfunded_count rather than being
   silently dropped. A missing flag counts as funded so an upstream change fails
   safe. The flag lives only in raw — there is no column for it.

   sqlFDEffRate / sqlFDDailyAccrualKobo — 27 Active deposits carry
   interest_rate = 0 (₦2.07bn, 10.7% of the active book). The rate is genuinely
   absent in Udara, not mis-mapped, yet 25 of them are visibly accruing.
   Treating them as 0% books them as free money: it understates the cost of
   funds and drags the headline rate down. Where the contract rate is missing we
   fall back to what the deposit has actually accrued — accrued-to-date ÷ days
   elapsed — a measured floor rather than an invented rate. Where there is
   neither a rate nor any accrual the deposit contributes nothing and is left
   out of the average (NULL) instead of being averaged in as a zero.
*/
const (
	sqlFDFunded = `raw->>'hasDisbursed' IS DISTINCT FROM 'false'`

	sqlFDEffRate = `CASE
			WHEN COALESCE(interest_rate,0) > 0 THEN interest_rate
			WHEN COALESCE(accrued_interest_kobo,0) > 0 AND COALESCE(principal_kobo,0) > 0 AND commencement_date IS NOT NULL
				THEN (accrued_interest_kobo::numeric
				      / GREATEST(1, CURRENT_DATE - commencement_date::date)) * 365.0 * 100.0 / principal_kobo
			ELSE NULL END`

	sqlFDDailyAccrualKobo = `CASE
			WHEN COALESCE(interest_rate,0) > 0 THEN COALESCE(principal_kobo,0) * (interest_rate/100.0) / 365.0
			WHEN COALESCE(accrued_interest_kobo,0) > 0 AND commencement_date IS NOT NULL
				THEN accrued_interest_kobo::numeric / GREATEST(1, CURRENT_DATE - commencement_date::date)
			ELSE 0 END`
)

// RegisterFDBook mounts the Fixed-Deposit book analytics under /api/fd-book.
// Source of truth is the CBS/Udara-synced cbs_fixed_deposits register (not the
// legacy native fd_transactions table). All routes require the fixed_deposit page.
func RegisterFDBook(r chi.Router, db *core.DB) {
	access := core.RequirePages("fixed_deposit")
	r.With(access).Get("/kpis", fdBookKPIs(db))
	r.With(access).Get("/maturity-ladder", fdBookMaturityLadder(db))
	r.With(access).Get("/book-trend", fdBookTrend(db))
	r.With(access).Get("/by-product", fdBookByProduct(db))
	r.With(access).Get("/by-officer", fdBookByOfficer(db))
	r.With(access).Get("/tenor-distribution", fdBookTenorDist(db))
	r.With(access).Get("/list", fdBookList(db))
}

/*
   Account officer on the deposit book.

   cbs_fixed_deposits has NO officer column, which is why the FD book could not
   answer "whose deposits are these" while the loan book could. Udara does send
   one — raw->>'accountOfficerName', present on all 380 deposits across 20
   distinct officers — and app.cbs_officer_map crosswalks all 21 known Udara
   names to workspace users with 100% coverage of both books.

   That crosswalk is now reached through app.v_fd_officer (migration 284) rather
   than joined inline here, because a name crosswalk alone cannot be CORRECTED:
   repointing a name in cbs_officer_map moves every one of that officer's records
   at once, and Udara's API has no endpoint that can change an account officer at
   all (the officer is a field on the loan/FD account; there is no update endpoint
   for either). The view resolves account override > party override > Udara's own
   name, so a single wrongly-attributed deposit can be fixed without touching the
   other 382.

   btrim matters, and now lives inside the view. Udara pads 7 of the 21 officer
   names with a trailing space and cbs_officer_map was hand-seeded from those
   exact strings, so plain equality matches by luck: trim one side only and 173 of
   380 deposits (98 on the active book — 6 officers, ₦11.03bn of principal) fall
   out of officer attribution with no error at all, and that attribution feeds
   sales targets and commission.
*/
// Register paging bounds — see fdBookList for the contract.
const (
	fdBookListPageMax = 500   // largest explicit page
	fdBookListHardCap = 10000 // backstop for limit=0 ("whole book")
)

// The switch point the comment above anticipated, taken.
//
// These now read app.v_fd_officer (migration 284), which resolves the officer as
// account override > party override > Udara's accountOfficerName via
// app.cbs_officer_map. The btrim-on-both-sides crosswalk and the label fallback
// live inside that view now, so every surface gets the same answer and a
// correction made in one place shows up everywhere.
//
// Verified drop-in when introduced: the view returns exactly one row per deposit
// (383/383) and the resolved officer matched the previous inline join on all 383,
// so repointing changed no number until someone records an override.
const (
	sqlFDOfficerName = `m.udara_officer_name`
	sqlFDOfficerJoin = `LEFT JOIN app.v_fd_officer m ON m.cbs_id = f.cbs_id
				LEFT JOIN o3c_users u             ON u.id = m.officer_user_id`
	// The officer as the workspace should show them: the resolved user's name when
	// there is one, otherwise Udara's own spelling so nothing goes missing.
	sqlFDOfficerLabel = `m.officer_label`
)

// fdBookByOfficer — the funded Active book split by account officer, so the FD
// book can answer "whose deposits are these" the way the loan book already does.
func fdBookByOfficer(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, _ := db.PGQuery(r.Context(), `
			SELECT `+sqlFDOfficerLabel+` AS officer,
				m.officer_user_id,
				COUNT(*)                                     AS count,
				COUNT(DISTINCT f.cbs_customer_id)            AS unique_customers,
				COALESCE(SUM(f.principal_kobo), 0)           AS principal_kobo,
				COALESCE(SUM(f.accrued_interest_kobo), 0)    AS accrued_interest_kobo,
				COALESCE(SUM(f.principal_kobo * f.eff_rate) FILTER (WHERE f.eff_rate IS NOT NULL)
					/ NULLIF(SUM(f.principal_kobo) FILTER (WHERE f.eff_rate IS NOT NULL), 0), 0) AS avg_rate,
				COUNT(*) FILTER (WHERE f.maturity_date::date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30) AS maturing_30d_count,
				COALESCE(SUM(f.principal_kobo)
					FILTER (WHERE f.maturity_date::date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30), 0) AS maturing_30d_kobo,
				COUNT(*) FILTER (WHERE f.maturity_date::date < CURRENT_DATE) AS past_due_count
			FROM (
				SELECT *, `+sqlFDEffRate+` AS eff_rate
				FROM cbs_fixed_deposits
				WHERE status='Active' AND `+sqlFDFunded+`
			) f
			`+sqlFDOfficerJoin+`
			GROUP BY 1, 2
			ORDER BY principal_kobo DESC`)
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

// fdBookKPIs — headline deposit-book metrics from cbs_fixed_deposits (Active book).
func fdBookKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		out := map[string]any{
			"total_principal_kobo":             int64(0),
			"total_ledger_kobo":                int64(0),
			"total_accrued_interest_kobo":      int64(0),
			"active_count":                     int64(0),
			"unique_customers":                 int64(0),
			"weighted_avg_rate":                0.0,
			"weighted_avg_tenor_days":          0.0,
			"annualized_interest_expense_kobo": int64(0),
			"maturing_30d_count":               int64(0),
			"maturing_30d_kobo":                int64(0),
			"new_this_month_count":             int64(0),
			"past_due_count":                   int64(0),
			"past_due_kobo":                    int64(0),
			"unfunded_count":                   int64(0),
			"officer_count":                    int64(0),
			"unmapped_officer_count":           int64(0),
		}
		// Every figure below is scoped to the funded Active book (see sqlFDFunded)
		// so counts, customers and money all describe the same population, and the
		// unfunded shells are reported on their own line instead of padding it.
		// Date comparisons go through ::date: gts parses Udara timestamps as UTC
		// while the session is Africa/Lagos, so each date sits at 01:00:00+01 and an
		// uncast BETWEEN silently drops the far edge of the window.
		rows, err := db.PGQuery(r.Context(), `
			SELECT
				COALESCE(SUM(principal_kobo)        FILTER (WHERE book), 0) AS total_principal_kobo,
				COALESCE(SUM(ledger_balance_kobo)   FILTER (WHERE book), 0) AS total_ledger_kobo,
				COALESCE(SUM(accrued_interest_kobo) FILTER (WHERE book), 0) AS total_accrued_interest_kobo,
				COUNT(*)                            FILTER (WHERE book)     AS active_count,
				COUNT(DISTINCT cbs_customer_id)     FILTER (WHERE book)     AS unique_customers,
				-- Weighted by principal, on the effective rate: a deposit whose contract
				-- rate is missing is carried at the rate it is actually accruing at, and
				-- one that is neither rated nor accruing is left out instead of pulling
				-- the average toward zero.
				COALESCE(SUM(principal_kobo * eff_rate) FILTER (WHERE book AND eff_rate IS NOT NULL)
					/ NULLIF(SUM(principal_kobo) FILTER (WHERE book AND eff_rate IS NOT NULL), 0), 0) AS weighted_avg_rate,
				COALESCE(SUM(principal_kobo * tenor_days) FILTER (WHERE book AND tenor_days IS NOT NULL)
					/ NULLIF(SUM(principal_kobo) FILTER (WHERE book AND tenor_days IS NOT NULL), 0), 0) AS weighted_avg_tenor_days,
				-- Annualised interest-expense run-rate, from the daily accrual actually
				-- being incurred (same effective-rate basis as above).
				COALESCE(SUM(daily_accrual_kobo * 365.0) FILTER (WHERE book), 0)::bigint AS annualized_interest_expense_kobo,
				COUNT(*)                     FILTER (WHERE book AND maturity_date::date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30) AS maturing_30d_count,
				COALESCE(SUM(principal_kobo) FILTER (WHERE book AND maturity_date::date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30), 0) AS maturing_30d_kobo,
				-- Past maturity but still on the book — payable now, and previously
				-- invisible on every FD surface.
				COUNT(*)                     FILTER (WHERE book AND maturity_date::date < CURRENT_DATE) AS past_due_count,
				COALESCE(SUM(principal_kobo + COALESCE(accrued_interest_kobo,0))
					FILTER (WHERE book AND maturity_date::date < CURRENT_DATE), 0) AS past_due_kobo,
				COUNT(*) FILTER (WHERE book AND commencement_date::date >= DATE_TRUNC('month', CURRENT_DATE)::date) AS new_this_month_count,
				COUNT(*) FILTER (WHERE status='Active' AND NOT funded) AS unfunded_count,
				-- How many account officers hold the book, and how many deposits carry
				-- an officer name Udara sends but cbs_officer_map does not know (0 today
				-- — worth watching, because an unmapped officer is silently unattributed).
				COUNT(DISTINCT officer_display) FILTER (WHERE book AND officer_display <> '') AS officer_count,
				COUNT(*) FILTER (WHERE book AND officer_display <> '' AND officer_user_id IS NULL) AS unmapped_officer_count
			FROM (
				SELECT f.*,
					(` + sqlFDFunded + `)                  AS funded,
					status='Active' AND (` + sqlFDFunded + `) AS book,
					` + sqlFDEffRate + `                   AS eff_rate,
					` + sqlFDDailyAccrualKobo + `          AS daily_accrual_kobo,
					COALESCE(NULLIF(btrim(u.full_name),''), NULLIF(` + sqlFDOfficerName + `,''), '') AS officer_name,
					m.officer_user_id
				FROM cbs_fixed_deposits f
				` + sqlFDOfficerJoin + `
			) f`)
		if err == nil && len(rows) > 0 {
			row := rows[0]
			out["total_principal_kobo"] = toInt64(row["total_principal_kobo"])
			out["total_ledger_kobo"] = toInt64(row["total_ledger_kobo"])
			out["total_accrued_interest_kobo"] = toInt64(row["total_accrued_interest_kobo"])
			out["active_count"] = toInt64(row["active_count"])
			out["unique_customers"] = toInt64(row["unique_customers"])
			out["weighted_avg_rate"] = round1(toFloat(row["weighted_avg_rate"]))
			out["weighted_avg_tenor_days"] = round1(toFloat(row["weighted_avg_tenor_days"]))
			out["annualized_interest_expense_kobo"] = toInt64(row["annualized_interest_expense_kobo"])
			out["maturing_30d_count"] = toInt64(row["maturing_30d_count"])
			out["maturing_30d_kobo"] = toInt64(row["maturing_30d_kobo"])
			out["new_this_month_count"] = toInt64(row["new_this_month_count"])
			out["past_due_count"] = toInt64(row["past_due_count"])
			out["past_due_kobo"] = toInt64(row["past_due_kobo"])
			out["unfunded_count"] = toInt64(row["unfunded_count"])
			out["officer_count"] = toInt64(row["officer_count"])
			out["unmapped_officer_count"] = toInt64(row["unmapped_officer_count"])
		}
		respond(w, out, "pg")
	}
}

// fdBookMaturityLadder — Active principal bucketed by days-to-maturity.
func fdBookMaturityLadder(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, _ := db.PGQuery(r.Context(), `
			WITH b AS (
				SELECT
					CASE
						WHEN maturity_date::date < CURRENT_DATE                              THEN 'Overdue'
						WHEN maturity_date::date <= CURRENT_DATE + 30                        THEN '0–30d'
						WHEN maturity_date::date <= CURRENT_DATE + 60                        THEN '31–60d'
						WHEN maturity_date::date <= CURRENT_DATE + 90                        THEN '61–90d'
						WHEN maturity_date::date <= CURRENT_DATE + 180                       THEN '91–180d'
						WHEN maturity_date::date <= CURRENT_DATE + 365                       THEN '181–365d'
						ELSE '365d+'
					END AS bucket,
					principal_kobo, accrued_interest_kobo
				FROM cbs_fixed_deposits
				WHERE status='Active' AND ` + sqlFDFunded + ` AND maturity_date IS NOT NULL
			)
			SELECT bucket,
				COUNT(*)                               AS count,
				COALESCE(SUM(principal_kobo), 0)       AS principal_kobo,
				COALESCE(SUM(accrued_interest_kobo),0) AS accrued_interest_kobo
			FROM b
			GROUP BY bucket
			ORDER BY CASE bucket
				WHEN 'Overdue' THEN 0 WHEN '0–30d' THEN 1 WHEN '31–60d' THEN 2 WHEN '61–90d' THEN 3
				WHEN '91–180d' THEN 4 WHEN '181–365d' THEN 5 ELSE 6 END`)
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

// fdBookTrend — deposit-book size over time from the daily CBS portfolio snapshot.
func fdBookTrend(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, _ := db.PGQuery(r.Context(), `
			SELECT TO_CHAR(snapshot_date, 'YYYY-MM-DD') AS date,
				fd_active_count        AS active_count,
				fd_principal_kobo      AS principal_kobo,
				fd_ledger_balance_kobo AS ledger_kobo
			FROM cbs_portfolio_snapshot
			WHERE snapshot_date >= CURRENT_DATE - INTERVAL '90 days'
			ORDER BY snapshot_date`)
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

// fdBookByProduct — Active book split by FD product, with weighted rate.
func fdBookByProduct(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Same effective-rate and funded-book basis as fdBookKPIs, so the per-product
		// rates and annual interest add back up to the headline figures.
		rows, _ := db.PGQuery(r.Context(), `
			SELECT COALESCE(NULLIF(product_name,''), product_code, 'Unknown') AS product,
				COUNT(*)                                AS count,
				COALESCE(SUM(principal_kobo), 0)        AS principal_kobo,
				COALESCE(SUM(accrued_interest_kobo), 0) AS accrued_interest_kobo,
				COALESCE(SUM(principal_kobo * eff_rate) FILTER (WHERE eff_rate IS NOT NULL)
					/ NULLIF(SUM(principal_kobo) FILTER (WHERE eff_rate IS NOT NULL), 0), 0) AS avg_rate,
				COALESCE(SUM(daily_accrual_kobo * 365.0), 0)::bigint AS annual_interest_kobo
			FROM (
				SELECT product_name, product_code, principal_kobo, accrued_interest_kobo,
					` + sqlFDEffRate + `          AS eff_rate,
					` + sqlFDDailyAccrualKobo + ` AS daily_accrual_kobo
				FROM cbs_fixed_deposits
				WHERE status='Active' AND ` + sqlFDFunded + `
			) f
			GROUP BY 1
			ORDER BY principal_kobo DESC`)
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

// fdBookTenorDist — Active book bucketed by original tenor.
func fdBookTenorDist(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, _ := db.PGQuery(r.Context(), `
			WITH b AS (
				SELECT CASE
					WHEN tenor_days <= 30  THEN '≤30d'
					WHEN tenor_days <= 90  THEN '31–90d'
					WHEN tenor_days <= 180 THEN '91–180d'
					WHEN tenor_days <= 365 THEN '181–365d'
					ELSE '365d+'
				END AS bucket, principal_kobo
				FROM cbs_fixed_deposits
				WHERE status='Active' AND ` + sqlFDFunded + ` AND tenor_days IS NOT NULL
			)
			SELECT bucket, COUNT(*) AS count, COALESCE(SUM(principal_kobo),0) AS principal_kobo
			FROM b GROUP BY bucket
			ORDER BY CASE bucket
				WHEN '≤30d' THEN 1 WHEN '31–90d' THEN 2 WHEN '91–180d' THEN 3 WHEN '181–365d' THEN 4 ELSE 5 END`)
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

// fdBookList — paginated deposit register for the book view. This is the
// register, so it deliberately keeps showing every row the KPIs exclude — the
// 17 unfunded shells and the Closed deposits — and carries has_disbursed and
// is_past_due so the row can be labelled rather than quietly dropped.
//
// It also carries the account officer (customer_name too, since the register
// previously showed only Udara's customer ID). The loan export has had an
// officer column all along; the FD export had none, because the officer lives
// in raw and nothing here read it. `q` now searches the officer as well, so
// "show me Jennifer's deposits" is one search box away.
//
// Paging contract:
//
//	limit=1..500  one page of that size (default 50)
//	limit=0       the ENTIRE matching set in one response, offset ignored
//
// limit=0 exists because a grouped register has to total principal per customer
// across the whole book, and it cannot do that from a page. The register is a
// full DELETE+reload mirror of Udara's current FD book — 380 rows today, a few
// hundred kilobytes — so serving all of it is cheap and bounded by the upstream
// system, not by user input. fdBookListHardCap is the backstop if that book ever
// grows; `total` in the response still reports the true match count, so a client
// can always tell whether it received everything.
func fdBookList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := qint(r, "limit", 50, 1, fdBookListPageMax)
		offset := qint(r, "offset", 0, 0, 1<<30)
		// qint clamps to its minimum, so limit=0 has to be read before it is clamped.
		if r.URL.Query().Get("limit") == "0" {
			limit, offset = fdBookListHardCap, 0
		}
		q := "%" + r.URL.Query().Get("q") + "%"

		// One predicate, used by both the page query and the count, so they can never
		// disagree about what the search matched.
		where := `($1 = '%%'
			OR f.cbs_account_number ILIKE $1
			OR f.cbs_customer_id ILIKE $1
			OR f.product_name ILIKE $1
			OR f.raw->>'name' ILIKE $1
			OR ` + sqlFDOfficerLabel + ` ILIKE $1)`

		rows, _ := db.PGQuery(r.Context(), `
			SELECT f.cbs_account_number, f.cbs_customer_id, f.product_name, f.status,
				COALESCE(NULLIF(btrim(f.raw->>'name'),''), f.cbs_customer_id) AS customer_name,
				`+sqlFDOfficerLabel+` AS officer_name,
				m.officer_user_id,
				f.principal_kobo, f.accrued_interest_kobo, f.ledger_balance_kobo,
				f.interest_rate, f.tenor_days,
				(f.`+sqlFDFunded+`) AS has_disbursed,
				(f.status='Active' AND f.maturity_date::date < CURRENT_DATE) AS is_past_due,
				TO_CHAR(f.commencement_date, 'YYYY-MM-DD') AS commencement_date,
				TO_CHAR(f.date_booked, 'YYYY-MM-DD')       AS date_booked,
				TO_CHAR(f.maturity_date, 'YYYY-MM-DD')     AS maturity_date
			FROM cbs_fixed_deposits f
			`+sqlFDOfficerJoin+`
			WHERE `+where+`
			-- cbs_account_number is the tiebreaker, and it is load-bearing. Ties on
			-- maturity_date are common (6 active deposits share 2026-10-31; three more
			-- dates carry 4 each), and without a unique final key Postgres may order
			-- tied rows differently between two OFFSET pages — serving one deposit
			-- twice and dropping another. Invisible when eyeballing a flat table,
			-- corrupting once a page totals principal per customer across pages.
			ORDER BY (f.status='Active') DESC, f.maturity_date NULLS LAST, f.cbs_account_number
			LIMIT $2 OFFSET $3`, q, limit, offset)
		if rows == nil {
			rows = []core.Row{}
		}
		var total int64
		if tr, err := db.PGQuery(r.Context(), `
			SELECT COUNT(*) AS c FROM cbs_fixed_deposits f
			`+sqlFDOfficerJoin+`
			WHERE `+where, q); err == nil && len(tr) > 0 {
			total = toInt64(tr[0]["c"])
		}
		respond(w, map[string]any{"data": rows, "total": total}, "pg")
	}
}

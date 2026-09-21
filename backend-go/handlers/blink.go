package handlers

import (
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

// Blink is its own card family, and this is its own module.
//
// It replaces the stub in stubs.go, which identified Blink cards with
// `product_name ILIKE '%blink%' OR ILIKE '%PREP Temporary Virtual%'` against
// app.accounts. No row in the book is literally named "Blink" — the product is
// catalogued as 'PREP Temporary Virtual' (code 003) — so the whole page rested
// on a string match that would break the moment the product was renamed, and
// would silently capture any future product with "blink" in its name.
//
// Everything here keys on app.card_products.category = 'blink' (migration 239)
// through app.card_book_full (migration 240), which carries both axes: the
// lifecycle card_state and the usage activity_class.
//
// What Blink is: a temporary virtual card the customer funds in foreign
// currency and is credited the naira equivalent for. That makes two things
// first-class here that no other card page needs — the FX side, and the fact
// that these cards are MEANT to expire.
func RegisterBlink(r chi.Router, db *core.DB) {
	access := core.RequirePages("blink_card")
	r.With(access).Get("/summary", blinkSummary(db))
	r.With(access).Get("/cards", blinkCards(db))
	r.With(access).Get("/issuance-trend", blinkIssuanceTrend(db))
	r.With(access).Get("/fx", blinkFXRates(db))
}

// blinkCardsFrom is the single definition of "a Blink card" for this module.
// Anything that needs the population joins through here rather than restating
// the predicate — restating it is exactly how eight competing definitions of
// "what kind of card is this" accumulated across the codebase.
const blinkCardsFrom = `FROM app.card_book_full WHERE product_category = 'blink'`

func blinkSummary(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		// One pass over the population — the page's whole headline strip.
		var totals map[string]any
		if rows, err := db.PGQuery(ctx, `
			SELECT COUNT(*)                                                   AS total_cards,
			       COUNT(*) FILTER (WHERE card_state = 'Live')                AS live_cards,
			       COUNT(*) FILTER (WHERE card_state = 'Expired')             AS expired_cards,
			       COUNT(*) FILTER (WHERE activity_class = 'Active')          AS active_30d,
			       COUNT(*) FILTER (WHERE activity_class = 'Never used')      AS never_used,
			       COUNT(DISTINCT cif)                                        AS cardholders,
			       COALESCE(SUM(txn_count), 0)                                AS lifetime_txns
			  `+blinkCardsFrom); err == nil && len(rows) > 0 {
			totals = rows[0]
		} else if err != nil {
			respondErrLog(w, 500, "Blink summary failed", err)
			return
		}
		if totals == nil {
			totals = map[string]any{}
		}

		// Lifecycle axis.
		statusRows, _ := db.PGQuery(ctx, `
			SELECT card_state AS status, COUNT(*) AS count
			  `+blinkCardsFrom+`
			 GROUP BY card_state
			 ORDER BY count DESC`)

		// Usage axis. Ordered by how recent the bucket is rather than by size, so
		// the strip always reads Active → Never used regardless of the numbers.
		activityRows, _ := db.PGQuery(ctx, `
			SELECT activity_class, COUNT(*) AS count
			  `+blinkCardsFrom+`
			 GROUP BY activity_class
			 ORDER BY CASE activity_class
			            WHEN 'Active'     THEN 1
			            WHEN 'Light'      THEN 2
			            WHEN 'Dormant'    THEN 3
			            WHEN 'Inactive'   THEN 4
			            WHEN 'Never used' THEN 5
			            ELSE 6 END`)

		if statusRows == nil {
			statusRows = []core.Row{}
		}
		if activityRows == nil {
			activityRows = []core.Row{}
		}

		respond(w, map[string]any{
			"totals":            totals,
			"status_breakdown":  statusRows,
			"activity_breakdown": activityRows,
		}, "pg")
	}
}

// blinkCards lists the cards themselves, filterable on both axes.
func blinkCards(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		where := `product_category = 'blink'`
		var args []any
		n := 1

		if v := qstr(r, "status"); v != "" {
			where += fmt.Sprintf(" AND card_state = $%d", n)
			args = append(args, v)
			n++
		}
		if v := qstr(r, "activity"); v != "" {
			where += fmt.Sprintf(" AND activity_class = $%d", n)
			args = append(args, v)
			n++
		}
		if v := qstr(r, "q"); v != "" {
			where += fmt.Sprintf(" AND (cif ILIKE '%%' || $%d || '%%' OR name_on_card ILIKE '%%' || $%d || '%%' OR account_no ILIKE '%%' || $%d || '%%')", n, n, n)
			args = append(args, v)
			n++
		}

		limit := qint(r, "limit", 50, 1, 200)
		offset := qint(r, "offset", 0, 0, 1<<30)

		total := int64(0)
		if cr, _ := db.PGQuery(r.Context(),
			`SELECT COUNT(*) AS total FROM app.card_book_full WHERE `+where, args...); len(cr) > 0 {
			total = toInt64(cr[0]["total"])
		}

		// Balances on app.accounts are NAIRA numerics, not kobo (the cycle tables
		// are the kobo ones), so they are converted here rather than at the edge
		// — the frontend formats everything with fmtKobo.
		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT account_no,
			       cif,
			       COALESCE(name_on_card, '')                              AS name_on_card,
			       COALESCE(card_pan, '')                                  AS card_pan,
			       card_state,
			       activity_class,
			       last_txn_date,
			       days_since_txn,
			       txn_count,
			       TO_CHAR(opened_date,      'YYYY-MM-DD')                 AS opened_date,
			       TO_CHAR(card_expiry_date, 'YYYY-MM-DD')                 AS expiry_date,
			       is_expired,
			       COALESCE(ROUND(current_dr_balance * 100), 0)::bigint    AS balance_kobo,
			       COALESCE(product_currency, 'NGN')                       AS currency
			  FROM app.card_book_full
			 WHERE %s
			 ORDER BY last_txn_date DESC NULLS LAST, opened_date DESC
			 LIMIT %d OFFSET %d`, where, limit, offset), args...)
		if err != nil {
			respondErrLog(w, 500, "Blink card list failed", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respondPaginated(w, rows, total, "pg")
	}
}

// blinkIssuanceTrend is monthly issuance. Blink cards are temporary by design,
// so the interesting shape is issuance against how many of that month's cards
// are still live — a normal card page would just plot the count.
func blinkIssuanceTrend(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT TO_CHAR(DATE_TRUNC('month', opened_date), 'YYYY-MM')     AS month,
			       COUNT(*)                                                 AS issued,
			       COUNT(*) FILTER (WHERE card_state = 'Live')              AS still_live,
			       COUNT(*) FILTER (WHERE activity_class IN ('Active','Light')) AS used_recently
			  FROM app.card_book_full
			 WHERE product_category = 'blink' AND opened_date IS NOT NULL
			 GROUP BY DATE_TRUNC('month', opened_date)
			 ORDER BY DATE_TRUNC('month', opened_date) DESC
			 LIMIT 24`)
		if err != nil {
			respondErrLog(w, 500, "Blink trend failed", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		jsonRows(w, rows)
	}
}

// blinkFXRates surfaces the funding side. Blink is funded in foreign currency
// and credited in naira, so the prevailing rate is context the page needs.
//
// These are PARALLEL-MARKET rates scraped from a third party (app.fx_parallel_rates,
// refreshed hourly) — they are NOT the rate any particular card was funded at.
// The platform stores no conversion anywhere on purpose (frontend/src/lib/currency.ts):
// whether CCS sends dollars or pre-converted naira is unconfirmed. So this is
// returned as a rate-stamped reference, and the page must label it as such
// rather than multiplying balances by it.
func blinkFXRates(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT DISTINCT ON (currency)
			       currency, buy, sell, source,
			       TO_CHAR(scraped_at, 'YYYY-MM-DD HH24:MI') AS scraped_at
			  FROM app.fx_parallel_rates
			 WHERE currency IN ('USD', 'GBP', 'EUR')
			 ORDER BY currency, scraped_at DESC`)
		if err != nil {
			respondErrLog(w, 500, "FX rates failed", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, map[string]any{
			"rates": rows,
			"note":  "Parallel-market reference rates, refreshed hourly. Not the rate any card was funded at — balances are never converted.",
		}, "pg")
	}
}

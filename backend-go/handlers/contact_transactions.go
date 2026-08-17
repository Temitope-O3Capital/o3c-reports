package handlers

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// Per-customer transaction ledger.
//
// The profile payload carries only the latest 40 transactions for the whole
// person, which is useless for a customer like the Pinheiro party — 4,610
// transactions sit on a single card. This endpoint serves the ledger properly:
// paged, searchable, and filterable down to ONE card.
//
// A card's handle is its own CIF (a CIF is a card, not a person), and
// core.transaction is keyed by that same cif — so "show me this card's
// transactions" is an exact-match filter, not a heuristic. app.transactions
// carries idx_core_txn_cif_date (cif, txn_date) so both the person-wide and the
// single-card query stay on an index.
//
// Amounts here are naira numerics, NOT kobo — and the source encodes credits as
// NEGATIVE, so direction comes from money_in and magnitude from ABS(amount).
// Summing amount raw would net debits against credits and report nonsense.

const ctxnPageSize = 50

// usdCIFs is the set of card CIFs that post in dollars. Derived from the card
// book's product name (the ledger itself carries no currency column), and small
// enough — a couple of hundred accounts — to inline as a subquery.
const usdCIFs = `(SELECT cif FROM app.accounts WHERE product_name ILIKE '%USD%' AND cif IS NOT NULL)`

func contactTransactionsHandler(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cif := chi.URLParam(r, "cif")
		ctx := r.Context()

		page := qint(r, "page", 1, 1, 2000)
		size := qint(r, "size", ctxnPageSize, 10, 200)
		card := strings.TrimSpace(qstr(r, "card")) // a single card's CIF
		q := strings.TrimSpace(qstr(r, "q"))
		dir := qstr(r, "dir") // in | out
		from := strings.TrimSpace(qstr(r, "from"))
		to := strings.TrimSpace(qstr(r, "to"))

		// Every CIF belonging to the same person, so the unfiltered view spans the
		// whole relationship rather than the one card that was opened.
		personCIFs := `(SELECT c2.cif FROM app.customers c2
		    WHERE c2.party_id = (SELECT party_id FROM app.customers WHERE cif = $1 LIMIT 1)
		      AND c2.party_id IS NOT NULL
		    UNION SELECT $1)`

		args := []any{cif}
		cond := ""

		if card != "" {
			// Scope to one card, but only if that card really belongs to this person —
			// otherwise the cif query param would read any customer's ledger.
			args = append(args, card)
			cond += fmt.Sprintf(" AND t.cif = $%d AND $%d IN %s", len(args), len(args), personCIFs)
		} else {
			cond += " AND t.cif IN " + personCIFs
		}
		switch dir {
		case "in":
			cond += " AND t.money_in"
		case "out":
			cond += " AND NOT t.money_in"
		}
		if ch := strings.TrimSpace(qstr(r, "channel")); ch != "" {
			args = append(args, ch)
			cond += fmt.Sprintf(" AND t.channel = $%d", len(args))
		}
		if q != "" {
			args = append(args, "%"+q+"%")
			cond += fmt.Sprintf(" AND (t.description ILIKE $%d OR t.merchant_name ILIKE $%d)", len(args), len(args))
		}
		if from != "" {
			args = append(args, from)
			cond += fmt.Sprintf(" AND t.txn_date >= $%d::date", len(args))
		}
		if to != "" {
			args = append(args, to)
			cond += fmt.Sprintf(" AND t.txn_date <= $%d::date", len(args))
		}

		// Totals over the WHOLE filtered set, not the page — the header must describe
		// what the filter selected, not what happens to be visible.
		//
		// The ledger is not single-currency: the Amex USD products post dollars into
		// the same table (4,302 rows), so naira and dollars are summed SEPARATELY.
		// One combined total would read ₦963m for a customer whose USD card moved $2.
		summary := map[string]any{"count": 0, "money_in": 0, "money_out": 0, "net": 0, "usd_count": 0, "usd_in": 0, "usd_out": 0}
		if sr, _ := db.PGQuery(ctx, `
			SELECT COUNT(*)                                                    AS count,
			       COUNT(*) FILTER (WHERE t.cif IN `+usdCIFs+`)                AS usd_count,
			       COALESCE(SUM(ABS(t.amount)) FILTER (
			         WHERE t.money_in     AND t.cif NOT IN `+usdCIFs+`),0)::float8 AS money_in,
			       COALESCE(SUM(ABS(t.amount)) FILTER (
			         WHERE NOT t.money_in AND t.cif NOT IN `+usdCIFs+`),0)::float8 AS money_out,
			       (COALESCE(SUM(ABS(t.amount)) FILTER (WHERE t.money_in     AND t.cif NOT IN `+usdCIFs+`),0)
			      - COALESCE(SUM(ABS(t.amount)) FILTER (WHERE NOT t.money_in AND t.cif NOT IN `+usdCIFs+`),0))::float8 AS net,
			       COALESCE(SUM(ABS(t.amount)) FILTER (
			         WHERE t.money_in     AND t.cif IN `+usdCIFs+`),0)::float8 AS usd_in,
			       COALESCE(SUM(ABS(t.amount)) FILTER (
			         WHERE NOT t.money_in AND t.cif IN `+usdCIFs+`),0)::float8 AS usd_out
			  FROM core.transaction t
			 WHERE TRUE`+cond, args...); len(sr) > 0 {
			summary = sr[0]
		}

		args = append(args, size, (page-1)*size)
		// Concatenated, not Sprintf'd: usdCIFs contains a '%USD%' LIKE pattern, which
		// a format string would read as a verb.
		listQ := `
			SELECT t.txn_id, t.cif, t.txn_date::text AS date, t.post_date::text AS post_date,
			       ABS(t.amount)::float8 AS amount, t.money_in,
			       COALESCE(t.description,'')   AS description,
			       NULLIF(t.merchant_name,'')   AS merchant,
			       NULLIF(t.channel,'')         AS channel,
			       NULLIF(t.city,'')            AS city,
			       NULLIF(t.txn_code,'')        AS txn_code,
			       NULLIF(a.product_name,'')    AS card_product,
			       NULLIF(a.card_pan,'')        AS card_pan,
			       CASE WHEN t.cif IN ` + usdCIFs + ` THEN 'USD' ELSE 'NGN' END AS currency
			  FROM core.transaction t
			  -- LATERAL + LIMIT 1, not a plain join: app.accounts holds a handful of
			  -- duplicate CIFs and a plain join would multiply transaction rows.
			  LEFT JOIN LATERAL (
			    SELECT product_name, card_pan FROM app.accounts a2
			     WHERE a2.cif = t.cif ORDER BY a2.last_seen DESC NULLS LAST LIMIT 1
			  ) a ON TRUE
			 WHERE TRUE` + cond +
			fmt.Sprintf(`
			 ORDER BY t.txn_date DESC, t.txn_id DESC
			 LIMIT $%d OFFSET $%d`, len(args)-1, len(args))

		rows, err := db.PGQuery(ctx, listQ, args...)
		if err != nil {
			respondErr(w, 500, "Could not load transactions")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}

		total := toInt64(summary["count"])
		pages := int((total + int64(size) - 1) / int64(size))

		respond(w, map[string]any{
			"data":    rows,
			"total":   total,
			"page":    page,
			"pages":   pages,
			"size":    size,
			"summary": summary,
		}, "pg")
	}
}

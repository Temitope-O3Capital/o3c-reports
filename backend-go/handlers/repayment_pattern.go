package handlers

import (
	"net/http"
	"strings"

	"github.com/o3c/workspace/core"
)

// repaymentPatternHandler returns a customer's repayment cadence for a CIF — the
// same money-in view Customer 360 shows, so the collections/recovery detail panels
// can render the monthly-repayment mini-chart without pulling the whole 360 profile.
//
// Mounted under BOTH /api/collections-ops and /api/recovery-ops so each inherits its
// own "collections"/"recovery" page guard. Keyed by CIF (?cif=), resolved across all
// CIFs of the same party so a person's whole repayment history counts, not one card.
func repaymentPatternHandler(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cif := strings.TrimSpace(qstr(r, "cif"))
		if cif == "" {
			respondErr(w, 422, "cif is required")
			return
		}

		personCIFs := `(SELECT c2.cif FROM app.customers c2
		    WHERE c2.party_id = (SELECT party_id FROM app.customers WHERE cif = $1 LIMIT 1)
		      AND c2.party_id IS NOT NULL
		    UNION SELECT $1)`

		// Money paid in per month over the last 12 months — cadence at a glance.
		patRows, _ := db.PGQuery(r.Context(), `
			SELECT TO_CHAR(DATE_TRUNC('month',txn_date),'Mon YY') AS month,
			       DATE_TRUNC('month',txn_date) AS msort,
			       COALESCE(SUM(ABS(amount)),0)::float8 AS amount, COUNT(*) AS count
			FROM transaction WHERE cif IN `+personCIFs+` AND money_in = TRUE
			  AND txn_date >= DATE_TRUNC('month',CURRENT_DATE) - INTERVAL '11 months'
			GROUP BY 1, 2 ORDER BY msort`, cif)

		// The actual repayments (money_in), most recent first.
		payRows, _ := db.PGQuery(r.Context(), `
			SELECT txn_date::text AS date, ABS(amount)::float8 AS amount,
			       description, merchant_name AS merchant
			FROM transaction WHERE cif IN `+personCIFs+` AND money_in = TRUE
			ORDER BY txn_date DESC LIMIT 60`, cif)

		if patRows == nil {
			patRows = []core.Row{}
		}
		if payRows == nil {
			payRows = []core.Row{}
		}
		out := core.Row{
			"repayment_pattern": patRows,
			"payment_history":   payRows,
		}
		if len(payRows) > 0 {
			out["last_payment"] = payRows[0]
		}
		respond(w, out, "pg")
	}
}

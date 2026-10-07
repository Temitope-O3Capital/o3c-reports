package handlers

// Real Cash Flow Statement, branch-split, from app.cash_flow_statement_by_branch
// (migration 348) — Udara's own GL, derived by ledger conservation (net credit-minus-
// debit on every non-cash, non-internal account), not a derived estimate and not a
// strict leg-paired reconciliation against a named nostro ledger. See the migration's
// own header for the method and its known ~1-2% reconciliation residual, which this
// handler surfaces rather than hides.

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

// RegisterCashFlow mounts the branch-split Cash Flow Statement.
func RegisterCashFlow(r chi.Router, db *core.DB) {
	access := core.RequirePages("finance", "income")
	r.With(access).Get("/cash-flow-statement", cashFlowStatement(db))
}

func cashFlowStatement(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		branchParam := qstr(r, "branch")
		where := "WHERE 1=1"
		var args []any
		if branchParam == "lagos" {
			where += " AND branch = 'Lagos'"
		} else if branchParam == "abuja" {
			where += " AND branch = 'Abuja'"
		}

		rows, err := db.PGQuery(r.Context(), `
			SELECT branch, activity, line_label, amount_kobo, postings
			  FROM app.cash_flow_statement_by_branch `+where+`
			 ORDER BY CASE activity WHEN 'operating' THEN 1 WHEN 'investing' THEN 2
			                        WHEN 'financing' THEN 3 ELSE 4 END,
			          line_label`, args...)
		if err != nil {
			respondErrLog(w, 500, "cash flow statement failed", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}

		totalsRows, _ := db.PGQuery(r.Context(), `
			SELECT branch, activity, SUM(amount_kobo) AS amount_kobo
			  FROM app.cash_flow_statement_by_branch `+where+`
			 GROUP BY branch, activity ORDER BY branch, activity`, args...)
		if totalsRows == nil {
			totalsRows = []core.Row{}
		}

		respond(w, map[string]any{
			"lines":          rows,
			"totals":         totalsRows,
			"coverage_start": glPostingsCoverageStart,
			"basis": "Derived from Udara's own GL postings (app.cbs_gl_postings), " +
				glPostingsCoverageStart + " onward — not a reconciled cash/nostro ledger " +
				"(none exists in the core banking system). Built by whole-ledger " +
				"conservation (net movement on every non-cash account), not by pairing " +
				"individual posting legs; a small reconciliation gap (observed ~1-2% of " +
				"total activity) is expected and is not hidden in an 'Unclassified' line.",
		}, "pg")
	}
}

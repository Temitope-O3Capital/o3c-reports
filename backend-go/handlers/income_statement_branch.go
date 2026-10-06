package handlers

// Real Income Statement, branch-split, from app.income_statement_by_branch
// (migration 344) — Udara's own GL, not a derived estimate.

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

// RegisterIncomeStatementByBranch mounts the branch-split Income Statement.
func RegisterIncomeStatementByBranch(r chi.Router, db *core.DB) {
	access := core.RequirePages("finance", "income")
	r.With(access).Get("/income-statement-by-branch", incomeStatementByBranch(db))
}

func incomeStatementByBranch(db *core.DB) http.HandlerFunc {
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
			SELECT branch, statement_line, product_label, statement, amount_kobo, postings
			  FROM app.income_statement_by_branch `+where+`
			 ORDER BY statement, statement_line, product_label`, args...)
		if err != nil {
			respondErrLog(w, 500, "income statement failed", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}

		totalsRows, _ := db.PGQuery(r.Context(), `
			SELECT branch, statement, SUM(amount_kobo) AS amount_kobo
			  FROM app.income_statement_by_branch `+where+`
			 GROUP BY branch, statement ORDER BY branch, statement`, args...)
		if totalsRows == nil {
			totalsRows = []core.Row{}
		}

		respond(w, map[string]any{
			"lines":          rows,
			"totals":         totalsRows,
			"coverage_start": glPostingsCoverageStart,
		}, "pg")
	}
}

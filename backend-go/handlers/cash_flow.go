package handlers

// Real Cash Flow Statement, branch-split, date-filterable, drillable.
//
// Queries cbs_gl_postings directly rather than through app.cash_flow_statement_by_branch
// (migration 348) — that view sums the whole 2026-07-01+ history into one number per
// branch/activity/line with no date dimension left in its output, so a date range can't be
// applied after the fact. Same precedent as the old revenue_breakdown.go (now folded into
// income_statement_branch.go): narrow BEFORE aggregating, not after. The view itself is
// untouched and still correct for ad-hoc whole-history SQL — this handler duplicates its
// classification logic (account_kind CTE, gl_account_lines/gl_cash_flow_accounts priority)
// deliberately, the same way the view's own header documents it, so both must be kept in
// sync if the classification rules ever change.
//
// Udara's own GL (app.cbs_gl_postings), derived by ledger conservation (net credit-minus-
// debit on every non-cash, non-internal account), not a strict leg-paired reconciliation
// against a named nostro ledger — see migration 348's header for the method and its known
// ~1-2% reconciliation residual, which this handler surfaces rather than hides.

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

// RegisterCashFlow mounts the branch-split Cash Flow Statement.
func RegisterCashFlow(r chi.Router, db *core.DB) {
	access := core.RequirePages("finance", "income")
	r.With(access).Get("/cash-flow-statement", cashFlowStatement(db))
	r.With(access).Get("/cash-flow-statement/entries", cashFlowEntries(db))
}

// cashFlowClassifyCTE is shared, verbatim, between the summary and the drill-down query —
// the WHERE clause (branch/date) and outer SELECT differ, this part must not.
const cashFlowClassifyCTE = `
	WITH account_kind AS (
		SELECT account_number,
		       BOOL_OR(product_category = 'fixed_deposit') AS is_fd,
		       BOOL_OR(product_category = 'loan')           AS is_loan
		  FROM cbs_gl_postings
		 WHERE financial_date >= DATE '2026-07-01'
		 GROUP BY account_number
	),
	classified AS (
		SELECT
			p.id, p.financial_date, p.narration, p.posting_reference, p.account_number,
			p.account_name, p.side, p.amount_kobo,
			CASE p.branch_name WHEN 'Head Office Branch' THEN 'Lagos'
			                   WHEN 'Abuja Branch'       THEN 'Abuja'
			                   ELSE COALESCE(p.branch_name, 'Unattributed') END AS branch,
			COALESCE(
				a.activity,
				CASE WHEN l.account_number IS NOT NULL THEN 'operating' END,
				CASE WHEN k.is_fd                        THEN 'financing' END,
				CASE WHEN k.is_loan                       THEN 'investing' END,
				CASE WHEN p.product_category = 'withholding_tax' THEN 'operating' END,
				'unclassified'
			) AS activity,
			COALESCE(
				a.label,
				l.statement_line,
				CASE WHEN k.is_fd   THEN 'Fixed Deposit Principal Movement' END,
				CASE WHEN k.is_loan THEN 'Loan Principal Movement' END,
				CASE WHEN p.product_category = 'withholding_tax' THEN 'Withholding Tax' END,
				'Unclassified (' || p.product_category || ')'
			) AS line_label
		  FROM cbs_gl_postings p
		  LEFT JOIN gl_account_lines l       ON l.account_number = p.account_number
		  LEFT JOIN gl_cash_flow_accounts a  ON a.account_number = p.account_number
		  LEFT JOIN account_kind k           ON k.account_number = p.account_number
		 WHERE p.financial_date >= $1::date`

// cashFlowWhereArgs builds the branch/date narrowing shared by both endpoints. The floor
// ($1) is always applied; branch/date_from/date_to only further narrow it.
func cashFlowWhereArgs(r *http.Request) (string, []any) {
	where := ""
	args := []any{glPostingsCoverageStart}
	n := 2
	branch := branchFilterName(qstr(r, "branch"))
	if branch != "" {
		where += " AND p.branch_name = $" + itoa(n)
		args = append(args, branch)
		n++
	}
	if from, _ := validDate(r, "date_from"); from != "" {
		where += " AND p.financial_date >= $" + itoa(n) + "::date"
		args = append(args, from)
		n++
	}
	if to, _ := validDate(r, "date_to"); to != "" {
		where += " AND p.financial_date <= $" + itoa(n) + "::date"
		args = append(args, to)
		n++
	}
	return where, args
}

func cashFlowStatement(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		postingsWhere, args := cashFlowWhereArgs(r)

		rows, err := db.PGQuery(r.Context(), cashFlowClassifyCTE+postingsWhere+`
			)
			SELECT branch, activity, line_label,
			       SUM(CASE WHEN side = 'credit' THEN amount_kobo ELSE -amount_kobo END)::bigint AS amount_kobo,
			       COUNT(*)::bigint AS postings
			  FROM classified
			 WHERE activity NOT IN ('cash', 'internal')
			 GROUP BY branch, activity, line_label
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

		totalsRows, _ := db.PGQuery(r.Context(), cashFlowClassifyCTE+postingsWhere+`
			)
			SELECT branch, activity,
			       SUM(CASE WHEN side = 'credit' THEN amount_kobo ELSE -amount_kobo END)::bigint AS amount_kobo
			  FROM classified
			 WHERE activity NOT IN ('cash', 'internal')
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

// cashFlowEntries is the drill-down behind one row of the Cash Flow Statement: the actual
// GL postings that sum to that activity+line, within whatever branch/date filter is set.
func cashFlowEntries(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		activity := qstr(r, "activity")
		lineLabel := qstr(r, "line_label")
		if activity == "" || lineLabel == "" {
			respond(w, map[string]any{"error": "activity and line_label are required"}, "pg")
			return
		}
		postingsWhere, args := cashFlowWhereArgs(r)
		n := len(args) + 1
		args = append(args, activity, lineLabel)

		rows, err := db.PGQuery(r.Context(), cashFlowClassifyCTE+postingsWhere+`
			)
			SELECT id, financial_date, narration, posting_reference, account_number,
			       account_name, side, amount_kobo, branch
			  FROM classified
			 WHERE activity = $`+itoa(n)+` AND line_label = $`+itoa(n+1)+`
			 ORDER BY financial_date DESC, id DESC
			 LIMIT 500`, args...)
		if err != nil {
			respondErrLog(w, 500, "cash flow entries failed", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, map[string]any{"entries": rows}, "pg")
	}
}

package handlers

// Real Income Statement, branch-split, date-filterable, drillable.
//
// Queries cbs_gl_postings directly rather than through app.income_statement_by_branch
// (migration 347) for the same reason cash_flow.go does: that view sums the whole
// 2026-07-01+ history into one number per branch/line with no date dimension left in its
// output, so a date range can't be applied after the fact. The view stays untouched and
// correct for ad-hoc whole-history SQL; this handler duplicates its three CTEs (rent,
// income, expense_ex_rent) deliberately, with a date WHERE added to each — keep both in
// sync if the classification rules ever change.
//
// Also absorbs what used to be the separate Revenue Breakdown page/endpoint
// (revenue_breakdown.go, retired): card joining fees and loan management/other fees have
// no reliable GL source (migration 341's header) and are folded in from app.fee_income /
// app.loan_fee_income (status='approved' only) as their own lines, alongside whatever
// sparse GL postings exist for the same thing — a manual entry and a rare real GL posting
// both count, neither replaces the other.

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

// RegisterIncomeStatementByBranch mounts the branch-split Income Statement.
func RegisterIncomeStatementByBranch(r chi.Router, db *core.DB) {
	access := core.RequirePages("finance", "income")
	r.With(access).Get("/income-statement-by-branch", incomeStatementByBranch(db))
	r.With(access).Get("/income-statement-by-branch/entries", incomeStatementEntries(db))
}

// incomeFilters holds the branch/date filter state for one request, built once and reused
// across the summary query and (with the same values) the drill-down query, so the two can
// never drift out of sync with each other.
type incomeFilters struct {
	args          []any  // $1=floor, then optionally date_from, date_to — always in this order
	glDateWhere   string // " AND p.financial_date >= $2::date AND p.financial_date <= $3::date" etc
	feeDateWhere  string // same values, against the fee tables' own date column
	udaraBranch   string // '', 'Head Office Branch', or 'Abuja Branch' — for filtering RAW postings
	displayBranch string // '', 'Lagos', or 'Abuja' — for filtering the CTEs' translated output
}

func parseIncomeFilters(r *http.Request) incomeFilters {
	f := incomeFilters{args: []any{glPostingsCoverageStart}}
	n := 2
	if from, _ := validDate(r, "date_from"); from != "" {
		f.glDateWhere += " AND p.financial_date >= $" + itoa(n) + "::date"
		f.feeDateWhere += " AND fee_date >= $" + itoa(n) + "::date"
		f.args = append(f.args, from)
		n++
	}
	if to, _ := validDate(r, "date_to"); to != "" {
		f.glDateWhere += " AND p.financial_date <= $" + itoa(n) + "::date"
		f.feeDateWhere += " AND fee_date <= $" + itoa(n) + "::date"
		f.args = append(f.args, to)
		n++
	}
	switch qstr(r, "branch") {
	case "lagos":
		f.udaraBranch, f.displayBranch = "Head Office Branch", "Lagos"
	case "abuja":
		f.udaraBranch, f.displayBranch = "Abuja Branch", "Abuja"
	}
	return f
}

// incomeStatementCTE is the 5-way UNION ALL (3 GL-sourced + 2 fee-sourced) every query in
// this file reads from. Uses f.args as-is — callers must pass f.args (or a copy with more
// appended at the END) to PGQuery.
func incomeStatementCTE(f incomeFilters) string {
	return `
	WITH rent AS (
		SELECT CASE WHEN l.product_label LIKE 'Rent 3%' THEN 'Abuja' ELSE 'Lagos' END AS branch,
		       l.statement_line, l.product_label, l.statement,
		       SUM(CASE WHEN p.side = 'debit' THEN p.amount_kobo ELSE -p.amount_kobo END) AS amount_kobo,
		       COUNT(*) AS postings
		  FROM cbs_gl_postings p
		  JOIN gl_account_lines l ON l.account_number = p.account_number
		 WHERE l.statement_line = 'Rent' AND p.financial_date >= $1::date` + f.glDateWhere + `
		 GROUP BY 1, l.statement_line, l.product_label, l.statement
	),
	income AS (
		SELECT CASE p.branch_name WHEN 'Head Office Branch' THEN 'Lagos'
		                          WHEN 'Abuja Branch'       THEN 'Abuja'
		                          ELSE COALESCE(p.branch_name, 'Unattributed') END AS branch,
		       l.statement_line, l.product_label, l.statement,
		       SUM(CASE WHEN p.side = 'credit' THEN p.amount_kobo ELSE -p.amount_kobo END) AS amount_kobo,
		       COUNT(*) AS postings
		  FROM cbs_gl_postings p
		  JOIN gl_account_lines l ON l.account_number = p.account_number
		 WHERE l.statement = 'income' AND p.financial_date >= $1::date` + f.glDateWhere + `
		 GROUP BY 1, l.statement_line, l.product_label, l.statement
	),
	expense_ex_rent AS (
		SELECT CASE p.branch_name WHEN 'Head Office Branch' THEN 'Lagos'
		                          WHEN 'Abuja Branch'       THEN 'Abuja'
		                          ELSE COALESCE(p.branch_name, 'Unattributed') END AS branch,
		       l.statement_line, l.product_label, l.statement,
		       SUM(CASE WHEN p.side = 'debit' THEN p.amount_kobo ELSE -p.amount_kobo END) AS amount_kobo,
		       COUNT(*) AS postings
		  FROM cbs_gl_postings p
		  JOIN gl_account_lines l ON l.account_number = p.account_number
		 WHERE l.statement = 'expense' AND l.statement_line <> 'Rent' AND p.financial_date >= $1::date` + f.glDateWhere + `
		 GROUP BY 1, l.statement_line, l.product_label, l.statement
	),
	card_fees AS (
		SELECT CASE branch_name WHEN 'Head Office Branch' THEN 'Lagos'
		                        WHEN 'Abuja Branch'       THEN 'Abuja'
		                        ELSE COALESCE(branch_name, 'Unattributed') END AS branch,
		       'Card Joining Fees'::text AS statement_line, fee_type AS product_label, 'income'::text AS statement,
		       SUM(amount_kobo) AS amount_kobo, COUNT(*) AS postings
		  FROM fee_income
		 WHERE status = 'approved' AND fee_date >= $1::date` + f.feeDateWhere + `
		 GROUP BY 1, fee_type
	),
	loan_fees AS (
		SELECT CASE cl.branch_name WHEN 'Head Office Branch' THEN 'Lagos'
		                            WHEN 'Abuja Branch'       THEN 'Abuja'
		                            ELSE COALESCE(cl.branch_name, 'Unattributed') END AS branch,
		       'Loan Fee Income'::text AS statement_line,
		       (CASE cl.product_code WHEN '402' THEN 'SME' WHEN '401' THEN 'Individual' ELSE 'Unknown' END
		        || ' — ' || lfi.fee_type) AS product_label,
		       'income'::text AS statement,
		       SUM(lfi.amount_kobo) AS amount_kobo, COUNT(*) AS postings
		  FROM loan_fee_income lfi
		  LEFT JOIN cbs_loans cl ON cl.cbs_account_number = lfi.loan_account
		 WHERE lfi.status = 'approved' AND lfi.fee_date >= $1::date` + f.feeDateWhere + `
		 GROUP BY 1, cl.product_code, lfi.fee_type
	),
	combined AS (
		SELECT * FROM income UNION ALL
		SELECT * FROM expense_ex_rent UNION ALL
		SELECT * FROM rent UNION ALL
		SELECT * FROM card_fees UNION ALL
		SELECT * FROM loan_fees
	)`
}

func incomeStatementByBranch(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		f := parseIncomeFilters(r)
		cte := incomeStatementCTE(f)
		branchWhere := ""
		if f.displayBranch != "" {
			branchWhere = " AND branch = '" + f.displayBranch + "'" // fixed 2-value set, not user input
		}

		rows, err := db.PGQuery(r.Context(), cte+`
			SELECT branch, statement_line, product_label, statement, amount_kobo, postings
			  FROM combined WHERE 1=1`+branchWhere+`
			 ORDER BY statement, statement_line, product_label`, f.args...)
		if err != nil {
			respondErrLog(w, 500, "income statement failed", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}

		totalsRows, _ := db.PGQuery(r.Context(), cte+`
			SELECT branch, statement, SUM(amount_kobo) AS amount_kobo
			  FROM combined WHERE 1=1`+branchWhere+`
			 GROUP BY branch, statement ORDER BY branch, statement`, f.args...)
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

// incomeStatementEntries is the drill-down behind one row: the GL postings (or fee_income /
// loan_fee_income rows) that sum to that statement_line + product_label, within whatever
// branch/date filter is set. Re-runs `combined`, filtered to the clicked line, un-aggregated
// via a correlated-free direct SELECT against the same source tables — not a second
// classification scheme, the identical WHERE predicates `incomeStatementCTE` already uses
// per source, just without the final GROUP BY/SUM.
func incomeStatementEntries(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		statementLine := qstr(r, "statement_line")
		productLabel := qstr(r, "product_label")
		if statementLine == "" {
			respond(w, map[string]any{"error": "statement_line is required"}, "pg")
			return
		}
		f := parseIncomeFilters(r)

		if statementLine == "Card Joining Fees" {
			args := append(append([]any{}, f.args...), productLabel)
			rows, _ := db.PGQuery(r.Context(), `
				SELECT id, fee_date AS financial_date, fee_type, amount_kobo, branch_name, ref AS narration
				  FROM fee_income
				 WHERE status = 'approved' AND fee_date >= $1::date`+f.feeDateWhere+`
				   AND fee_type = $`+itoa(len(args))+`
				 ORDER BY fee_date DESC LIMIT 500`, args...)
			if rows == nil {
				rows = []core.Row{}
			}
			respond(w, map[string]any{"entries": rows}, "pg")
			return
		}
		if statementLine == "Loan Fee Income" {
			args := append(append([]any{}, f.args...), productLabel)
			rows, _ := db.PGQuery(r.Context(), `
				SELECT lfi.id, lfi.fee_date AS financial_date, lfi.fee_type, lfi.amount_kobo,
				       lfi.loan_account, cl.branch_name
				  FROM loan_fee_income lfi
				  LEFT JOIN cbs_loans cl ON cl.cbs_account_number = lfi.loan_account
				 WHERE lfi.status = 'approved' AND lfi.fee_date >= $1::date`+f.feeDateWhere+`
				   AND (CASE cl.product_code WHEN '402' THEN 'SME' WHEN '401' THEN 'Individual' ELSE 'Unknown' END
				        || ' — ' || lfi.fee_type) = $`+itoa(len(args))+`
				 ORDER BY lfi.fee_date DESC LIMIT 500`, args...)
			if rows == nil {
				rows = []core.Row{}
			}
			respond(w, map[string]any{"entries": rows}, "pg")
			return
		}

		// GL-sourced: raw cbs_gl_postings, same predicates the matching CTE above uses.
		// Rent's own CTE never filters on p.branch_name (branch is derived from
		// product_label instead — see incomeStatementCTE's rent CTE), so its drill-down
		// must not add a branch arg either, or the placeholder count won't match the query.
		args := append([]any{}, f.args...) // $1=floor, then optional date_from/date_to, in that order

		var sql string
		if statementLine == "Rent" {
			args = append(args, productLabel)
			sql = `SELECT p.id, p.financial_date, p.narration, p.posting_reference, p.account_number,
			              p.account_name, p.side, p.amount_kobo
			         FROM cbs_gl_postings p
			         JOIN gl_account_lines l ON l.account_number = p.account_number
			        WHERE l.statement_line = 'Rent' AND p.financial_date >= $1::date` + f.glDateWhere + `
			          AND l.product_label = $` + itoa(len(args)) + `
			        ORDER BY p.financial_date DESC LIMIT 500`
		} else {
			branchWhere := ""
			if f.udaraBranch != "" {
				args = append(args, f.udaraBranch)
				branchWhere = " AND p.branch_name = $" + itoa(len(args))
			}
			args = append(args, statementLine)
			slPos := len(args)
			args = append(args, productLabel)
			plPos := len(args)
			sql = `SELECT p.id, p.financial_date, p.narration, p.posting_reference, p.account_number,
			              p.account_name, p.side, p.amount_kobo
			         FROM cbs_gl_postings p
			         JOIN gl_account_lines l ON l.account_number = p.account_number
			        WHERE l.statement_line = $` + itoa(slPos) + `
			          AND (l.product_label = $` + itoa(plPos) + ` OR ($` + itoa(plPos) + ` = '' AND l.product_label IS NULL))
			          AND p.financial_date >= $1::date` + f.glDateWhere + branchWhere + `
			        ORDER BY p.financial_date DESC LIMIT 500`
		}
		rows, err := db.PGQuery(r.Context(), sql, args...)
		if err != nil {
			respondErrLog(w, 500, "income statement entries failed", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, map[string]any{"entries": rows}, "pg")
	}
}

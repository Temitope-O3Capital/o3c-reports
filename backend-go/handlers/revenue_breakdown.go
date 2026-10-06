package handlers

// Total Revenue drill-down for the Finance Overview page.
//
// Interest and most fee income come straight from Udara's own GL (app.cbs_gl_postings,
// joined to app.gl_account_lines for the statement line / product label — migration 342).
// Card joining fees and loan management/other fees have no reliable upstream source at
// all (see migration 341's header); those two lines are added FROM app.fee_income /
// app.loan_fee_income (status='approved' only) ALONGSIDE whatever sparse GL postings
// exist for the same account, rather than one replacing the other — a manually recorded
// fee and a rare real GL posting for the same thing are both real money and both count.
//
// Coverage ceiling: app.cbs_gl_postings only reaches back to 2026-07-01 (Udara's own
// limit, not a filter this handler applies) — the payload says so explicitly rather than
// let a date-filtered zero look like "no revenue" for an earlier period.

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

const glPostingsCoverageStart = "2026-07-01"

// RegisterRevenueBreakdown mounts the Total Revenue drill-down under /api/finance.
func RegisterRevenueBreakdown(r chi.Router, db *core.DB) {
	access := core.RequirePages("finance", "income")
	r.With(access).Get("/revenue-breakdown", revenueBreakdown(db))
}

// branchFilterName maps the UI's lowercase branch param to Udara's real branch_name.
// '' or 'consolidated' means no filter at all.
func branchFilterName(v string) string {
	switch v {
	case "lagos":
		return "Head Office Branch"
	case "abuja":
		return "Abuja Branch"
	default:
		return ""
	}
}

func revenueBreakdown(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		branch := branchFilterName(qstr(r, "branch"))
		from, _ := validDate(r, "date_from")
		to, _ := validDate(r, "date_to")
		sector := qstr(r, "sector") // loan economic_sector code; cards have no coverage, see below

		where := "WHERE p.financial_date >= $1::date"
		args := []any{glPostingsCoverageStart}
		n := 2
		if branch != "" {
			where += " AND p.branch_name = $" + itoa(n)
			args = append(args, branch)
			n++
		}
		if from != "" {
			where += " AND p.financial_date >= $" + itoa(n) + "::date"
			args = append(args, from)
			n++
		}
		if to != "" {
			where += " AND p.financial_date <= $" + itoa(n) + "::date"
			args = append(args, to)
			n++
		}
		// Sector only ever narrows the loan lines (via cbs_loans.economic_sector on the
		// resolved narration loan account) — card/other lines are returned unfiltered
		// because no sector data exists for cards at all (0/707 Blink cards, ~0.2% of the
		// card book generally). Filtering them would silently zero out a line that simply
		// has no sector to filter by, which reads as "no revenue" rather than "no data".
		sectorJoin := ""
		sectorWhere := ""
		if sector != "" {
			sectorJoin = ` LEFT JOIN cbs_loans cl_sec ON cl_sec.cbs_account_number = p.cbs_loan_account`
			sectorWhere = " AND (l.statement_line NOT LIKE 'Loan %' OR cl_sec.economic_sector = $" + itoa(n) + ")"
			args = append(args, sector)
			n++
		}

		rows, err := db.PGQuery(ctx, `
			SELECT l.statement_line, l.product_label,
			       SUM(p.amount_kobo) AS amount_kobo,
			       COUNT(*) AS postings
			  FROM cbs_gl_postings p
			  JOIN gl_account_lines l ON l.account_number = p.account_number
			  `+sectorJoin+`
			  `+where+sectorWhere+`
			   AND p.side = 'credit' AND l.statement = 'income'
			 GROUP BY l.statement_line, l.product_label
			 ORDER BY l.statement_line, l.product_label`,
			args...)
		if err != nil {
			respondErrLog(w, 500, "revenue breakdown failed", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}

		// Card joining fees and loan fees: approved manual entries, same branch/date
		// window. Zero rows renders as an explicit zero with a note, never a silent gap —
		// see migration 341's header for why these have no other source today.
		feeWhere := "WHERE status='approved'"
		feeArgs := []any{}
		fn := 1
		if from != "" {
			feeWhere += " AND fee_date >= $" + itoa(fn) + "::date"
			feeArgs = append(feeArgs, from)
			fn++
		}
		if to != "" {
			feeWhere += " AND fee_date <= $" + itoa(fn) + "::date"
			feeArgs = append(feeArgs, to)
			fn++
		}
		if branch != "" {
			feeWhere += " AND branch_name = $" + itoa(fn)
			feeArgs = append(feeArgs, branch)
			fn++
		}
		cardFeeRows, _ := db.PGQuery(ctx, `
			SELECT fee_type, SUM(amount_kobo) AS amount_kobo, COUNT(*) AS entries
			  FROM fee_income `+feeWhere+`
			 GROUP BY fee_type`, feeArgs...)
		if cardFeeRows == nil {
			cardFeeRows = []core.Row{}
		}

		loanFeeWhere := "WHERE lfi.status='approved'"
		loanFeeArgs := []any{}
		ln := 1
		if from != "" {
			loanFeeWhere += " AND lfi.fee_date >= $" + itoa(ln) + "::date"
			loanFeeArgs = append(loanFeeArgs, from)
			ln++
		}
		if to != "" {
			loanFeeWhere += " AND lfi.fee_date <= $" + itoa(ln) + "::date"
			loanFeeArgs = append(loanFeeArgs, to)
			ln++
		}
		if branch != "" {
			loanFeeWhere += " AND cl.branch_name = $" + itoa(ln)
			loanFeeArgs = append(loanFeeArgs, branch)
			ln++
		}
		loanFeeRows, _ := db.PGQuery(ctx, `
			SELECT lfi.fee_type,
			       CASE cl.product_code WHEN '402' THEN 'SME' WHEN '401' THEN 'Individual' ELSE 'Unknown' END AS segment,
			       SUM(lfi.amount_kobo) AS amount_kobo, COUNT(*) AS entries
			  FROM loan_fee_income lfi
			  LEFT JOIN cbs_loans cl ON cl.cbs_account_number = lfi.loan_account
			 `+loanFeeWhere+`
			 GROUP BY lfi.fee_type, segment`, loanFeeArgs...)
		if loanFeeRows == nil {
			loanFeeRows = []core.Row{}
		}

		branchApplied := "All"
		if branch != "" {
			branchApplied = qstr(r, "branch")
		}
		respond(w, map[string]any{
			"gl_lines":       rows,
			"card_fees":      cardFeeRows,
			"loan_fees":      loanFeeRows,
			"branch":         branchApplied,
			"coverage_start": glPostingsCoverageStart,
			"sector_note":    "Sector filter applies to loan lines only — no sector data exists for cards today.",
		}, "pg")
	}
}

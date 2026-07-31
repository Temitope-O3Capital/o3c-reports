package handlers

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// RegisterCBSReports mounts read-only reporting endpoints over the CBS snapshot
// tables (populated by the sync worker). All amounts are in kobo. Mounted under
// /api/cbs, so already behind AuthMiddleware.
func RegisterCBSReports(r chi.Router, db *core.DB) {
	r.Get("/reports/loan-book", cbsLoanBook(db))
	r.Get("/reports/fd-book", cbsFDBook(db))
	r.Get("/reports/reconciliation", cbsReconciliation(db))
}

// cbsLoanBook returns the credit book: totals, breakdowns by status/product, and the loan list.
func cbsLoanBook(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		summary := queryRows(ctx, db, `
			SELECT count(*)::bigint AS accounts,
			       COALESCE(sum(loan_amount_kobo),0)::bigint           AS disbursed_kobo,
			       COALESCE(sum(outstanding_principal_kobo),0)::bigint AS outstanding_principal_kobo,
			       COALESCE(sum(outstanding_interest_kobo),0)::bigint  AS outstanding_interest_kobo,
			       COALESCE(sum(outstanding_fee_kobo),0)::bigint       AS outstanding_fee_kobo
			FROM cbs_loans`)
		byStatus := queryRows(ctx, db, `
			SELECT status, count(*)::bigint AS count,
			       COALESCE(sum(outstanding_principal_kobo),0)::bigint AS outstanding_kobo
			FROM cbs_loans GROUP BY status ORDER BY count(*) DESC`)
		byProduct := queryRows(ctx, db, `
			SELECT product_name, count(*)::bigint AS count,
			       COALESCE(sum(outstanding_principal_kobo),0)::bigint AS outstanding_kobo
			FROM cbs_loans GROUP BY product_name ORDER BY count(*) DESC`)
		loans := queryRows(ctx, db, `
			SELECT cbs_account_number, cbs_customer_id, product_name, status,
			       loan_amount_kobo, outstanding_principal_kobo, outstanding_interest_kobo,
			       interest_rate, tenor_days, start_date, maturity_date, officer_name
			FROM cbs_loans ORDER BY outstanding_principal_kobo DESC`)

		cbsWriteJSON(w, http.StatusOK, map[string]any{
			"summary":    firstRow(summary),
			"by_status":  byStatus,
			"by_product": byProduct,
			"loans":      loans,
		})
	}
}

// cbsFDBook returns the fixed-deposit register: totals, breakdowns, maturity ladder, and the FD list.
func cbsFDBook(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		summary := queryRows(ctx, db, `
			SELECT count(*)::bigint AS accounts,
			       COALESCE(sum(principal_kobo),0)::bigint        AS principal_kobo,
			       COALESCE(sum(accrued_interest_kobo),0)::bigint AS accrued_kobo,
			       COALESCE(sum(ledger_balance_kobo),0)::bigint   AS ledger_kobo
			FROM cbs_fixed_deposits`)
		byStatus := queryRows(ctx, db, `
			SELECT status, count(*)::bigint AS count,
			       COALESCE(sum(principal_kobo),0)::bigint AS principal_kobo
			FROM cbs_fixed_deposits GROUP BY status ORDER BY count(*) DESC`)
		byProduct := queryRows(ctx, db, `
			SELECT product_name, count(*)::bigint AS count,
			       COALESCE(sum(principal_kobo),0)::bigint AS principal_kobo
			FROM cbs_fixed_deposits GROUP BY product_name ORDER BY count(*) DESC`)
		ladder := queryRows(ctx, db, `
			SELECT to_char(date_trunc('month', maturity_date), 'YYYY-MM') AS bucket,
			       count(*)::bigint AS count,
			       COALESCE(sum(principal_kobo),0)::bigint AS principal_kobo
			FROM cbs_fixed_deposits WHERE maturity_date IS NOT NULL
			GROUP BY 1 ORDER BY 1`)
		fds := queryRows(ctx, db, `
			SELECT cbs_account_number, cbs_customer_id, product_name, status,
			       principal_kobo, accrued_interest_kobo, ledger_balance_kobo,
			       interest_rate, tenor_days, commencement_date, maturity_date
			FROM cbs_fixed_deposits ORDER BY principal_kobo DESC`)

		cbsWriteJSON(w, http.StatusOK, map[string]any{
			"summary":         firstRow(summary),
			"by_status":       byStatus,
			"by_product":      byProduct,
			"maturity_ladder": ladder,
			"fixed_deposits":  fds,
		})
	}
}

// cbsReconciliation reports how the CBS book maps to workspace records and lists unmatched CBS accounts.
func cbsReconciliation(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		loanStats := queryRows(ctx, db, `
			SELECT count(*)::bigint AS cbs_total,
			       count(*) FILTER (WHERE cbs_customer_id <> '' AND EXISTS (
			           SELECT 1 FROM loan_applications la WHERE la.applicant_cif = cbs_loans.cbs_customer_id))::bigint AS matched
			FROM cbs_loans`)
		fdStats := queryRows(ctx, db, `
			SELECT count(*)::bigint AS cbs_total,
			       count(*) FILTER (WHERE cbs_customer_id <> '' AND EXISTS (
			           SELECT 1 FROM fd_transactions fd WHERE fd.cif_number = cbs_fixed_deposits.cbs_customer_id))::bigint AS matched
			FROM cbs_fixed_deposits`)
		unmatchedLoans := queryRows(ctx, db, `
			SELECT cbs_account_number, cbs_customer_id, product_name, status, outstanding_principal_kobo
			FROM cbs_loans cl
			WHERE cl.cbs_customer_id = '' OR NOT EXISTS (
			    SELECT 1 FROM loan_applications la WHERE la.applicant_cif = cl.cbs_customer_id)
			ORDER BY outstanding_principal_kobo DESC`)
		unmatchedFDs := queryRows(ctx, db, `
			SELECT cbs_account_number, cbs_customer_id, product_name, status, principal_kobo
			FROM cbs_fixed_deposits cf
			WHERE cf.cbs_customer_id = '' OR NOT EXISTS (
			    SELECT 1 FROM fd_transactions fd WHERE fd.cif_number = cf.cbs_customer_id)
			ORDER BY principal_kobo DESC`)

		cbsWriteJSON(w, http.StatusOK, map[string]any{
			"loans":           firstRow(loanStats),
			"fixed_deposits":  firstRow(fdStats),
			"unmatched_loans": unmatchedLoans,
			"unmatched_fds":   unmatchedFDs,
		})
	}
}

// queryRows runs a read query and returns the rows (empty slice on error).
func queryRows(ctx context.Context, db *core.DB, q string, args ...any) []core.Row {
	rows, err := db.PGQuery(ctx, q, args...)
	if err != nil {
		slog.Error("cbs report query failed", "err", err)
		return []core.Row{}
	}
	return rows
}

func firstRow(rows []core.Row) core.Row {
	if len(rows) == 0 {
		return core.Row{}
	}
	return rows[0]
}

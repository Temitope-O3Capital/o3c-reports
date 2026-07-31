package handlers

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/cbssync"
	"github.com/o3c/reports/core"
)

// RegisterCBSReports mounts read-only reporting endpoints over the CBS snapshot
// tables (populated by the sync worker). All amounts are in kobo. Mounted under
// /api/cbs, so already behind AuthMiddleware. Customer names are resolved from the
// Sage customer master ("Accounts") by CIF (Udara's cbs_customer_id == "CIF Number").
func RegisterCBSReports(r chi.Router, db *core.DB) {
	r.Get("/reports/loan-book", cbsLoanBook(db))
	r.Get("/reports/fd-book", cbsFDBook(db))
	r.Get("/reports/reconciliation", cbsReconciliation(db))
}

// custName returns a SELECT expression for the customer name: from the Sage master
// by CIF when available, otherwise the name embedded in the CBS record.
func custName(master bool, alias string) string {
	if master {
		return `COALESCE((SELECT NULLIF(trim(a."First Name"||' '||COALESCE(a."Last Name",'')),'')
		         FROM "Accounts" a WHERE a."CIF Number" = ` + alias + `.cbs_customer_id LIMIT 1),
		         ` + alias + `.raw->>'name') AS customer_name`
	}
	return alias + `.raw->>'name' AS customer_name`
}

// cbsLoanBook returns the credit book: totals, breakdowns by status/product, and the loan list.
func cbsLoanBook(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		master := cbssync.CustomerMasterExists(ctx, db)
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
			SELECT cl.cbs_account_number, cl.cbs_customer_id, `+custName(master, "cl")+`,
			       cl.product_name, cl.status, cl.loan_amount_kobo, cl.outstanding_principal_kobo,
			       cl.outstanding_interest_kobo, cl.interest_rate, cl.tenor_days,
			       cl.start_date, cl.maturity_date, cl.officer_name
			FROM cbs_loans cl ORDER BY cl.outstanding_principal_kobo DESC`)

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
		master := cbssync.CustomerMasterExists(ctx, db)
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
			SELECT cf.cbs_account_number, cf.cbs_customer_id, `+custName(master, "cf")+`,
			       cf.product_name, cf.status, cf.principal_kobo, cf.accrued_interest_kobo,
			       cf.ledger_balance_kobo, cf.interest_rate, cf.tenor_days,
			       cf.commencement_date, cf.maturity_date
			FROM cbs_fixed_deposits cf ORDER BY cf.principal_kobo DESC`)

		cbsWriteJSON(w, http.StatusOK, map[string]any{
			"summary":         firstRow(summary),
			"by_status":       byStatus,
			"by_product":      byProduct,
			"maturity_ladder": ladder,
			"fixed_deposits":  fds,
		})
	}
}

// cbsReconciliation reports how many CBS accounts belong to a known customer (CIF in
// the Sage master) versus Udara-only customers, and lists the unmatched accounts.
func cbsReconciliation(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		master := cbssync.CustomerMasterExists(ctx, db)

		// matched predicate differs by whether the customer master is available.
		matchedLoan := "false"
		matchedFD := "false"
		if master {
			matchedLoan = `cbs_customer_id <> '' AND EXISTS (SELECT 1 FROM "Accounts" a WHERE a."CIF Number" = cbs_loans.cbs_customer_id)`
			matchedFD = `cbs_customer_id <> '' AND EXISTS (SELECT 1 FROM "Accounts" a WHERE a."CIF Number" = cbs_fixed_deposits.cbs_customer_id)`
		}

		loanStats := queryRows(ctx, db, `
			SELECT count(*)::bigint AS cbs_total,
			       (count(*) FILTER (WHERE `+matchedLoan+`))::bigint AS matched
			FROM cbs_loans`)
		fdStats := queryRows(ctx, db, `
			SELECT count(*)::bigint AS cbs_total,
			       (count(*) FILTER (WHERE `+matchedFD+`))::bigint AS matched
			FROM cbs_fixed_deposits`)

		unmatchedLoanWhere := "true"
		unmatchedFDWhere := "true"
		if master {
			unmatchedLoanWhere = `cl.cbs_customer_id = '' OR NOT EXISTS (SELECT 1 FROM "Accounts" a WHERE a."CIF Number" = cl.cbs_customer_id)`
			unmatchedFDWhere = `cf.cbs_customer_id = '' OR NOT EXISTS (SELECT 1 FROM "Accounts" a WHERE a."CIF Number" = cf.cbs_customer_id)`
		}
		unmatchedLoans := queryRows(ctx, db, `
			SELECT cl.cbs_account_number, cl.cbs_customer_id, cl.raw->>'name' AS customer_name,
			       cl.product_name, cl.status, cl.outstanding_principal_kobo
			FROM cbs_loans cl WHERE `+unmatchedLoanWhere+`
			ORDER BY cl.outstanding_principal_kobo DESC`)
		unmatchedFDs := queryRows(ctx, db, `
			SELECT cf.cbs_account_number, cf.cbs_customer_id, cf.raw->>'name' AS customer_name,
			       cf.product_name, cf.status, cf.principal_kobo
			FROM cbs_fixed_deposits cf WHERE `+unmatchedFDWhere+`
			ORDER BY cf.principal_kobo DESC`)

		cbsWriteJSON(w, http.StatusOK, map[string]any{
			"customer_master_available": master,
			"loans":                     firstRow(loanStats),
			"fixed_deposits":            firstRow(fdStats),
			"unmatched_loans":           unmatchedLoans,
			"unmatched_fds":             unmatchedFDs,
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

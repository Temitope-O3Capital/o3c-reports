package handlers

import (
	"context"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/cbssync"
	"github.com/o3c/workspace/core"
)

// RegisterCBSReports mounts read-only reporting endpoints over the CBS snapshot
// tables (populated by the sync worker). All amounts are in kobo. Mounted under
// /api/cbs, so already behind AuthMiddleware. Customer names are resolved from the
// customer master (app.customers) by CIF (Udara's cbs_customer_id == cif).
func RegisterCBSReports(r chi.Router, db *core.DB) {
	// These routes had no page guard at all. Being under /api/cbs put them behind
	// AuthMiddleware, which only proves the caller is signed in — so any
	// authenticated account, including a call-centre agent, could pull the entire
	// credit and fixed-deposit book with customer names attached.
	//
	// Gated on the same pages that already govern the loan and FD books elsewhere
	// in the workspace, so this restores the intended boundary rather than
	// inventing a new one.
	read := core.RequirePages("credit_portfolio", "active_loan_book", "loans",
		"fixed_deposit", "reports", "executive")

	r.With(read).Get("/reports/loan-book", cbsLoanBook(db))
	r.With(read).Get("/reports/fd-book", cbsFDBook(db))
	r.With(read).Get("/reports/reconciliation", cbsReconciliation(db))
	r.With(read).Get("/reports/customers", cbsCustomers(db))
	r.With(read).Get("/reports/customer/{cif}", cbsCustomerDetail(db))
}

// custName returns a SELECT expression for the customer name — Udara's OWN name
// (raw->>'name'). It must NOT be resolved via app.customers by cbs_customer_id: Udara's
// cbs_customer_id and the Sage/feed app.customers.cif are DIFFERENT id namespaces, so the
// old master-join showed the wrong customer on every colliding CIF (verified 2026-09-08:
// 42 of 42 CIF "matches" were the wrong person — e.g. Udara CIF 00000424 = FINTRAK but
// Sage CIF 00000424 = an unrelated individual). Udara is the system of record for the
// booked loan/FD, so its embedded name is authoritative.
func custName(master bool, alias string) string {
	_ = master // signature kept for callers; the master (CIF) join is invalid here.
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
			       cl.date_booked, cl.start_date, cl.maturity_date, cl.officer_name
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
			       cf.date_booked, cf.commencement_date, cf.maturity_date
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

		// "matched" = the CBS customer has been folded into the canonical party layer via
		// the curated cbs_links crosswalk (migration 210). This replaces the old
		// cbs_customer_id == app.customers.cif test, which was an invalid cross-namespace
		// join (Udara ids and Sage CIFs collide) and produced meaningless match counts.
		matchedLoan := `EXISTS (SELECT 1 FROM app.cbs_links l WHERE l.cbs_customer_id = cbs_loans.cbs_customer_id)`
		matchedFD := `EXISTS (SELECT 1 FROM app.cbs_links l WHERE l.cbs_customer_id = cbs_fixed_deposits.cbs_customer_id)`

		loanStats := queryRows(ctx, db, `
			SELECT count(*)::bigint AS cbs_total,
			       (count(*) FILTER (WHERE `+matchedLoan+`))::bigint AS matched
			FROM cbs_loans`)
		fdStats := queryRows(ctx, db, `
			SELECT count(*)::bigint AS cbs_total,
			       (count(*) FILTER (WHERE `+matchedFD+`))::bigint AS matched
			FROM cbs_fixed_deposits`)

		unmatchedLoanWhere := `cl.cbs_customer_id = '' OR NOT EXISTS (SELECT 1 FROM app.cbs_links l WHERE l.cbs_customer_id = cl.cbs_customer_id)`
		unmatchedFDWhere := `cf.cbs_customer_id = '' OR NOT EXISTS (SELECT 1 FROM app.cbs_links l WHERE l.cbs_customer_id = cf.cbs_customer_id)`
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

// cbsCustomers lists the Udara customer master (cbs_customers) with each customer's
// workspace-linkage status: whether they resolve to a workspace party (via cbs_links),
// their CUST id, card count, and how many loans/FDs they hold. This is the audit view
// for "does every Udara customer have a workspace profile, and are cards matched?".
func cbsCustomers(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		rows := queryRows(ctx, db, `
			SELECT cc.cbs_customer_id, cc.customer_type, cc.name, cc.phone, cc.email,
			       cc.state, cc.bvn, cc.date_of_birth,
			       (l.entity_id IS NOT NULL)                                          AS in_workspace,
			       CASE WHEN l.entity_id IS NOT NULL
			            THEN 'CUST-' || LPAD(l.entity_id::text, 6, '0') END           AS cust_id,
			       COALESCE(p.card_count, 0)::bigint                                  AS card_count,
			       (SELECT count(*) FROM cbs_loans x          WHERE x.cbs_customer_id = cc.cbs_customer_id)::bigint AS loan_count,
			       (SELECT count(*) FROM cbs_fixed_deposits x WHERE x.cbs_customer_id = cc.cbs_customer_id)::bigint AS fd_count
			FROM cbs_customers cc
			LEFT JOIN app.cbs_links l ON l.cbs_customer_id = cc.cbs_customer_id AND l.entity_type = 'party'
			LEFT JOIN app.parties  p ON p.party_id = l.entity_id
			ORDER BY cc.name`)
		summary := firstRow(queryRows(ctx, db, `
			SELECT count(*)::bigint AS total,
			       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM app.cbs_links l WHERE l.cbs_customer_id = cc.cbs_customer_id))::bigint AS linked,
			       count(*) FILTER (WHERE COALESCE(btrim(cc.phone),'') <> '')::bigint AS with_phone,
			       count(*) FILTER (WHERE COALESCE(btrim(cc.email),'') <> '')::bigint AS with_email
			FROM cbs_customers cc`))
		cbsWriteJSON(w, http.StatusOK, map[string]any{"summary": summary, "customers": rows})
	}
}

// cbsCustomerDetail returns one Udara customer: the full Udara-side profile (cbs_customers)
// plus the matched workspace side (party CUST id, contact, card count) and the customer's
// loans and fixed deposits. Powers the row-click detail modal.
func cbsCustomerDetail(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		cif := strings.TrimSpace(chi.URLParam(r, "cif"))
		if cif == "" {
			cbsWriteJSON(w, http.StatusBadRequest, map[string]any{"error": "cif required"})
			return
		}
		cbs := firstRow(queryRows(ctx, db, `SELECT * FROM cbs_customers WHERE cbs_customer_id = $1`, cif))
		ws := firstRow(queryRows(ctx, db, `
			SELECT 'CUST-' || LPAD(p.party_id::text, 6, '0') AS cust_id, p.party_id,
			       p.full_name AS party_name, p.party_type,
			       p.primary_phone, p.primary_email, p.bvn AS party_bvn,
			       COALESCE(p.card_count, 0)::bigint AS card_count
			FROM app.cbs_links l
			JOIN app.parties p ON p.party_id = l.entity_id AND l.entity_type = 'party'
			WHERE l.cbs_customer_id = $1
			LIMIT 1`, cif))
		loans := queryRows(ctx, db, `
			SELECT cbs_account_number, product_name, status, outstanding_principal_kobo,
			       loan_amount_kobo, maturity_date, officer_name
			FROM cbs_loans WHERE cbs_customer_id = $1 ORDER BY outstanding_principal_kobo DESC`, cif)
		fds := queryRows(ctx, db, `
			SELECT cbs_account_number, product_name, status, principal_kobo,
			       accrued_interest_kobo, maturity_date
			FROM cbs_fixed_deposits WHERE cbs_customer_id = $1 ORDER BY principal_kobo DESC`, cif)
		cbsWriteJSON(w, http.StatusOK, map[string]any{
			"cbs":            cbs,
			"workspace":      ws,
			"in_workspace":   len(ws) > 0,
			"loans":          loans,
			"fixed_deposits": fds,
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
	// Never return a nil slice: pgx yields nil for a zero-row result, which marshals
	// to JSON `null` and makes callers doing `.length` on the array throw. An empty
	// result must serialise as `[]`.
	if rows == nil {
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

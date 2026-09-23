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

// cbsOfficerUserID resolves the account officer for a Udara record, as a correlated
// scalar subquery so it can never add or drop a row.
//
// It reads app.v_loan_officer / app.v_fd_officer (migration 284) rather than
// app.cbs_officer_map directly, so a workspace OVERRIDE is honoured here too. A name
// crosswalk on its own cannot be corrected — repointing a name moves every one of
// that officer's records — and Udara's API has no endpoint that can change an
// account officer, so the override is the only way a wrong one gets fixed. Reading
// the map here while every other surface reads the view would mean this report kept
// showing the uncorrected officer.
//
// btrim still matters and now lives inside the view: 7 of the 21 map rows carry a
// TRAILING SPACE because Udara sends them that way and the map was hand-seeded from
// those exact strings. Trimming only ONE side is silent data loss — on the deposit
// book it matches 207 of 380 rows instead of 380, dropping about 11.03bn naira of
// principal out of officer attribution without raising any error.
//
// kind is "loan" or "fd"; idExpr is the record's cbs_id on the outer query.
func cbsOfficerUserID(kind, idExpr string) string {
	view := "app.v_fd_officer"
	if kind == "loan" {
		view = "app.v_loan_officer"
	}
	return `(SELECT m.officer_user_id FROM ` + view + ` m
		        WHERE m.cbs_id = ` + idExpr + `) AS officer_user_id`
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
			       cl.date_booked, cl.start_date, cl.maturity_date, cl.officer_name,
			       `+cbsOfficerUserID("loan", "cl.cbs_id")+`,
			       -- Restructure lineage (migration 277). A facility whose account number is
			       -- the previous one's suffix + 1, for the SAME customer, with the prior
			       -- Closed, is that debt on new terms — not new lending. Without this the
			       -- page presents FOLTI's N156,000,000 as a fresh facility when it is a
			       -- N250,000,000 loan re-papered.
			       (r.successor_account IS NOT NULL) AS is_restructure,
			       r.prior_account,
			       r.prior_amount_kobo,
			       COALESCE(r.new_lending_kobo, cl.loan_amount_kobo) AS new_lending_kobo,
			       -- What has actually been PAID on this loan, from the GL call-over
			       -- ledger. Every other reader of app.loan_repayments joins on
			       -- application_id or loan_id, and a Udara loan has neither — so these
			       -- postings were captured and displayed nowhere at all. The link the
			       -- capture really writes is cbs_loan_account, so that is what is used.
			       COALESCE(rp.principal_kobo, 0) AS repaid_principal_kobo,
			       COALESCE(rp.interest_kobo, 0)  AS repaid_interest_kobo,
			       COALESCE(rp.legs, 0)           AS repayment_legs,
			       rp.last_repaid_on
			FROM cbs_loans cl
			LEFT JOIN app.loan_restructure_links r ON r.successor_account = cl.cbs_account_number
			LEFT JOIN LATERAL (
			    SELECT SUM(lr.principal_kobo) AS principal_kobo,
			           SUM(lr.interest_kobo)  AS interest_kobo,
			           COUNT(*)               AS legs,
			           MAX(lr.financial_date) AS last_repaid_on
			    FROM app.loan_repayments lr
			    WHERE lr.cbs_loan_account = cl.cbs_account_number
			      AND lr.ledger_key IS NOT NULL
			) rp ON TRUE
			ORDER BY cl.outstanding_principal_kobo DESC`)

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
			       cf.date_booked, cf.commencement_date, cf.maturity_date,
			       cf.officer_name, `+cbsOfficerUserID("fd", "cf.cbs_id")+`,
			       -- Rollover lineage (migration 276). A deposit that commenced as another
			       -- matured, same customer, prior now Closed, is the same money rolling —
			       -- 60 of the active deposits are, carrying N5.27bn. Counting their
			       -- principal as fresh inflow books the same money twice.
			       (l.successor_account IS NOT NULL) AS is_rollover,
			       l.prior_account,
			       l.prior_matures,
			       l.prior_aged_out,
			       -- Deposits whose lineage could NOT be drawn. Where one matured deposit
			       -- commenced several, or several fed one, there is no 1:1 chain, and
			       -- app.compute_fd_rollover_links() deliberately records the fact rather
			       -- than picking a pairing. Until now it recorded it into a table nothing
			       -- read — so the rollover figure was quietly understated with no sign
			       -- that anything was missing. Surfaced here so the gap is visible and a
			       -- person can settle these by hand.
			       (SELECT a.reason FROM app.fd_rollover_ambiguous a
			         WHERE a.successor_account = cf.cbs_account_number
			            OR a.prior_account     = cf.cbs_account_number
			         LIMIT 1) AS lineage_ambiguous_reason
			FROM cbs_fixed_deposits cf
			LEFT JOIN app.fd_rollover_links l ON l.successor_account = cf.cbs_account_number
			ORDER BY cf.principal_kobo DESC`)

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
			       -- app.parties.card_count is NOT a count of cards. assign_parties() sets
			       -- it to the number of app.customers ROWS in the party, so a borrower
			       -- with one customer record and no card at all reads "Cards Held 1" —
			       -- which is what PAUBEE GLOBAL VENTURE showed while Collections
			       -- correctly said they hold none. 1,409 parties disagree with their real
			       -- card count this way. Counted here from app.accounts, which is the
			       -- actual card book, and the customer-record count is returned
			       -- separately under its own honest name.
			       COALESCE(p.card_count, 0)::bigint AS customer_record_count,
			       (SELECT COUNT(*) FROM app.accounts a
			          JOIN app.customers c ON c.cif = a.cif
			         WHERE c.party_id = p.party_id)::bigint AS card_count
			FROM app.cbs_links l
			JOIN app.parties p ON p.party_id = l.entity_id AND l.entity_type = 'party'
			WHERE l.cbs_customer_id = $1
			LIMIT 1`, cif))
		// Lineage is carried on the per-customer lists too: this modal is where someone
		// looks at one borrower's facilities, and it is exactly where "why does this
		// customer have two loans?" gets asked. Migrations 276/277.
		loans := queryRows(ctx, db, `
			SELECT cl.cbs_account_number, cl.product_name, cl.status, cl.outstanding_principal_kobo,
			       cl.loan_amount_kobo, cl.maturity_date, cl.officer_name,
			       (r.successor_account IS NOT NULL) AS is_restructure,
			       r.prior_account, r.prior_amount_kobo, r.new_lending_kobo,
			       (EXISTS (SELECT 1 FROM app.loan_restructure_links x
			                 WHERE x.prior_account = cl.cbs_account_number)) AS was_restructured_into
			FROM cbs_loans cl
			LEFT JOIN app.loan_restructure_links r ON r.successor_account = cl.cbs_account_number
			WHERE cl.cbs_customer_id = $1 ORDER BY cl.outstanding_principal_kobo DESC`, cif)
		fds := queryRows(ctx, db, `
			SELECT cf.cbs_account_number, cf.product_name, cf.status, cf.principal_kobo,
			       cf.accrued_interest_kobo, cf.maturity_date, cf.officer_name,
			       (l.successor_account IS NOT NULL) AS is_rollover,
			       l.prior_account, l.prior_matures,
			       (EXISTS (SELECT 1 FROM app.fd_rollover_links x
			                 WHERE x.prior_account = cf.cbs_account_number)) AS was_rolled_into,
			       (SELECT a.reason FROM app.fd_rollover_ambiguous a
			         WHERE a.successor_account = cf.cbs_account_number
			            OR a.prior_account     = cf.cbs_account_number
			         LIMIT 1) AS lineage_ambiguous_reason
			FROM cbs_fixed_deposits cf
			LEFT JOIN app.fd_rollover_links l ON l.successor_account = cf.cbs_account_number
			WHERE cf.cbs_customer_id = $1 ORDER BY cf.principal_kobo DESC`, cif)
		// What this borrower has actually PAID, from the GL call-over ledger
		// (cbssync/repayments.go). These rows carry no application_id and no loan_id —
		// a Udara loan is not a workspace loan application — so every existing reader of
		// app.loan_repayments, which joins on one or the other, silently drops them. The
		// money was being captured and shown nowhere: 41 legs, N645,900,821.65 across 16
		// borrowers, including N268,720,000 from FOLTI TECHNOLOGIES.
		//
		// Joined through cbs_loan_account -> cbs_loans, which is the link the capture
		// actually writes, and scoped to this customer's own loans.
		repayments := queryRows(ctx, db, `
			SELECT lr.financial_date, lr.posted_at, lr.cbs_loan_account,
			       lr.entry_code, lr.component,
			       lr.amount_kobo, lr.principal_kobo, lr.interest_kobo,
			       lr.posting_reference,
			       cl.product_name
			FROM app.loan_repayments lr
			JOIN cbs_loans cl ON cl.cbs_account_number = lr.cbs_loan_account
			WHERE cl.cbs_customer_id = $1 AND lr.ledger_key IS NOT NULL
			ORDER BY lr.financial_date DESC, lr.posted_at DESC`, cif)

		cbsWriteJSON(w, http.StatusOK, map[string]any{
			"cbs":            cbs,
			"workspace":      ws,
			"in_workspace":   len(ws) > 0,
			"loans":          loans,
			"fixed_deposits": fds,
			"repayments":     repayments,
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

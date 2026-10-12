package handlers

import (
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

func RegisterReports(r chi.Router, db *core.DB) {
	read := core.RequirePages("reports")
	audit := core.RequirePages("audit_export")

	r.With(read).Get("/list", reportsList(db))
	r.With(read).Get("/monthly-business", reportMonthlyBusiness(db))
	r.With(read).Get("/loan-portfolio", reportLoanPortfolio(db))
	r.With(read).Get("/collections-performance", reportCollectionsPerformance(db))
	r.With(read).Get("/settlement-recon", reportSettlementRecon(db))
	r.With(read).Get("/agent-performance", reportAgentPerformance(db))
	r.With(read).Get("/customer-statement", reportCustomerStatement(db))
	r.With(read).Post("/customer-statement/send", sendCustomerStatementEmail(db))
	r.With(read).Get("/customer-statement/emails", listStatementEmails(db))
	r.With(read).Get("/npl-return", reportNPLReturn(db))
	r.With(read).Get("/sales-pipeline", reportSalesPipeline(db))
	r.With(audit).Get("/audit-trail-export", reportAuditTrailExport(db))
	// The KPI Tracker is a dashboard, not an extract, and every operational head
	// holds kpi_dashboard. Narrowing "reports" to the BI team would otherwise have
	// let them open the page and then 403 on both of its calls — the same
	// route-guard-vs-API-guard mismatch that made the Risk page unusable.
	kpi := core.RequirePages("kpi_dashboard", "reports")
	r.With(kpi).Get("/kpis", reportKPIsHandler(db))
	r.With(kpi).Get("/kpi-history", reportKPIHistoryHandler(db))

	// The centralised export engine: dataset registry, preview and download.
	// Every file the workspace emits comes from here — see handlers/exports.go.
	RegisterExports(r, db)

	// Saved + scheduled pivot reports for the drag-and-drop Report Builder —
	// see handlers/reports_saved.go (persistence, on-demand email, schedules).
	RegisterSavedReports(r, db)

	// Rollup health and manual triggers — the reporting layer's own plumbing.
	RegisterReportingRollups(r, db)

	// Cards, revenue, acquisition, service and deposits — see reports_business.go.
	registerBusinessReports(r, db, read)

	// Legacy export log path, kept so an old tab does not 404 mid-session.
	// The engine's own log is GET /api/reports/exports/log.
	r.With(read).Get("/export-log", exportLog(db))
}

// reportsList is the library catalogue the Report Library page renders.
//
// IT FILTERS BY WHAT THE CALLER CAN ACTUALLY RUN. The list is guarded on "reports" while
// the Audit Trail is guarded on "audit_export", and those two grants are DISJOINT:
// core/auth.go gives audit_export to the compliance head and reports to the BI team and
// admins. So the catalogue advertised a report to an audience that would get a 403 on
// opening it, and hid it from the one person who could. That is the same
// route-guard-versus-API-guard mismatch the KPI tracker comment below describes, and the
// fix is the same — ask the guard, do not restate it.
//
// `needs` names any parameter a report cannot run without, so the page can ask for it
// instead of firing a request that must fail. Only the customer statement has one.
func reportsList(db *core.DB) http.HandlerFunc {
	type libReport struct {
		Key, Group, Name, Desc string
		// Pages the caller must hold, or empty for "the list's own guard is enough".
		// Mirrors what RequirePages on the route will decide, so the two cannot drift
		// without this list hiding a report that works, which is visible, rather than
		// offering one that 403s, which is not.
		Pages []string
		Needs []string
		// Undated marks a report that reads no date parameter at all, so the page can
		// stop offering a date filter that does nothing.
		//
		// Checked against the handlers rather than assumed: reportCardPortfolio and
		// reportFDBook contain ZERO references to date_from, date_to or any BETWEEN —
		// they are point-in-time views of the book, which is the right design for a
		// portfolio snapshot. Every other report in the library reads date_from and
		// date_to, either directly or through periodDefaults.
		//
		// Offering a picker that changes nothing is the exact defect this module was
		// criticised for elsewhere: sales/Reports.tsx hardcodes days=30 beside a date
		// filter and ANDs them, so choosing "This Year" still returns thirty days. A
		// control that lies about what it does is worse than an absent one.
		Undated bool
	}
	// Ordered by product line, so the library reads the way the business is organised
	// rather than the order the handlers happened to be written.
	all := []libReport{
		// Revenue
		{Key: "income", Group: "Revenue", Name: "Income & Revenue Report",
			Desc: "Fee, interest and penalty income by category, product and month, off the card book"},
		// Cards
		{Key: "card-portfolio", Group: "Cards", Name: "Card Portfolio Report",
			Desc: "Accounts by status and product, limits, balances, utilisation bands and delinquency", Undated: true},
		// Customers
		{Key: "customer-acquisition", Group: "Customers", Name: "Customer Acquisition Report",
			Desc: "New customers by month, first product and state, counted by first account opened"},
		// Sales
		{Key: "sales-pipeline", Group: "Sales", Name: "Sales Pipeline & Attribution Report",
			Desc: "Campaign → call-centre → sales funnel: leads by source and stage, forwards, conversion, and per-officer attribution"},
		// Credit
		{Key: "loan-portfolio", Group: "Credit", Name: "Loan Portfolio Report",
			Desc: "All loans: status, amounts, tenor, interest rate distribution, top 10 by outstanding"},
		{Key: "npl-return", Group: "Credit", Name: "CBN NPL Return",
			Desc: "Loans by DPD bucket, NPL ratio, CBN prudential provisions, write-offs"},
		{Key: "monthly-business", Group: "Credit", Name: "Monthly Business Report",
			Desc: "New accounts, loans booked, repayments received, collections and recovery — grouped by product"},
		// Deposits
		{Key: "fd-book", Group: "Fixed Deposits", Name: "Fixed Deposit Book",
			Desc: "Deposit book by status and product, with the maturity ladder treasury needs", Undated: true},
		// Collections
		{Key: "collections-performance", Group: "Collections", Name: "Collections Performance Report",
			Desc: "Agent contact attempts, PTP count, kept rate, amount vs target by agent and DPD bucket"},
		{Key: "agent-performance", Group: "Collections", Name: "Agent Performance Report",
			Desc: "Daily KPI summary per agent: contacts, PTPs, collected, target achievement"},
		// Service
		{Key: "service-performance", Group: "Service", Name: "Service Performance Report",
			Desc: "Tickets by channel, status and agent; SLA breaches, CSAT and call volumes"},
		// Operations
		{Key: "settlement-recon", Group: "Operations", Name: "Settlement Reconciliation Report",
			Desc: "Loans booked against repayments received, with open exposure taken from the book"},
		{Key: "customer-statement", Group: "Operations", Name: "Customer Statement",
			Desc:  "Account details and transaction history for one customer",
			Needs: []string{"cif"}},
		{Key: "audit-trail-export", Group: "Compliance", Name: "Audit Trail",
			Desc:  "Paginated full audit trail",
			Pages: []string{"audit_export"}},
	}

	return func(w http.ResponseWriter, r *http.Request) {
		u := core.UserFromCtx(r.Context())
		reports := make([]map[string]any, 0, len(all))
		for _, rep := range all {
			if !libReportAllowed(u, rep.Pages) {
				continue
			}
			row := map[string]any{
				"key": rep.Key, "group": rep.Group,
				"name": rep.Name, "description": rep.Desc,
			}
			if len(rep.Needs) > 0 {
				row["needs"] = rep.Needs
			}
			// Emitted always, so the page never has to infer it from a missing key.
			row["dated"] = !rep.Undated
			reports = append(reports, row)
		}
		respond(w, reports, "static")
	}
}

// libReportAllowed mirrors RequirePages: management passes, otherwise the caller must
// hold one of the named pages. An empty list means the list's own guard already settled
// it.
func libReportAllowed(u *core.Claims, pages []string) bool {
	if len(pages) == 0 {
		return true
	}
	if u == nil {
		return false
	}
	if core.IsManagement(u.Role) {
		return true
	}
	for _, p := range pages {
		if u.HasPage(p) {
			return true
		}
	}
	return false
}

// reportMonthlyBusiness returns monthly business summary, optionally filtered by date range.
func reportMonthlyBusiness(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dateFrom, err := validDate(r, "date_from")
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		dateTo, err := validDate(r, "date_to")
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}

		// Default to current month if no range provided
		if dateFrom == "" {
			dateFrom = time.Now().UTC().Format("2006-01") + "-01"
		}
		if dateTo == "" {
			dateTo = time.Now().UTC().Format("2006-01-02")
		}

		ctx := r.Context()

		// New accounts (from MSSQL or PG)
		newAccounts, src1, _ := db.DualQuery(ctx,
			fmt.Sprintf(`SELECT product_name AS product_type, COUNT(DISTINCT cif) AS new_accounts
			 FROM app.accounts
			 WHERE opened_date::date BETWEEN $1 AND $2
			 GROUP BY product_name ORDER BY new_accounts DESC`),
			dateFrom, dateTo)

		// ── WHAT THIS SECTION USED TO READ, AND WHY IT WAS ALWAYS EMPTY ──────────
		//
		// Measured 2026-10-07:
		//
		//   * Disbursements came from app.loan_applications — 8 rows in total, every
		//     amount_approved_kobo NULL, and 0 rows carrying booked_at. The live book is
		//     app.cbs_loans, which Udara publishes.
		//   * total_collections summed "Collections Log". That relation exists in NO
		//     schema. DualQuery turns a missing relation into an empty result with a nil
		//     error, by design, so a half-built module shows a clean empty state — and
		//     the error was discarded here anyway. The figure was silently null.
		//   * total_recoveries summed app."Recovery Master Sheet". That one does exist
		//     and holds 0 rows: a legacy import table nothing writes to any more.
		//
		// Three figures on a management report, none of which could ever be anything
		// but empty, and not one of them reporting a fault.

		// Booked in the window, from the real loan book.
		disbRows, _ := db.PGQuery(ctx,
			`SELECT COALESCE(NULLIF(btrim(cl.product_name), ''), 'Unclassified') AS product_type,
			        COUNT(*)                                AS loans_booked,
			        COALESCE(SUM(cl.loan_amount_kobo), 0)   AS total_disbursed_kobo
			 FROM cbs_loans cl
			 WHERE cl.date_booked BETWEEN $1 AND $2
			 GROUP BY 1 ORDER BY total_disbursed_kobo DESC`,
			dateFrom, dateTo)

		disbKPI, _ := db.PGQuery(ctx,
			`SELECT COUNT(*)                              AS loans_booked,
			        COALESCE(SUM(cl.loan_amount_kobo), 0) AS total_disbursed_kobo
			 FROM cbs_loans cl
			 WHERE cl.date_booked BETWEEN $1 AND $2`,
			dateFrom, dateTo)

		// TWO COLLECTIONS FIGURES, NEVER ONE.
		//
		// These are different books that overlap, and the management reports already
		// state the rule in as many words: "Three sources, side by side. They overlap,
		// so they are never added together." A single "total_collections" invited
		// exactly that addition, so it is replaced by two named figures.
		//
		// Loan repayments are the GL capture, keyed on cbs_loan_account and dated by
		// financial_date (Udara's value date), so a leg posted late still counts on the
		// day it is dated. It has no history before 2026-07-01.
		loanRepaid, _ := db.PGQuery(ctx,
			`SELECT COUNT(*)                            AS legs,
			        COALESCE(SUM(rp.amount_kobo), 0)    AS amount_kobo
			 FROM loan_repayments rp
			 WHERE rp.financial_date BETWEEN $1 AND $2`,
			dateFrom, dateTo)

		// The collections team's own book. APPROVED ONLY: 11 rows sitting at
		// 'pending_hop' carry NGN 106,393,555.56 between them, and counting money that
		// nobody has approved as collected is how a collections figure stops being
		// trustworthy.
		collPaid, _ := db.PGQuery(ctx,
			`SELECT COUNT(*)                            AS payments,
			        COALESCE(SUM(cp.amount_kobo), 0)    AS amount_kobo
			 FROM collection_payments cp
			 WHERE cp.payment_date BETWEEN $1 AND $2
			   AND cp.status = 'approved'`,
			dateFrom, dateTo)

		// Recovery is reported as STOCK, not as movement in the window. 1,585 of the
		// 1,617 cases were opened in a single week of August by bulk import, and there
		// is no recovered_at column to window on — only opened_at and closed_at — so a
		// windowed recovery figure would read as a cliff after that week. This follows
		// the convention the management reports already use for the same reason.
		recovStock, _ := db.PGQuery(ctx,
			`SELECT COUNT(*)                                            AS cases,
			        COUNT(*) FILTER (WHERE status = 'active')           AS active_cases,
			        COUNT(*) FILTER (WHERE status = 'legal')            AS legal_cases,
			        COALESCE(SUM(rc.recovered_kobo), 0)                 AS recovered_to_date_kobo,
			        COALESCE(SUM(rc.outstanding_kobo)
			                 FILTER (WHERE status IN ('active','legal')), 0) AS outstanding_kobo
			 FROM recovery_cases rc`)

		// Active loans and NPL count from snapshot
		nplRows, _ := db.PGQuery(ctx,
			`SELECT total_loans, total_npls_kobo, total_outstanding_kobo, npl_ratio_bps FROM (`+cbsSnapshotLiveSQL+`) s`)

		result := map[string]any{
			"date_from":     dateFrom,
			"date_to":       dateTo,
			"new_accounts":  newAccounts,
			"disbursements": disbRows,
			// Named so neither can be mistaken for "all collections".
			"loan_repayments":          firstRowOrEmpty(loanRepaid),
			"collections_payments":     firstRowOrEmpty(collPaid),
			"repayments_captured_from": "2026-07-01",
		}
		if len(recovStock) > 0 {
			result["recovery"] = recovStock[0]
		}
		if len(disbKPI) > 0 {
			result["disbursements_total"] = disbKPI[0]
		}
		if len(nplRows) > 0 {
			result["portfolio_snapshot"] = nplRows[0]
		}

		respond(w, result, pickSource([]string{src1}))
	}
}

// reportLoanPortfolio returns all loan applications with status breakdown and distribution.
func reportLoanPortfolio(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dateFrom, err := validDate(r, "date_from")
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		dateTo, err := validDate(r, "date_to")
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}

		ctx := r.Context()
		n := 1
		where := "WHERE 1=1"
		args := []any{}
		if dateFrom != "" {
			where += fmt.Sprintf(" AND created_at::date >= $%d", n)
			args = append(args, dateFrom)
			n++
		}
		if dateTo != "" {
			where += fmt.Sprintf(" AND created_at::date <= $%d", n)
			args = append(args, dateTo)
			n++
		}

		// Status breakdown
		statusRows, err := db.PGQuery(ctx,
			fmt.Sprintf(`SELECT status, COUNT(*) AS count,
			        COALESCE(SUM(amount_approved_kobo),0) AS total_kobo
			 FROM loan_applications %s GROUP BY status ORDER BY count DESC`, where),
			args...)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}

		// By product type
		productRows, _ := db.PGQuery(ctx,
			fmt.Sprintf(`SELECT product_type, COUNT(*) AS count,
			        COALESCE(AVG(tenor_months),0) AS avg_tenor_months,
			        COALESCE(SUM(amount_approved_kobo),0) AS total_approved_kobo
			 FROM loan_applications %s GROUP BY product_type ORDER BY total_approved_kobo DESC`, where),
			args...)

		// Top 10 by outstanding, live off the CBS book.
		//
		// Previously read loan_dpd_daily_snapshot, which is empty — so the
		// concentration table on a loan portfolio report was always blank.
		top10Rows, _ := db.PGQuery(ctx, `
			SELECT cl.cbs_customer_id AS cif_number,
			       cl.cbs_account_number,
			       cl.product_name,
			       cl.status,
			       cl.outstanding_principal_kobo AS outstanding_kobo,
			       `+cbsLoanDPD+` AS dpd,
			       `+cbsLoanBand+` AS risk_band
			FROM cbs_loans cl
			WHERE cl.status NOT IN ('Closed','Revoked')
			ORDER BY cl.outstanding_principal_kobo DESC LIMIT 10`)

		result := map[string]any{
			"status_breakdown":  statusRows,
			"by_product_type":   productRows,
			"top10_outstanding": top10Rows,
		}
		respond(w, result, "pg")
	}
}

// reportCollectionsPerformance returns contact/PTP/amount data by agent and DPD bucket.
func reportCollectionsPerformance(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dateFrom, err := validDate(r, "date_from")
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		dateTo, err := validDate(r, "date_to")
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		if dateFrom == "" {
			dateFrom = time.Now().UTC().Format("2006-01") + "-01"
		}
		if dateTo == "" {
			dateTo = time.Now().UTC().Format("2006-01-02")
		}

		ctx := r.Context()

		// By agent (from collections_daily_kpi + o3c_users)
		agentRows, err := db.PGQuery(ctx,
			`SELECT u.full_name AS agent_name, kd.agent_user_id,
			        COALESCE(SUM(kd.contacts_made),0)          AS contacts_total,
			        COALESCE(SUM(kd.promises_obtained),0)      AS promises_total,
			        COALESCE(SUM(kd.promises_broken),0)        AS promises_broken,
			        COALESCE(SUM(kd.amount_collected_kobo),0)  AS collected_kobo,
			        COALESCE(SUM(kd.target_amount_kobo),0)     AS target_kobo
			 FROM collections_daily_kpi kd
			 JOIN o3c_users u ON u.id=kd.agent_user_id
			 WHERE kd.kpi_date BETWEEN $1 AND $2
			 GROUP BY kd.agent_user_id, u.full_name
			 ORDER BY collected_kobo DESC`,
			dateFrom, dateTo)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}

		// By DPD bucket (from collection_assignments + collection_contacts)
		bucketRows, _ := db.PGQuery(ctx,
			`SELECT ca.dpd_bucket,
			        COUNT(DISTINCT ca.cif_number)             AS assigned_count,
			        COALESCE(SUM(ca.outstanding_kobo),0)      AS total_outstanding_kobo,
			        COUNT(cc.id)                              AS contact_attempts
			 FROM collection_assignments ca
			 LEFT JOIN collection_contacts cc ON cc.cif_number=ca.cif_number
			   AND cc.created_at::date BETWEEN $1 AND $2
			 GROUP BY ca.dpd_bucket ORDER BY ca.dpd_bucket`,
			dateFrom, dateTo)

		// Add derived rates per agent
		for _, row := range agentRows {
			promises := toFloat(row["promises_total"])
			broken := toFloat(row["promises_broken"])
			if promises > 0 {
				row["ptp_kept_rate"] = round1((promises - broken) / promises * 100)
			} else {
				row["ptp_kept_rate"] = 0.0
			}
			target := toFloat(row["target_kobo"])
			if target > 0 {
				row["collection_rate_pct"] = round1(toFloat(row["collected_kobo"]) / target * 100)
			} else {
				row["collection_rate_pct"] = 0.0
			}
		}
		respond(w, map[string]any{
			"date_from": dateFrom,
			"date_to":   dateTo,
			// rowsOrEmpty, not the bare slice: a nil result serialises as JSON null, and
			// "no rows" is an empty list, not an absent thing. collections_daily_kpi holds 0
			// rows today, so by_agent was arriving as null and every reader would have
			// needed its own null check to tell empty from broken.
			"by_agent":      rowsOrEmpty(agentRows),
			"by_dpd_bucket": rowsOrEmpty(bucketRows),
		}, "pg")
	}
}

// reportSettlementRecon returns approved/disbursed loans vs repayments received.
func reportSettlementRecon(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dateFrom, err := validDate(r, "date_from")
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		dateTo, err := validDate(r, "date_to")
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		if dateFrom == "" {
			dateFrom = time.Now().UTC().Format("2006-01") + "-01"
		}
		if dateTo == "" {
			dateTo = time.Now().UTC().Format("2006-01-02")
		}

		ctx := r.Context()

		// ── WHY THIS REPORT WAS REWRITTEN ────────────────────────────────────────
		//
		// All THREE of its data sources were dead, and none of them said so.
		// Measured 2026-10-07:
		//
		//   1. Disbursements read app.loan_applications: 8 rows in total, every
		//      amount_approved_kobo NULL, and 0 rows carrying booked_at. The windowed
		//      query could never return anything.
		//   2. Collections read "Collections Log", which exists in NO schema. DualQuery
		//      deliberately turns a missing relation into an empty result with a nil
		//      error so a half-built module shows a clean empty state, and the call site
		//      discarded the error anyway, so total_collections was silently null.
		//   3. Open exposure joined loan_repayments ON application_id. That column is
		//      NULL on all 86 rows and always will be: the GL capture keys on
		//      cbs_loan_account only. repaid_kobo was therefore 0 on every row, so
		//      "open exposure" always equalled the full disbursed amount.
		//
		// It now reads the books that actually hold this business: app.cbs_loans for
		// what was booked, and app.loan_repayments (the GL capture, keyed properly) for
		// what came back.
		//
		// OPEN EXPOSURE IS TAKEN FROM THE BOOK, NOT COMPUTED. Udara publishes
		// outstanding principal and interest directly, and the GL capture is partial by
		// design — it begins 2026-07-01 — so disbursed minus captured repayments would
		// overstate the exposure of every loan older than that. repaid_kobo is still
		// returned beside it, as evidence rather than as an input.

		// What was booked in the window, from the real loan book.
		disbRows, _ := db.PGQuery(ctx,
			`SELECT COALESCE(NULLIF(btrim(cl.product_name), ''), 'Unclassified') AS product_type,
			        COUNT(*)                                   AS loan_count,
			        COALESCE(SUM(cl.loan_amount_kobo), 0)      AS disbursed_kobo
			 FROM cbs_loans cl
			 WHERE cl.date_booked BETWEEN $1 AND $2
			 GROUP BY 1 ORDER BY disbursed_kobo DESC`,
			dateFrom, dateTo)

		// What came back in the window, split by what the posting was for. Keyed on
		// financial_date (the value date Udara assigns), not posted_at: a leg posted
		// late still belongs to the day it is dated.
		collRows, _ := db.PGQuery(ctx,
			`SELECT COALESCE(NULLIF(btrim(rp.component), ''), 'Unclassified') AS component,
			        COUNT(*)                                  AS payment_count,
			        COALESCE(SUM(rp.amount_kobo), 0)          AS collected_total_kobo,
			        COALESCE(SUM(rp.principal_kobo), 0)       AS principal_kobo,
			        COALESCE(SUM(rp.interest_kobo), 0)        AS interest_kobo
			 FROM loan_repayments rp
			 WHERE rp.financial_date BETWEEN $1 AND $2
			 GROUP BY 1 ORDER BY collected_total_kobo DESC`,
			dateFrom, dateTo)

		disbTotal, _ := db.PGQuery(ctx,
			`SELECT COALESCE(SUM(cl.loan_amount_kobo), 0) AS disbursed_kobo
			 FROM cbs_loans cl
			 WHERE cl.date_booked BETWEEN $1 AND $2`,
			dateFrom, dateTo)

		collTotalRows, _ := db.PGQuery(ctx,
			`SELECT COALESCE(SUM(rp.amount_kobo), 0) AS val
			 FROM loan_repayments rp
			 WHERE rp.financial_date BETWEEN $1 AND $2`,
			dateFrom, dateTo)
		var collTotal any = int64(0)
		if len(collTotalRows) > 0 {
			collTotal = collTotalRows[0]["val"]
		}

		// Open exposure, newest booking first.
		//
		// The borrower's name comes from app.cbs_customers, NEVER from app.customers.
		// cbs_customer_id is Udara's own namespace: of 300 Udara ids, 275 also exist as
		// a real card CIF, and in all 275 the card customer is a DIFFERENT person
		// (HYCUBE PLUS LIMITED reads as "Abimbola Lasaki"). Joining to customers.cif
		// would resolve 184 of 211 rows and every one of them would name a stranger.
		exposureRows, _ := db.PGQuery(ctx,
			`SELECT cl.cbs_account_number,
			        cl.reference_number,
			        COALESCE(NULLIF(btrim(cc.name), ''),
			                 NULLIF(btrim(cl.raw->>'name'), ''),
			                 '(name not in CBS)')              AS customer_name,
			        cl.cbs_customer_id,
			        cl.product_name,
			        cl.status,
			        cl.officer_name,
			        cl.date_booked,
			        cl.loan_amount_kobo                        AS disbursed_kobo,
			        COALESCE(cl.outstanding_principal_kobo, 0) +
			        COALESCE(cl.outstanding_interest_kobo, 0)  AS open_exposure_kobo,
			        COALESCE(rp.repaid_kobo, 0)                AS repaid_kobo
			 FROM cbs_loans cl
			 LEFT JOIN cbs_customers cc ON cc.cbs_customer_id = cl.cbs_customer_id
			 LEFT JOIN LATERAL (
			   SELECT SUM(r.amount_kobo) AS repaid_kobo
			     FROM loan_repayments r
			    WHERE r.cbs_loan_account = cl.cbs_account_number
			 ) rp ON TRUE
			 WHERE cl.date_booked BETWEEN $1 AND $2
			   AND COALESCE(cl.outstanding_principal_kobo, 0) +
			       COALESCE(cl.outstanding_interest_kobo, 0) > 0
			 ORDER BY open_exposure_kobo DESC
			 LIMIT 100`,
			dateFrom, dateTo)

		result := map[string]any{
			"date_from":              dateFrom,
			"date_to":                dateTo,
			"disbursements":          disbRows,
			"collections":            collRows,
			"total_collections_kobo": collTotal,
			"open_exposure":          exposureRows,
			// Stated so a reader can tell "nothing came back" from "we only started
			// capturing in July". The GL capture has no history before this date.
			"repayments_captured_from": "2026-07-01",
		}
		if len(disbTotal) > 0 {
			result["total_disbursed_kobo"] = disbTotal[0]["disbursed_kobo"]
		}
		respond(w, result, pickSource(nil))
	}
}

// reportAgentPerformance returns collections_daily_kpi grouped by agent for a date range.
func reportAgentPerformance(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dateFrom, err := validDate(r, "date_from")
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		dateTo, err := validDate(r, "date_to")
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		if dateFrom == "" {
			dateFrom = time.Now().UTC().Format("2006-01") + "-01"
		}
		if dateTo == "" {
			dateTo = time.Now().UTC().Format("2006-01-02")
		}

		rows, err := db.PGQuery(r.Context(),
			`SELECT u.full_name AS agent_name, u.id AS agent_user_id,
			        COALESCE(SUM(kd.contacts_made),0)         AS contacts_total,
			        COALESCE(SUM(kd.promises_obtained),0)     AS promises_total,
			        COALESCE(SUM(kd.promises_broken),0)       AS promises_broken,
			        COALESCE(SUM(kd.amount_collected_kobo),0) AS collected_kobo,
			        COALESCE(SUM(kd.target_amount_kobo),0)    AS target_kobo,
			        COUNT(DISTINCT kd.kpi_date)               AS active_days
			 FROM o3c_users u
			 LEFT JOIN collections_daily_kpi kd ON kd.agent_user_id = u.id
			     AND kd.kpi_date BETWEEN $1 AND $2
			 -- 'collections' was in this list and is not a role this platform has. The live
			 -- vocabulary is collections_agent (2 users) and recovery_agent (2); there is no
			 -- 'collections' role and no collections_head user today. A dead predicate costs
			 -- nothing to run, but it hides the real question of who belongs in this report.
			 -- collections_head is included so a head, once one exists, is not invisible.
			 -- recovery_agent is deliberately NOT: recovery is a separate book with its own
			 -- report, and its agents are not worked against collections targets.
			 WHERE u.role IN ('collections_agent','collections_head')
			 GROUP BY u.id, u.full_name
			 ORDER BY collected_kobo DESC`,
			dateFrom, dateTo)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}

		for _, row := range rows {
			target := toFloat(row["target_kobo"])
			if target > 0 {
				row["target_achievement_pct"] = round1(toFloat(row["collected_kobo"]) / target * 100)
			} else {
				row["target_achievement_pct"] = 0.0
			}
		}
		// Wrapped in a named block like every other report in the library. This one
		// alone returned a bare top-level array, which a generic renderer cannot
		// caption and cannot tell apart from an error payload. Nothing consumed it,
		// so the shape is free to correct now; it stops being free the day a page
		// reads it.
		respond(w, map[string]any{
			"date_from": dateFrom,
			"date_to":   dateTo,
			"by_agent":  rowsOrEmpty(rows),
		}, "pg")
	}
}

// reportCustomerStatement returns account details + 90-day transactions for a CIF.
func reportCustomerStatement(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cif := qstr(r, "cif")
		if cif == "" {
			respondErr(w, 400, "cif query parameter is required")
			return
		}
		dateFrom, dateTo, err := normalizeStatementDates(qstr(r, "date_from"), qstr(r, "date_to"))
		if err != nil {
			respondErr(w, 422, err.Error())
			return
		}
		statement, err := loadCustomerStatement(r.Context(), db, cif, dateFrom, dateTo)
		if err != nil {
			respondErr(w, 500, err.Error())
			return
		}
		respond(w, map[string]any{
			"account":      statement.Account,
			"products":     statement.Products,
			"transactions": statement.Transactions,
			// A statement shows at most statementTxnLimit transactions. Saying so is the
			// difference between a short statement and a wrong one.
			"truncated": statement.Truncated,
			"txn_limit": statementTxnLimit,
			"date_from": dateFrom,
			"date_to":   dateTo,
		}, statement.Source)
	}
}

// reportAuditTrailExport returns a paginated audit trail export.
func reportAuditTrailExport(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dateFrom, err := validDate(r, "date_from")
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		dateTo, err := validDate(r, "date_to")
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		limit := qint(r, "limit", 500, 1, 5000)
		offset := qint(r, "offset", 0, 0, 1<<30)

		ctx := r.Context()
		n := 1
		where := "WHERE 1=1"
		args := []any{}

		if dateFrom != "" {
			where += fmt.Sprintf(" AND ts::date >= $%d", n)
			args = append(args, dateFrom)
			n++
		}
		if dateTo != "" {
			where += fmt.Sprintf(" AND ts::date <= $%d", n)
			args = append(args, dateTo)
			n++
		}

		countRows, _ := db.PGQuery(ctx,
			fmt.Sprintf("SELECT COUNT(*) AS n FROM o3c_activity_log %s", where), args...)
		total := int64(0)
		if len(countRows) > 0 {
			total = toInt64(countRows[0]["n"])
		}

		pageArgs := append(append([]any(nil), args...), limit, offset)
		rows, err := db.PGQuery(ctx,
			fmt.Sprintf(`SELECT al.id, al.user_id, u.full_name, u.role,
			        al.action, al.resource AS entity_type, al.detail, al.ts AS created_at
			 FROM o3c_activity_log al
			 LEFT JOIN o3c_users u ON u.id=al.user_id
			 %s ORDER BY al.ts DESC
			 LIMIT $%d OFFSET $%d`, where, n, n+1),
			pageArgs...)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		respond(w, map[string]any{
			"data":   rows,
			"total":  total,
			"limit":  limit,
			"offset": offset,
		}, "pg")
	}
}

// reportNPLReturn returns CBN NPL return format data.
func reportNPLReturn(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		// Latest portfolio snapshot
		snapRows, err := db.PGQuery(ctx,
			`SELECT snapshot_date, total_loans, total_outstanding_kobo, total_npls_kobo,
			        npl_ratio_bps, par30_kobo, par60_kobo, par90_kobo FROM (`+cbsSnapshotLiveSQL+`) s`)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}

		// DPD buckets, live off the CBS book.
		//
		// This used to read loan_dpd_daily_snapshot, which has never had a row in
		// it. The effect was a regulatory return that printed a correct headline
		// NPL ratio next to an empty bucket table and zero provisions — the kind
		// of internal contradiction that gets noticed in a CBN pack. The snapshot
		// table is not populated by anything, so the fix is to stop waiting for it
		// and derive the buckets from the same live source the ratio comes from.
		bucketRows, _ := db.PGQuery(ctx, cbsDPDBucketsSQL)

		// Write-offs in period
		dateFrom, _ := validDate(r, "date_from")
		dateTo, _ := validDate(r, "date_to")
		if dateFrom == "" {
			dateFrom = time.Now().UTC().Format("2006-01") + "-01"
		}
		if dateTo == "" {
			dateTo = time.Now().UTC().Format("2006-01-02")
		}
		writeOffRows, _ := db.PGQuery(ctx,
			`SELECT COUNT(*) AS count,
			        COALESCE(SUM(total_outstanding_kobo),0) AS total_written_off_kobo
			 FROM recovery_cases
			 WHERE write_off_status='approved'
			   AND updated_at::date BETWEEN $1 AND $2`,
			dateFrom, dateTo)

		snapshot := map[string]any{}
		if len(snapRows) > 0 {
			snapshot = snapRows[0]
			// npl_ratio as percentage
			nplBps := toFloat(snapshot["npl_ratio_bps"])
			snapshot["npl_ratio_pct"] = round1(nplBps / 100.0)
		}

		// Provisions, live off the CBS book, on the CBN prudential classification:
		//
		//   Performing    0–90 days     1%
		//   Substandard   91–180 days   10%
		//   Doubtful      181–360 days  50%
		//   Lost          over 360 days 100%
		//
		// NOTE — these thresholds differ from what this report used before. The
		// previous code provisioned at 1/10/50/100% on 1-30 / 31-60 / 61-90 / 90+,
		// which treats a 61-day-late loan as Doubtful when CBN still classifies it
		// as Performing. It never produced a number (the table it read is empty),
		// so nothing has been filed on the old basis — but the rates below should
		// be confirmed by Finance/Compliance against the facility class O3 reports
		// under before this return is submitted.
		provRows, _ := db.PGQuery(ctx, `
			SELECT
			  COALESCE(SUM(op) FILTER (WHERE dpd <= 90), 0)                 AS base_performing,
			  COALESCE(SUM(op) FILTER (WHERE dpd BETWEEN 91 AND 180), 0)    AS base_substandard,
			  COALESCE(SUM(op) FILTER (WHERE dpd BETWEEN 181 AND 360), 0)   AS base_doubtful,
			  COALESCE(SUM(op) FILTER (WHERE dpd > 360), 0)                 AS base_lost
			FROM (SELECT outstanding_principal_kobo AS op, `+cbsLoanDPDBare+` AS dpd
			      FROM cbs_loans WHERE status NOT IN ('Closed','Revoked')) x`)
		if len(provRows) > 0 {
			base := func(k string) float64 { return toFloat(provRows[0][k]) }
			performing := base("base_performing") * 0.01
			substandard := base("base_substandard") * 0.10
			doubtful := base("base_doubtful") * 0.50
			lost := base("base_lost") * 1.00

			snapshot["provision_performing_kobo"] = int64(performing)
			snapshot["provision_substandard_kobo"] = int64(substandard)
			snapshot["provision_doubtful_kobo"] = int64(doubtful)
			snapshot["provision_lost_kobo"] = int64(lost)
			snapshot["provision_total_kobo"] = int64(performing + substandard + doubtful + lost)

			// The exposure each rate was applied to, so the return can be checked
			// without re-deriving it: a provision figure nobody can reconcile is
			// a provision figure nobody trusts.
			snapshot["exposure_performing_kobo"] = int64(base("base_performing"))
			snapshot["exposure_substandard_kobo"] = int64(base("base_substandard"))
			snapshot["exposure_doubtful_kobo"] = int64(base("base_doubtful"))
			snapshot["exposure_lost_kobo"] = int64(base("base_lost"))
		}
		snapshot["provision_basis"] = "CBN prudential: 1% ≤90d, 10% 91-180d, 50% 181-360d, 100% >360d"

		result := map[string]any{
			"report_date": dateTo,
			"snapshot":    snapshot,
			"dpd_buckets": bucketRows,
		}
		if len(writeOffRows) > 0 {
			result["write_offs_in_period"] = writeOffRows[0]
		}
		respond(w, result, "pg")
	}
}

// reportPeriodRange converts a period name to (dateFrom, dateTo) strings in YYYY-MM-DD format.
// reportSalesPipeline is the BI view of the campaign → call-centre → sales pipeline:
// the funnel, lead source mix with conversion, stage distribution, per-officer
// attribution, and the forward outcomes. Date range applies to lead creation.
func reportSalesPipeline(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dateFrom, err := validDate(r, "date_from")
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		dateTo, err := validDate(r, "date_to")
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		if dateFrom == "" {
			dateFrom = "2000-01-01"
		}
		if dateTo == "" {
			dateTo = time.Now().UTC().Format("2006-01-02")
		}
		ctx := r.Context()

		// Every query in this report is gated on sales_entered_at. It is the SALES
		// pipeline, and crm_contacts is shared with the call centre and Zoho Desk — so
		// ungated, a report headed "Sales Pipeline" counted 16,752 help-desk contacts as
		// pipeline and divided real conversions by them. See migration 302.

		// Lead source mix with conversion, over the window (excluding already-customers).
		bySource, _ := db.PGQuery(ctx, `
			SELECT COALESCE(NULLIF(lead_source,''),'other')                       AS source,
			       COUNT(*)                                                        AS leads,
			       COUNT(*) FILTER (WHERE lead_stage = 'converted')                AS converted,
			       COUNT(*) FILTER (WHERE lead_stage = 'disqualified')             AS disqualified
			  FROM app.crm_contacts
			 WHERE sales_entered_at IS NOT NULL
			   AND COALESCE(already_customer,false) = false
			   AND created_at::date BETWEEN $1 AND $2
			 GROUP BY 1 ORDER BY leads DESC`, dateFrom, dateTo)
		for _, row := range bySource {
			leads := toFloat(row["leads"])
			if leads > 0 {
				row["conversion_rate_pct"] = round1(toFloat(row["converted"]) / leads * 100)
			} else {
				row["conversion_rate_pct"] = 0.0
			}
		}

		// Stage distribution.
		byStage, _ := db.PGQuery(ctx, `
			SELECT lead_stage AS stage, COUNT(*) AS leads,
			       COALESCE(SUM(estimated_value_kobo),0) AS value_kobo
			  FROM app.crm_contacts
			 WHERE sales_entered_at IS NOT NULL
			   AND COALESCE(already_customer,false) = false
			   AND created_at::date BETWEEN $1 AND $2
			 GROUP BY 1 ORDER BY leads DESC`, dateFrom, dateTo)

		// Per-officer attribution: owned leads and how many they've converted. Windowed to
		// the report's date range so it doesn't mix all-time officer totals into a
		// last-month funnel (which made the conversion ratios internally inconsistent).
		byOfficer, _ := db.PGQuery(ctx, `
			SELECT u.full_name AS officer_name,
			       COUNT(*)                                            AS owned,
			       COUNT(*) FILTER (WHERE c.lead_stage = 'converted')  AS converted,
			       COUNT(*) FILTER (WHERE c.lead_stage IN (`+openLeadStagesSQL+`)) AS open_leads
			  FROM app.crm_contacts c
			  JOIN o3c_users u ON u.id = c.sales_owner_id
			 WHERE COALESCE(c.already_customer,false) = false
			   AND c.created_at::date BETWEEN $1 AND $2
			 GROUP BY u.full_name
			 ORDER BY converted DESC, owned DESC
			 LIMIT 50`, dateFrom, dateTo)
		for _, row := range byOfficer {
			owned := toFloat(row["owned"])
			if owned > 0 {
				row["conversion_rate_pct"] = round1(toFloat(row["converted"]) / owned * 100)
			} else {
				row["conversion_rate_pct"] = 0.0
			}
		}

		// Forward outcomes — windowed to the report range (was all-time, so it disagreed
		// with the windowed funnel above).
		forwards, _ := db.PGQuery(ctx, `
			SELECT `+forwardStatusExpr+` AS status, COUNT(*) AS count
			  FROM app.call_center_lead_forwards f
			  LEFT JOIN app.crm_contacts c ON c.id = f.contact_id
			 WHERE f.forwarded_at::date BETWEEN $1 AND $2
			 GROUP BY 1 ORDER BY count DESC`, dateFrom, dateTo)

		respond(w, map[string]any{
			"date_from":  dateFrom,
			"date_to":    dateTo,
			"by_source":  bySource,
			"by_stage":   byStage,
			"by_officer": byOfficer,
			"forwards":   forwards,
		}, "pg")
	}
}

func reportPeriodRange(period string) (dateFrom, dateTo string) {
	now := time.Now()
	switch period {
	case "last_month":
		first := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, now.Location())
		end := first.AddDate(0, 0, -1)
		start := time.Date(end.Year(), end.Month(), 1, 0, 0, 0, 0, now.Location())
		return start.Format("2006-01-02"), end.Format("2006-01-02")
	case "this_quarter":
		q := (int(now.Month()) - 1) / 3
		start := time.Date(now.Year(), time.Month(q*3+1), 1, 0, 0, 0, 0, now.Location())
		return start.Format("2006-01-02"), now.Format("2006-01-02")
	case "last_quarter":
		q := (int(now.Month()) - 1) / 3
		qStart := time.Date(now.Year(), time.Month(q*3+1), 1, 0, 0, 0, 0, now.Location())
		end := qStart.AddDate(0, 0, -1)
		pq := (int(end.Month()) - 1) / 3
		start := time.Date(end.Year(), time.Month(pq*3+1), 1, 0, 0, 0, 0, now.Location())
		return start.Format("2006-01-02"), end.Format("2006-01-02")
	case "this_year":
		start := time.Date(now.Year(), 1, 1, 0, 0, 0, 0, now.Location())
		return start.Format("2006-01-02"), now.Format("2006-01-02")
	default: // "this_month"
		start := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, now.Location())
		return start.Format("2006-01-02"), now.Format("2006-01-02")
	}
}

func reportKPIsHandler(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		period := qstr(r, "period")
		if period == "" {
			period = "this_month"
		}
		dateFrom, dateTo := reportPeriodRange(period)
		// VALIDATE THE OVERRIDES. These were taken straight off the query string, and
		// every KPI query below discards its own error (`rows, _ :=`), so a malformed
		// date made each $1::date cast throw and each tile fall through to its pre-set
		// zero. The result was HTTP 200 with every KPI reading 0 and nothing, anywhere,
		// reporting a fault — the single most misleading response this endpoint could
		// produce. The BI module validated the same two parameters and returned 422;
		// this one did not.
		if v, err := validDate(r, "from"); err != nil {
			respondErr(w, 400, err.Error())
			return
		} else if v != "" {
			dateFrom = v
		}
		if v, err := validDate(r, "to"); err != nil {
			respondErr(w, 400, err.Error())
			return
		} else if v != "" {
			dateTo = v
		}

		out := map[string]any{}

		// Active loans, from the live CBS book.
		//
		// This counted `loan_accounts`, a table that does not exist in this
		// database — so the query errored and the KPI silently reported 0 while
		// there were 25 live loans on the book.
		out["active_loans"] = 0
		if rows, _ := db.PGQuery(ctx,
			`SELECT COUNT(*) AS val FROM cbs_loans WHERE status NOT IN ('Closed','Revoked')`); len(rows) > 0 {
			out["active_loans"] = rows[0]["val"]
		}

		// Disbursed in the period, from the real loan book.
		//
		// This read app.loan_applications and was structurally incapable of returning a
		// figure. Measured 2026-10-07: 8 rows in the entire table, every
		// disbursed_amount_kobo NULL, 0 rows carrying disbursed_at, and a live status of
		// 'submitted' — so the status filter excluded all 8 before the NULL sum could
		// even reach 0. The book Udara actually publishes is app.cbs_loans, dated by
		// date_booked, which carries 56 loans and NGN 2.0bn booked this year.
		if rows, _ := db.PGQuery(ctx,
			`SELECT COALESCE(SUM(cl.loan_amount_kobo),0) AS val
			 FROM cbs_loans cl
			 WHERE cl.date_booked BETWEEN $1::date AND $2::date`,
			dateFrom, dateTo); len(rows) > 0 {
			out["total_disbursed_kobo"] = rows[0]["val"]
		} else {
			out["total_disbursed_kobo"] = 0
		}
		// NPL ratio and PAR30 from latest portfolio snapshot
		out["npl_ratio_pct"] = 0.0
		out["par30_pct"] = 0.0
		if rows, _ := db.PGQuery(ctx,
			`SELECT npl_ratio_bps, par30_kobo, total_outstanding_kobo FROM (`+cbsSnapshotLiveSQL+`) s`); len(rows) > 0 {
			out["npl_ratio_pct"] = round1(toFloat(rows[0]["npl_ratio_bps"]) / 100.0)
			total := toFloat(rows[0]["total_outstanding_kobo"])
			if total > 0 {
				out["par30_pct"] = round1(toFloat(rows[0]["par30_kobo"]) / total * 100)
			}
		}

		// Collection rate, from the one definition every surface shares. It is a
		// to-date, like-for-like figure and NOT scoped to dateFrom..dateTo — the reasons
		// are on collectionRateToDate, along with what it used to read and why that was
		// always 0. Keeping the key unchanged keeps the KPI Tracker's contract.
		out["collection_rate_pct"] = collectionRateToDate(ctx, db, 0)

		// Recovery rate: BY VALUE, AND AS STOCK. Two deliberate choices.
		//
		// It used to count cases at status='recovered'. Nothing has ever written that
		// value -- the live vocabulary is closed (908), active (461), legal (248) -- so
		// the numerator was 0 across all 1,617 cases and the tile read 0.0% for ever.
		// That was a wrong filter, not missing data.
		//
		// BY VALUE, because a rate counted in cases says nothing about how much money
		// came back, and the canonical credit measures here are value-weighted (see
		// app.is_npl, migration 261).
		//
		// AS STOCK and not windowed, because 1,585 of the 1,617 cases were created in
		// the single week of 2026-08-24 by bulk import, and there is no recovered_at
		// column to window on -- only opened_at and closed_at. A created_at window
		// gives September just 30 cases and a rate that is an artefact of the import
		// date. The management reports already report recovery as stock, in as many
		// words, for exactly this reason.
		//
		// Reads 16.8% on 2026-10-07: NGN 921.2m recovered of NGN 5.48bn placed.
		out["recovery_rate_pct"] = 0.0
		if rows, _ := db.PGQuery(ctx,
			`SELECT COALESCE(SUM(COALESCE(recovered_kobo,0)),0) AS recovered,
			        COALESCE(SUM(COALESCE(recovered_kobo,0) + COALESCE(outstanding_kobo,0)),0) AS placed
			 FROM recovery_cases`); len(rows) > 0 {
			placed := toFloat(rows[0]["placed"])
			if placed > 0 {
				out["recovery_rate_pct"] = round1(toFloat(rows[0]["recovered"]) / placed * 100)
			}
		}

		// CSAT score
		out["csat_score"] = 0.0
		if rows, _ := db.PGQuery(ctx,
			`SELECT COALESCE(AVG(csat_score), 0) AS val FROM helpdesk_tickets
			 WHERE csat_score IS NOT NULL AND resolved_at::date BETWEEN $1::date AND $2::date`,
			dateFrom, dateTo); len(rows) > 0 {
			out["csat_score"] = toFloat(rows[0]["val"])
		}

		// Retention. The tracker carried ten KPIs and not one of them was about
		// KEEPING a customer — every measure was acquisition, revenue or credit
		// risk, while 6,539 customers walked out with NGN 3.6bn of annual spend and
		// nothing on this page moved.
		//
		// Both are snapshots off app.customer_lifecycle (migration 289) rather than
		// period figures: a bucket is a statement about today, not about a month.
		// Both deliberately exclude bucket='unknown' — the ~13,300 parties we hold no
		// transaction history for. Counting them as retained would flatter the rate;
		// counting them as churned would invent a disaster. They are unmeasured, and
		// a KPI has no business guessing.
		out["dormant_rate_pct"] = 0.0
		out["winback_value_kobo"] = 0
		if rows, _ := db.PGQuery(ctx, `
			SELECT COALESCE(ROUND(
			         100.0 * COUNT(*) FILTER (WHERE bucket IN ('lapsed','churned'))
			         / NULLIF(COUNT(*) FILTER (WHERE measured), 0), 2), 0) AS dormant_pct,
			       COALESCE(SUM(value_kobo) FILTER (
			         WHERE bucket IN ('lapsed','churned')
			           AND measured AND contactable AND NOT has_open_recovery), 0) AS winback_kobo
			  FROM app.customer_lifecycle`); len(rows) > 0 {
			out["dormant_rate_pct"] = toFloat(rows[0]["dormant_pct"])
			out["winback_value_kobo"] = rows[0]["winback_kobo"]
		}

		// New customers — counted by first account opened.
		//
		// Originally loan applications, which reads zero for a business whose
		// customers overwhelmingly arrive through cards and fixed deposits. Then
		// customers.account_created, which the feed stopped populating on
		// 2025-07-09 — also zero. accounts.opened_date is the actual business
		// event, current to 2026-08-25, and grouping by the CIF's earliest one
		// means a customer taking a second card is not counted twice.
		out["new_customers"] = 0
		if rows, _ := db.PGQuery(ctx, `
			SELECT COUNT(*) AS val FROM (
			  SELECT cif, MIN(opened_date) AS first_open
			  FROM app.accounts
			  WHERE opened_date IS NOT NULL AND NULLIF(cif,'') IS NOT NULL
			  GROUP BY cif
			) fa
			WHERE fa.first_open BETWEEN $1::date AND $2::date`,
			dateFrom, dateTo); len(rows) > 0 {
			out["new_customers"] = rows[0]["val"]
		}

		// Active cards (dual DB: MSSQL live / PG mirror)
		activeCards, _, _ := db.DualScalar(ctx, "val",
			`SELECT COUNT(*) AS val FROM app.accounts WHERE status IN ('Open','Active')`)
		out["active_cards"] = activeCards

		// Revenue — card fees, interest and penalties from app.income_daily.
		//
		// This read app.fee_income, which has never had a row in it, so the
		// business's headline revenue KPI reported ₦0 while 1.1m card transactions
		// carried every fee and interest posting ever made. app.income_daily
		// (migration 157) classifies those postings by the descriptions CCS writes
		// into the book, and excludes the 600/601/603 interest components that
		// code 604 already totals — summing all four nearly doubles interest.
		//
		// Amounts on that book are numeric NAIRA, not kobo, so convert: everything
		// this endpoint returns as *_kobo must actually be kobo.
		out["revenue_kobo"] = int64(0)
		out["revenue_fee_kobo"] = int64(0)
		out["revenue_interest_kobo"] = int64(0)
		out["revenue_penalty_kobo"] = int64(0)
		if rows, _ := db.PGQuery(ctx, `
			SELECT category, COALESCE(SUM(amount_ngn), 0) AS ngn
			FROM app.income_daily
			WHERE income_date BETWEEN $1::date AND $2::date
			GROUP BY category`, dateFrom, dateTo); len(rows) > 0 {
			var total float64
			for _, row := range rows {
				ngn := toFloat(row["ngn"])
				total += ngn
				switch str(row["category"]) {
				case "fee":
					out["revenue_fee_kobo"] = int64(ngn * 100)
				case "interest":
					out["revenue_interest_kobo"] = int64(ngn * 100)
				case "penalty":
					out["revenue_penalty_kobo"] = int64(ngn * 100)
				}
			}
			out["revenue_kobo"] = int64(total * 100)
		}

		// Loan interest income (accrual) from the Udara repayment schedule — makes the
		// headline revenue full-business (card book + loan book), consistent with the
		// executive Revenue KPI and the finance Income Statement. FD interest is a cost of
		// funds and is deliberately excluded from revenue.
		out["revenue_loan_interest_kobo"] = int64(0)
		if rows, _ := db.PGQuery(ctx, `
			SELECT COALESCE(SUM(interest_kobo), 0) AS v FROM app.cbs_loan_schedules
			WHERE payment_date BETWEEN $1::date AND $2::date`, dateFrom, dateTo); len(rows) > 0 {
			loanKobo := toInt64(rows[0]["v"])
			out["revenue_loan_interest_kobo"] = loanKobo
			out["revenue_interest_kobo"] = toInt64(out["revenue_interest_kobo"]) + loanKobo
			out["revenue_kobo"] = toInt64(out["revenue_kobo"]) + loanKobo
		}

		// Targets.
		//
		// kpi_targets.period holds a CADENCE ('monthly', 'quarterly', 'annual');
		// this endpoint is asked for a WINDOW ('this_month', 'last_quarter'). The
		// old query compared the two directly — `WHERE period = $1` — so no target
		// ever matched and every RAG indicator would have read zero even once the
		// table was populated. Map window → cadence.
		cadence := "monthly"
		switch period {
		case "this_quarter", "last_quarter":
			cadence = "quarterly"
		case "this_year":
			cadence = "annual"
		}
		// Role-scoped: targets are per role, so prefer the caller's own target and
		// fall back to an 'all' row. Ordering puts the specific match first.
		callerRole := ""
		if u := core.UserFromCtx(ctx); u != nil {
			callerRole = u.Role
		}
		targetRows, _ := db.PGQuery(ctx, `
			SELECT metric_name, target_value
			FROM kpi_targets
			WHERE (period = $1 OR period = 'all')
			  AND (role = $2 OR role = 'all')
			ORDER BY (role = $2) DESC, (period = $1) DESC`, cadence, callerRole)
		seen := map[string]bool{}
		for _, tr := range targetRows {
			if name := str(tr["metric_name"]); name != "" && !seen[name] {
				out["target_"+name] = tr["target_value"]
				seen[name] = true
			}
		}
		// A metric with no target is reported as absent, not as a target of 0.
		// Zero is a real target ("no NPLs"), and conflating the two is why every
		// RAG dot on the tracker showed the same colour.
		out["targets_set"] = len(seen)

		respond(w, out, "pg")
	}
}

// reportKPIHistoryHandler returns a monthly trend for the KPI Tracker.
//
// The window is configurable (?months=, default 12). It was hardcoded to 6, which
// is too short to see a seasonal pattern in a card business.
func reportKPIHistoryHandler(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		months := qint(r, "months", 12, 3, 36)

		rows, err := db.PGQuery(r.Context(), `
			WITH months AS (
			  SELECT DATE_TRUNC('month', CURRENT_DATE - (i || ' months')::interval)::date AS month_start
			  FROM generate_series($1::int - 1, 0, -1) AS gs(i)
			),
			disbursements AS (
			  SELECT DATE_TRUNC('month', disbursed_at)::date AS m, COALESCE(SUM(disbursed_amount_kobo),0) AS total
			  FROM loan_applications
			  WHERE status IN ('disbursed','active') AND disbursed_at IS NOT NULL
			  GROUP BY 1
			),
			collections AS (
			  SELECT DATE_TRUNC('month', kpi_date)::date AS m,
			    CASE WHEN SUM(target_amount_kobo) > 0 THEN
			      ROUND(100.0 * SUM(amount_collected_kobo)/SUM(target_amount_kobo), 1)
			    ELSE NULL END AS rate
			  FROM collections_daily_kpi GROUP BY 1
			),
			-- NPL BY VALUE, not the mean of daily ratios.
			--
			-- npl_kobo is already canonical: batch.go computes it with app.is_npl (migration
			-- 261 -- DPD > 90 OR CBS Defaulting/Expired), so the rule is not the problem here.
			-- The ARITHMETIC was. AVG() over each day's ratio is not the month's ratio, and the
			-- old ELSE 0 fed a 0% day into that mean for any snapshot holding no principal,
			-- pulling it down further. Measured 2026-10-07 against this table:
			--
			--     month     snaps   was      is
			--     2026-10       7   74.06    74.02
			--     2026-09      30   60.68    58.50   overstated  2.2pp
			--     2026-08      28   31.12    36.82   understated 5.7pp
			--
			-- The error reversed sign between consecutive months, so it was not even a
			-- consistent bias that a reader could learn to discount.
			--
			-- snaps is returned so the page can say how many days back a figure. The table
			-- holds 65 rows from 2026-08-03 only, so most of a 12-month window has no
			-- snapshot at all, and a month with none must read as unknown, never as 0% NPL.
			npl AS (
			  SELECT DATE_TRUNC('month', snapshot_date)::date AS m,
			    CASE WHEN SUM(outstanding_principal_kobo) > 0 THEN
			      ROUND(100.0 * SUM(npl_kobo) / SUM(outstanding_principal_kobo), 2)
			    ELSE NULL END AS ratio,
			    COUNT(*)::int AS snaps
			  FROM cbs_portfolio_snapshot GROUP BY 1
			),
			-- Revenue from the card book rather than the never-populated
			-- fee_income table. income_daily is NAIRA; ×100 for kobo.
			revenue AS (
			  SELECT DATE_TRUNC('month', income_date)::date AS m,
			         ROUND(SUM(amount_ngn) * 100)                                    AS total,
			         ROUND(SUM(amount_ngn) FILTER (WHERE category='fee')      * 100) AS fee,
			         ROUND(SUM(amount_ngn) FILTER (WHERE category='interest') * 100) AS interest,
			         ROUND(SUM(amount_ngn) FILTER (WHERE category='penalty')  * 100) AS penalty
			  FROM app.income_daily GROUP BY 1
			),
			-- New customers per month, counted by FIRST ACCOUNT OPENED.
			--
			-- Not app.customers.account_created: that field stopped being populated
			-- by the feed on 2025-07-09, so counting it reports zero new customers
			-- for the last thirteen months. Not customers.created_at either — that
			-- is when the workspace ingested the row, not when O3 won the customer.
			--
			-- Grouped by CIF's earliest opened_date, so a customer who later takes a
			-- second card is not counted again: a CIF is a card, not a person, and
			-- acquisition is a first-account event.
			customers AS (
			  SELECT DATE_TRUNC('month', fa.first_open)::date AS m, COUNT(*) AS n
			  FROM (SELECT cif, MIN(opened_date) AS first_open
			        FROM app.accounts
			        WHERE opened_date IS NOT NULL AND NULLIF(cif,'') IS NOT NULL
			        GROUP BY cif) fa
			  GROUP BY 1
			),
			-- Data coverage, so a month with no feed cannot be read as a month with
			-- no business. The CSV drops have real gaps (Nov 2025 has 1 transaction,
			-- May 2026 has 5, Dec 2025 none at all), and a revenue chart that plots
			-- those as ₦0 says "we earned nothing" when the truth is "we have no
			-- data". The UI uses this to mark the month instead of plotting a zero.
			coverage AS (
			  SELECT DATE_TRUNC('month', txn_date)::date AS m, COUNT(*) AS txn_count
			  FROM app.transactions WHERE txn_date IS NOT NULL GROUP BY 1
			),
			-- Support load and satisfaction, so the trend is not credit-only.
			tickets AS (
			  SELECT DATE_TRUNC('month', created_at)::date AS m,
			         COUNT(*) AS n,
			         ROUND(AVG(csat_score) FILTER (WHERE csat_score IS NOT NULL), 2) AS csat
			  FROM app.helpdesk_tickets GROUP BY 1
			)
			SELECT
			  TO_CHAR(mo.month_start, 'Mon YYYY') AS period_label,
			  mo.month_start                      AS period_start,
			  COALESCE(d.total, 0)                AS total_disbursed_kobo,
			  c.rate                              AS collection_rate_pct,
			  n.ratio                             AS npl_ratio_pct,
			  COALESCE(n.snaps, 0)                AS npl_snapshots,
			  COALESCE(rv.total, 0)               AS revenue_kobo,
			  COALESCE(rv.fee, 0)                 AS revenue_fee_kobo,
			  COALESCE(rv.interest, 0)            AS revenue_interest_kobo,
			  COALESCE(rv.penalty, 0)             AS revenue_penalty_kobo,
			  COALESCE(cu.n, 0)                   AS new_customers,
			  COALESCE(tk.n, 0)                   AS tickets_created,
			  tk.csat                             AS csat_score,
			  COALESCE(cv.txn_count, 0)           AS txn_count,
			  -- A month is only trustworthy for card figures if the feed actually
			  -- delivered. 500 is well below the ~4-6k a normal month carries and
			  -- well above the 1-5 rows a broken month leaves behind.
			  (COALESCE(cv.txn_count, 0) >= 500)  AS data_complete
			FROM months mo
			LEFT JOIN disbursements d  ON d.m  = mo.month_start
			LEFT JOIN collections   c  ON c.m  = mo.month_start
			LEFT JOIN npl           n  ON n.m  = mo.month_start
			LEFT JOIN revenue       rv ON rv.m = mo.month_start
			LEFT JOIN customers     cu ON cu.m = mo.month_start
			LEFT JOIN tickets       tk ON tk.m = mo.month_start
			LEFT JOIN coverage      cv ON cv.m = mo.month_start
			ORDER BY mo.month_start`, months)
		if err != nil {
			respondErrLog(w, 500, "KPI history query failed", err)
			return
		}
		if rows == nil {
			rows = []map[string]any{}
		}
		respond(w, rows, "pg")
	}
}

/* The BI report builder that used to live here has been removed.

   It was a second, incompatible copy of /api/bi: its own tables (report_configs,
   report_schedules) and its own endpoints, with no runner behind the schedules
   and no page reaching most of it. None of its four actions worked — the
   frontend posted {module, metrics, granularity} while the handler read
   report_type, so every run returned an empty set with no error; save and
   schedule 422'd on required fields the UI never sent.

   Report definitions, runs and scheduled delivery now live in exactly one place:
   handlers/bi.go over bi_report_definitions / bi_scheduled_reports / bi_report_runs.
   File extraction lives in handlers/exports.go. What remains in this file is the
   set of fixed operational reports above, which are real and now reachable.
*/

package handlers

import (
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
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

	// Rollup health and manual triggers — the reporting layer's own plumbing.
	RegisterReportingRollups(r, db)

	// Cards, revenue, acquisition, service and deposits — see reports_business.go.
	registerBusinessReports(r, db, read)

	// Legacy export log path, kept so an old tab does not 404 mid-session.
	// The engine's own log is GET /api/reports/exports/log.
	r.With(read).Get("/export-log", exportLog(db))
}

// reportsList returns metadata for all available report types.
func reportsList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Ordered by product line, so the library reads the way the business is
		// organised rather than the order the handlers happened to be written.
		reports := []map[string]any{
			// Revenue
			{"key": "income", "group": "Revenue", "name": "Income & Revenue Report",
				"description": "Fee, interest and penalty income by category, product and month, off the card book"},
			// Cards
			{"key": "card-portfolio", "group": "Cards", "name": "Card Portfolio Report",
				"description": "Accounts by status and product, limits, balances, utilisation bands and delinquency"},
			// Customers
			{"key": "customer-acquisition", "group": "Customers", "name": "Customer Acquisition Report",
				"description": "New customers by month, first product and state, counted by first account opened"},
			// Credit
			{"key": "loan-portfolio", "group": "Credit", "name": "Loan Portfolio Report",
				"description": "All loans: status, amounts, tenor, interest rate distribution, top 10 by outstanding"},
			{"key": "npl-return", "group": "Credit", "name": "CBN NPL Return",
				"description": "Loans by DPD bucket, NPL ratio, CBN prudential provisions, write-offs"},
			{"key": "monthly-business", "group": "Credit", "name": "Monthly Business Report",
				"description": "New accounts, disbursements, collections, recoveries, NPL — grouped by product"},
			// Deposits
			{"key": "fd-book", "group": "Fixed Deposits", "name": "Fixed Deposit Book",
				"description": "Deposit book by status and product, with the maturity ladder treasury needs"},
			// Collections
			{"key": "collections-performance", "group": "Collections", "name": "Collections Performance Report",
				"description": "Agent contact attempts, PTP count, kept rate, amount vs target by agent and DPD bucket"},
			{"key": "agent-performance", "group": "Collections", "name": "Agent Performance Report",
				"description": "Daily KPI summary per agent: contacts, PTPs, collected, target achievement"},
			// Service
			{"key": "service-performance", "group": "Service", "name": "Service Performance Report",
				"description": "Tickets by channel, status and agent; SLA breaches, CSAT and call volumes"},
			// Operations
			{"key": "settlement-recon", "group": "Operations", "name": "Settlement Reconciliation Report",
				"description": "Approved/disbursed loans vs repayments received"},
			{"key": "customer-statement", "group": "Operations", "name": "Customer Statement",
				"description": "Account details + transaction history for a given CIF (requires a CIF)"},
			{"key": "audit-trail-export", "group": "Compliance", "name": "Audit Trail",
				"description": "Paginated full audit trail (requires audit_export permission)"},
		}
		respond(w, reports, "static")
	}
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

		// Disbursements from LOS
		disbRows, _ := db.PGQuery(ctx,
			`SELECT product_type,
			        COUNT(*) AS loans_booked,
			        COALESCE(SUM(amount_approved_kobo),0) AS total_disbursed_kobo
			 FROM loan_applications
			 WHERE status IN ('booked','active','repaying')
			   AND booked_at::date BETWEEN $1 AND $2
			 GROUP BY product_type ORDER BY total_disbursed_kobo DESC`,
			dateFrom, dateTo)

		// Total disbursements KPI
		disbKPI, _ := db.PGQuery(ctx,
			`SELECT COUNT(*) AS loans_booked,
			        COALESCE(SUM(amount_approved_kobo),0) AS total_disbursed_kobo
			 FROM loan_applications
			 WHERE status IN ('booked','active','repaying')
			   AND booked_at::date BETWEEN $1 AND $2`,
			dateFrom, dateTo)

		// Collections total (DualQuery — MSSQL or PG)
		var f Filter
		f.Date("Date", `"Date"`, dateFrom, dateTo)
		collTotal, src2, _ := db.DualScalar(ctx, "val",
			fmt.Sprintf(`SELECT COALESCE(SUM("Amount"),0) AS val FROM "Collections Log" WHERE 1=1%s`, f.PG()),
			f.Args()...)

		// Recoveries total
		var rf Filter
		rf.Date("[Recovery Date]", `"Recovery Date"`, dateFrom, dateTo)
		recovTotal, src3, _ := db.DualScalar(ctx, "val",
			fmt.Sprintf(`SELECT COALESCE(SUM("Recovery Amount"),0) AS val FROM "Recovery Master Sheet" WHERE 1=1%s`, rf.PG()),
			rf.Args()...)

		// Active loans and NPL count from snapshot
		nplRows, _ := db.PGQuery(ctx,
			`SELECT total_loans, total_npls_kobo, total_outstanding_kobo, npl_ratio_bps FROM (`+cbsSnapshotLiveSQL+`) s`)

		result := map[string]any{
			"date_from":         dateFrom,
			"date_to":           dateTo,
			"new_accounts":      newAccounts,
			"disbursements":     disbRows,
			"total_collections": collTotal,
			"total_recoveries":  recovTotal,
		}
		if len(disbKPI) > 0 {
			result["disbursements_total"] = disbKPI[0]
		}
		if len(nplRows) > 0 {
			result["portfolio_snapshot"] = nplRows[0]
		}

		sources := []string{src1, src2, src3}
		respond(w, result, pickSource(sources))
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
			"date_from":     dateFrom,
			"date_to":       dateTo,
			"by_agent":      agentRows,
			"by_dpd_bucket": bucketRows,
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

		// Disbursements side
		disbRows, _ := db.PGQuery(ctx,
			`SELECT product_type,
			        COUNT(*) AS loan_count,
			        COALESCE(SUM(amount_approved_kobo),0) AS disbursed_kobo
			 FROM loan_applications
			 WHERE booked_at::date BETWEEN $1 AND $2
			   AND status NOT IN ('draft','pending','declined','cancelled')
			 GROUP BY product_type ORDER BY disbursed_kobo DESC`,
			dateFrom, dateTo)

		// Repayments side (DualQuery)
		var f Filter
		f.Date("Repayment_Date", `"Date"`, dateFrom, dateTo)
		collRows, collSrc, _ := db.DualQuery(ctx,
			fmt.Sprintf(`SELECT "Agent",
			        COALESCE(SUM("Amount"),0) AS collected_total,
			        COUNT(*) AS payment_count
			 FROM "Collections Log" WHERE 1=1%s
			 GROUP BY "Agent" ORDER BY collected_total DESC`, f.PG()),
			f.Args()...)

		// Totals
		disbTotal, _ := db.PGQuery(ctx,
			`SELECT COALESCE(SUM(amount_approved_kobo),0) AS disbursed_kobo
			 FROM loan_applications
			 WHERE booked_at::date BETWEEN $1 AND $2
			   AND status NOT IN ('draft','pending','declined','cancelled')`,
			dateFrom, dateTo)

		collTotal, _, _ := db.DualScalar(ctx, "val",
			fmt.Sprintf(`SELECT COALESCE(SUM("Amount"),0) AS val FROM "Collections Log" WHERE 1=1%s`, f.PG()),
			f.Args()...)

		// Open exposure: disbursed but not yet fully repaid
		exposureRows, _ := db.PGQuery(ctx,
			`SELECT la.reference, la.applicant_cif, la.product_type,
			        la.amount_approved_kobo                              AS disbursed_kobo,
			        COALESCE(SUM(rp.amount_kobo),0)                     AS repaid_kobo,
			        la.amount_approved_kobo - COALESCE(SUM(rp.amount_kobo),0) AS open_exposure_kobo
			 FROM loan_applications la
			 LEFT JOIN loan_repayments rp ON rp.application_id = la.id
			 WHERE la.booked_at::date BETWEEN $1 AND $2
			   AND la.status NOT IN ('draft','pending','declined','cancelled')
			 GROUP BY la.id
			 HAVING la.amount_approved_kobo - COALESCE(SUM(rp.amount_kobo),0) > 0
			 ORDER BY open_exposure_kobo DESC
			 LIMIT 100`,
			dateFrom, dateTo)

		result := map[string]any{
			"date_from":         dateFrom,
			"date_to":           dateTo,
			"disbursements":     disbRows,
			"collections":       collRows,
			"total_collections": collTotal,
			"open_exposure":     exposureRows,
		}
		if len(disbTotal) > 0 {
			result["total_disbursed_kobo"] = disbTotal[0]["disbursed_kobo"]
		}
		respond(w, result, pickSource([]string{collSrc}))
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
			 WHERE u.role IN ('collections_agent','collections')
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
		respond(w, rows, "pg")
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
			"date_from":    dateFrom,
			"date_to":      dateTo,
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
		if v := r.URL.Query().Get("from"); v != "" {
			dateFrom = v
		}
		if v := r.URL.Query().Get("to"); v != "" {
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

		// Total disbursed in period
		if rows, _ := db.PGQuery(ctx,
			`SELECT COALESCE(SUM(disbursed_amount_kobo),0) AS val
			 FROM loan_applications
			 WHERE status IN ('disbursed','active') AND disbursed_at IS NOT NULL
			   AND disbursed_at::date BETWEEN $1::date AND $2::date`,
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

		// Collection rate
		out["collection_rate_pct"] = 0.0
		if rows, _ := db.PGQuery(ctx,
			`SELECT COALESCE(SUM(amount_collected_kobo),0) AS collected,
			        COALESCE(SUM(target_amount_kobo),0)    AS target
			 FROM collections_daily_kpi
			 WHERE kpi_date BETWEEN $1::date AND $2::date`,
			dateFrom, dateTo); len(rows) > 0 {
			target := toFloat(rows[0]["target"])
			if target > 0 {
				out["collection_rate_pct"] = round1(toFloat(rows[0]["collected"]) / target * 100)
			}
		}

		// Recovery rate
		out["recovery_rate_pct"] = 0.0
		if rows, _ := db.PGQuery(ctx,
			`SELECT COUNT(*) FILTER (WHERE status='recovered') AS recovered, COUNT(*) AS total
			 FROM recovery_cases
			 WHERE created_at::date BETWEEN $1::date AND $2::date`,
			dateFrom, dateTo); len(rows) > 0 {
			total := toFloat(rows[0]["total"])
			if total > 0 {
				out["recovery_rate_pct"] = round1(toFloat(rows[0]["recovered"]) / total * 100)
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
			npl AS (
			  SELECT DATE_TRUNC('month', snapshot_date)::date AS m,
			    ROUND(AVG(CASE WHEN outstanding_principal_kobo > 0
			                   THEN 100.0 * npl_kobo / outstanding_principal_kobo ELSE 0 END), 2) AS ratio
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
			  COALESCE(n.ratio, 0)                AS npl_ratio_pct,
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

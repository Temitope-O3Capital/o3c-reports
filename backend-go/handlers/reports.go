package handlers

import (
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// reportExportAllowed returns true if the caller's role may export report data.
// H12: Exports contain sensitive financial data; restrict to finance/compliance leadership.
var reportExportRoles = map[string]bool{
	"admin":            true,
	"finance_head":     true,
	"cfo":              true,
	"coo":              true,
	"md":               true,
	"compliance_head":  true,
	"it_admin":         true,
}

func reportExportAllowed(r *http.Request) bool {
	user := core.UserFromCtx(r.Context())
	return user != nil && reportExportRoles[user.Role]
}

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
}

// reportsList returns metadata for all available report types.
func reportsList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		reports := []map[string]any{
			{"key": "monthly-business", "name": "Monthly Business Report", "description": "New accounts, disbursements, collections, recoveries, NPL — grouped by product"},
			{"key": "loan-portfolio", "name": "Loan Portfolio Report", "description": "All loans: status, amounts, tenor, interest rate distribution, top 10 by outstanding"},
			{"key": "collections-performance", "name": "Collections Performance Report", "description": "Agent contact attempts, PTP count, kept rate, amount vs target by agent and DPD bucket"},
			{"key": "settlement-recon", "name": "Settlement Reconciliation Report", "description": "Approved/disbursed loans vs repayments received"},
			{"key": "agent-performance", "name": "Agent Performance Report", "description": "Daily KPI summary per agent: contacts, PTPs, collected, target achievement"},
			{"key": "customer-statement", "name": "Customer Statement", "description": "Account details + 90-day transaction history for a given CIF (?cif=)"},
			{"key": "audit-trail-export", "name": "Audit Trail Export", "description": "Paginated full audit trail (requires audit_export permission)"},
			{"key": "npl-return", "name": "CBN NPL Return", "description": "Loans by DPD bucket, NPL ratio, provisions, write-offs"},
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
			fmt.Sprintf(`SELECT Product_Name AS product_type, COUNT(DISTINCT CIF_Number) AS new_accounts
			 FROM dbo.Account
			 WHERE CAST(Account_Created AS DATE) BETWEEN @p1 AND @p2
			 GROUP BY Product_Name ORDER BY new_accounts DESC`),
			fmt.Sprintf(`SELECT "Product Name" AS product_type, COUNT(DISTINCT "CIF Number") AS new_accounts
			 FROM "Products"
			 WHERE "Account Created Date"::date BETWEEN $1 AND $2
			 GROUP BY "Product Name" ORDER BY new_accounts DESC`),
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
			fmt.Sprintf("SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.o3_loan_Repayment WHERE 1=1%s", f.MS()),
			fmt.Sprintf(`SELECT COALESCE(SUM("Amount"),0) AS val FROM "Collections Log" WHERE 1=1%s`, f.PG()),
			f.Args()...)

		// Recoveries total
		var rf Filter
		rf.Date("[Recovery Date]", `"Recovery Date"`, dateFrom, dateTo)
		recovTotal, src3, _ := db.DualScalar(ctx, "val",
			fmt.Sprintf("SELECT ISNULL(SUM([Recovery Amount]),0) AS val FROM dbo.RecoveryMasterSheet WHERE 1=1%s", rf.MS()),
			fmt.Sprintf(`SELECT COALESCE(SUM("Recovery Amount"),0) AS val FROM "Recovery Master Sheet" WHERE 1=1%s`, rf.PG()),
			rf.Args()...)

		// Active loans and NPL count from snapshot
		nplRows, _ := db.PGQuery(ctx,
			`SELECT total_loans, total_npls_kobo, total_outstanding_kobo, npl_ratio_bps
			 FROM portfolio_daily_snapshot ORDER BY snapshot_date DESC LIMIT 1`)

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
		if qstr(r, "format") == "csv" {
			if !reportExportAllowed(r) {
				respondErr(w, 403, "Insufficient permissions to export reports")
				return
			}
			// Flatten disbursements for CSV
			streamCSV(w, fmt.Sprintf("monthly_business_%s_%s.csv", dateFrom, dateTo), disbRows)
			return
		}
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
			respondErr(w, 500, "Query failed")
			return
		}

		// By product type
		productRows, _ := db.PGQuery(ctx,
			fmt.Sprintf(`SELECT product_type, COUNT(*) AS count,
			        COALESCE(AVG(tenor_months),0) AS avg_tenor_months,
			        COALESCE(SUM(amount_approved_kobo),0) AS total_approved_kobo
			 FROM loan_applications %s GROUP BY product_type ORDER BY total_approved_kobo DESC`, where),
			args...)

		// Top 10 by outstanding (DPD snapshot)
		top10Rows, _ := db.PGQuery(ctx,
			`SELECT cif_number, outstanding_kobo, dpd, dpd_bucket
			 FROM loan_dpd_daily_snapshot
			 WHERE snapshot_date=(SELECT MAX(snapshot_date) FROM loan_dpd_daily_snapshot)
			 ORDER BY outstanding_kobo DESC LIMIT 10`)

		result := map[string]any{
			"status_breakdown":  statusRows,
			"by_product_type":   productRows,
			"top10_outstanding": top10Rows,
		}

		if qstr(r, "format") == "csv" {
			if !reportExportAllowed(r) {
				respondErr(w, 403, "Insufficient permissions to export reports")
				return
			}
			streamCSV(w, fmt.Sprintf("loan_portfolio_%s_%s.csv", coalesce(dateFrom, "all"), coalesce(dateTo, "all")), statusRows)
			return
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
			respondErr(w, 500, "Query failed")
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

		if qstr(r, "format") == "csv" {
			if !reportExportAllowed(r) {
				respondErr(w, 403, "Insufficient permissions to export reports")
				return
			}
			streamCSV(w, fmt.Sprintf("collections_performance_%s_%s.csv", dateFrom, dateTo), agentRows)
			return
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
			fmt.Sprintf(`SELECT Rn_Create_User AS agent,
			        ISNULL(SUM(Amount),0) AS collected_total,
			        COUNT(*) AS payment_count
			 FROM dbo.o3_loan_Repayment WHERE 1=1%s
			 GROUP BY Rn_Create_User ORDER BY collected_total DESC`, f.MS()),
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
			fmt.Sprintf("SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.o3_loan_Repayment WHERE 1=1%s", f.MS()),
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

		if qstr(r, "format") == "csv" {
			if !reportExportAllowed(r) {
				respondErr(w, 403, "Insufficient permissions to export reports")
				return
			}
			streamCSV(w, fmt.Sprintf("settlement_recon_%s_%s.csv", dateFrom, dateTo), collRows)
			return
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
			respondErr(w, 500, "Query failed")
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

		if qstr(r, "format") == "csv" {
			if !reportExportAllowed(r) {
				respondErr(w, 403, "Insufficient permissions to export reports")
				return
			}
			streamCSV(w, fmt.Sprintf("agent_performance_%s_%s.csv", dateFrom, dateTo), rows)
			return
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

		if qstr(r, "format") == "csv" {
			streamCSV(w, fmt.Sprintf("statement_%s_%s_%s.csv", cif, dateFrom, dateTo), statement.Transactions)
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
			respondErr(w, 500, "Query failed")
			return
		}

		if qstr(r, "format") == "csv" {
			streamCSV(w, fmt.Sprintf("audit_trail_%s_%s.csv",
				coalesce(dateFrom, "all"), coalesce(dateTo, "all")), rows)
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
			        npl_ratio_bps, par30_kobo, par60_kobo, par90_kobo
			 FROM portfolio_daily_snapshot ORDER BY snapshot_date DESC LIMIT 1`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}

		// DPD bucket summary from most recent snapshot
		bucketRows, _ := db.PGQuery(ctx,
			`SELECT dpd_bucket,
			        COUNT(*) AS loan_count,
			        COALESCE(SUM(outstanding_kobo),0) AS outstanding_kobo
			 FROM loan_dpd_daily_snapshot
			 WHERE snapshot_date=(SELECT MAX(snapshot_date) FROM loan_dpd_daily_snapshot)
			 GROUP BY dpd_bucket ORDER BY dpd_bucket`)

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

		// Tiered CBN provision rates from DPD snapshot
		bucketProvRows, _ := db.PGQuery(ctx, `
			SELECT
				SUM(CASE WHEN dpd_bucket='1-30'  THEN outstanding_kobo * 0.01 ELSE 0 END) AS prov_watch,
				SUM(CASE WHEN dpd_bucket='31-60' THEN outstanding_kobo * 0.10 ELSE 0 END) AS prov_substandard,
				SUM(CASE WHEN dpd_bucket='61-90' THEN outstanding_kobo * 0.50 ELSE 0 END) AS prov_doubtful,
				SUM(CASE WHEN dpd_bucket='90+'   THEN outstanding_kobo * 1.00 ELSE 0 END) AS prov_lost
			FROM loan_dpd_daily_snapshot
			WHERE snapshot_date=(SELECT MAX(snapshot_date) FROM loan_dpd_daily_snapshot)
		`)
		if len(bucketProvRows) > 0 {
			watchKobo := toFloat(bucketProvRows[0]["prov_watch"])
			subKobo := toFloat(bucketProvRows[0]["prov_substandard"])
			doubtKobo := toFloat(bucketProvRows[0]["prov_doubtful"])
			lostKobo := toFloat(bucketProvRows[0]["prov_lost"])
			totalProv := watchKobo + subKobo + doubtKobo + lostKobo
			snapshot["provision_watch_kobo"] = int64(watchKobo)
			snapshot["provision_substandard_kobo"] = int64(subKobo)
			snapshot["provision_doubtful_kobo"] = int64(doubtKobo)
			snapshot["provision_lost_kobo"] = int64(lostKobo)
			snapshot["provision_total_kobo"] = int64(totalProv)
		}

		result := map[string]any{
			"report_date": dateTo,
			"snapshot":    snapshot,
			"dpd_buckets": bucketRows,
		}
		if len(writeOffRows) > 0 {
			result["write_offs_in_period"] = writeOffRows[0]
		}

		if qstr(r, "format") == "csv" {
			if !reportExportAllowed(r) {
				respondErr(w, 403, "Insufficient permissions to export reports")
				return
			}
			streamCSV(w, fmt.Sprintf("npl_return_%s.csv", dateTo), bucketRows)
			return
		}
		respond(w, result, "pg")
	}
}

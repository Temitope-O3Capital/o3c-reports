package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

func RegisterRecovery(r chi.Router, db *core.DB) {
	r.Use(core.RequirePages("recovery"))
	r.Get("/kpis", recoveryKPIs(db))
	r.Get("/by-method", recoveryByMethod(db))
	r.Get("/by-channel", recoveryByChannel(db))
	r.Get("/by-agent", recoveryByAgent(db))
	r.Get("/monthly-trend", recoveryMonthlyTrend(db))
	r.Get("/cases", recoveryCases(db))
	r.Get("/export", recoveryExport(db))
	r.Get("/legal", recoveryLegal(db))
	r.Get("/legal-kpis", recoveryLegalKPIs(db))
	r.Get("/cases/{id}/legal-milestones", recoveryLegalMilestones(db))
	r.Post("/cases/{id}/legal-milestone", recoveryAddLegalMilestone(db))
	r.Get("/tpa-agencies", recoveryTPAAgencies(db))
	r.Post("/tpa-agencies", recoveryCreateTPAAgency(db))
	r.Put("/tpa-agencies/{id}", recoveryUpdateTPAAgency(db))
	r.Get("/tpa-agencies/{id}/accounts", recoveryTPAAgencyAccounts(db))
	r.Get("/tpa-agencies/{id}/performance", recoveryTPAAgencyPerformance(db))
	r.Get("/debt-sales", recoveryDebtSales(db))
	r.Post("/debt-sales", recoveryCreateDebtSale(db))
	r.Delete("/debt-sales/{id}", recoveryDeleteDebtSale(db))
}

func recoveryKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		kpis := map[string]any{}
		var sources []string

		type spec struct{ key, ms, pg string }
		for _, s := range []spec{
			{"total_recovered",
				"SELECT ISNULL(SUM([Recovery Amount]),0) AS val FROM dbo.RecoveryMasterSheet",
				`SELECT COALESCE(SUM("Recovery Amount"),0) AS val FROM "Recovery Master Sheet"`},
			{"accounts_in_legal",
				"SELECT COUNT(DISTINCT [CIF Number]) AS val FROM dbo.RecoveryMasterSheet WHERE [Legal Stage] IS NOT NULL",
				`SELECT COUNT(DISTINCT "CIF Number") AS val FROM "Recovery Master Sheet" WHERE "Legal Stage" IS NOT NULL`},
			{"recovery_mtd",
				"SELECT ISNULL(SUM([Recovery Amount]),0) AS val FROM dbo.RecoveryMasterSheet WHERE MONTH([Recovery Date])=MONTH(GETDATE()) AND YEAR([Recovery Date])=YEAR(GETDATE())",
				`SELECT COALESCE(SUM("Recovery Amount"),0) AS val FROM "Recovery Master Sheet" WHERE DATE_TRUNC('month',"Recovery Date")=DATE_TRUNC('month',CURRENT_DATE)`},
			{"open_cases",
				"SELECT COUNT(DISTINCT [CIF Number]) AS val FROM dbo.RecoveryMasterSheet WHERE [Status] IS NULL OR [Status] NOT IN ('Recovered','Paid','Closed')",
				`SELECT COUNT(DISTINCT "CIF Number") AS val FROM "Recovery Master Sheet" WHERE "Status" IS NULL OR "Status" NOT IN ('Recovered','Paid','Closed')`},
		} {
			val, src, err := db.DualScalar(ctx, "val", s.ms, s.pg)
			if err != nil {
				respondErr(w, 500, "Query failed: "+s.key)
				return
			}
			kpis[s.key] = val
			sources = append(sources, src)
		}

		// CBN recovery rate = total_recovered / total_npl_book_value * 100
		// (CBN supervisory framework: recoveries as % of gross NPL balance)
		nplBalance, _, _ := db.DualScalar(ctx, "val",
			"SELECT ISNULL(SUM([Outstanding Balance]),0) AS val FROM dbo.RecoveryMasterSheet",
			`SELECT COALESCE(SUM("Outstanding Balance"),0) AS val FROM "Recovery Master Sheet"`)
		if toFloat(nplBalance) > 0 {
			kpis["recovery_rate"] = round1(toFloat(kpis["total_recovered"]) / toFloat(nplBalance) * 100)
		} else {
			kpis["recovery_rate"] = 0.0
		}
		kpis["total_npl_balance"] = nplBalance

		respond(w, kpis, pickSource(sources))
	}
}

func recoveryByMethod(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, src, err := db.DualQuery(r.Context(),
			`SELECT [Recovery Method], ISNULL(SUM([Recovery Amount]),0) AS total, COUNT(*) AS count
			 FROM dbo.RecoveryMasterSheet GROUP BY [Recovery Method] ORDER BY total DESC`,
			`SELECT "Recovery Method", COALESCE(SUM("Recovery Amount"),0) AS total, COUNT(*) AS count
			 FROM "Recovery Master Sheet" GROUP BY "Recovery Method" ORDER BY total DESC`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		respond(w, data, src)
	}
}

func recoveryMonthlyTrend(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, src, err := db.DualQuery(r.Context(),
			`SELECT FORMAT([Recovery Date],'MMM yyyy') AS month,
			        DATEFROMPARTS(YEAR([Recovery Date]),MONTH([Recovery Date]),1) AS month_sort,
			        ISNULL(SUM([Recovery Amount]),0) AS total
			 FROM dbo.RecoveryMasterSheet
			 GROUP BY DATEFROMPARTS(YEAR([Recovery Date]),MONTH([Recovery Date]),1),
			          FORMAT([Recovery Date],'MMM yyyy')
			 ORDER BY month_sort`,
			`SELECT TO_CHAR(DATE_TRUNC('month',"Recovery Date"),'Mon YYYY') AS month,
			        DATE_TRUNC('month',"Recovery Date") AS month_sort,
			        COALESCE(SUM("Recovery Amount"),0) AS total
			 FROM "Recovery Master Sheet"
			 GROUP BY DATE_TRUNC('month',"Recovery Date") ORDER BY month_sort`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		respond(w, data, src)
	}
}

func recoveryCases(db *core.DB) http.HandlerFunc {
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
		limit := qint(r, "limit", 200, 1, 1000)

		var f Filter
		f.Date("r.[Recovery Date]", `r."Recovery Date"`, dateFrom, dateTo)

		data, src, err := db.DualQuery(r.Context(),
			fmt.Sprintf(`SELECT TOP %d
			        r.[CIF Number], a.First_Name AS [First Name], a.Last_Name AS [Last Name],
			        r.[Recovery Amount], r.[Recovery Method], r.[Legal Stage],
			        r.Agent, r.Status, r.[Recovery Date]
			 FROM dbo.RecoveryMasterSheet r
			 LEFT JOIN dbo.Contact a ON r.[CIF Number]=a.CIF
			 WHERE 1=1%s ORDER BY r.[Recovery Date] DESC`, limit, f.MS()),
			fmt.Sprintf(`SELECT r."CIF Number", a."First Name", a."Last Name",
			        r."Recovery Amount", r."Recovery Method", r."Legal Stage",
			        r."Agent", r."Status", r."Recovery Date"
			 FROM "Recovery Master Sheet" r
			 LEFT JOIN "Accounts" a ON r."CIF Number"=a."CIF Number"
			 WHERE 1=1%s ORDER BY r."Recovery Date" DESC LIMIT %d`, f.PG(), limit),
			f.Args()...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		respond(w, data, src)
	}
}

func recoveryExport(db *core.DB) http.HandlerFunc {
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
		var f Filter
		f.Date("r.[Recovery Date]", `r."Recovery Date"`, dateFrom, dateTo)
		data, _, err := db.DualQuery(r.Context(),
			fmt.Sprintf(`SELECT r.[CIF Number], a.First_Name AS [First Name], a.Last_Name AS [Last Name],
			        r.[Recovery Amount], r.[Recovery Method], r.[Legal Stage],
			        r.Agent, r.Status, r.[Recovery Date]
			 FROM dbo.RecoveryMasterSheet r
			 LEFT JOIN dbo.Contact a ON r.[CIF Number]=a.CIF
			 WHERE 1=1%s ORDER BY r.[Recovery Date] DESC`, f.MS()),
			fmt.Sprintf(`SELECT r."CIF Number", a."First Name", a."Last Name",
			        r."Recovery Amount", r."Recovery Method", r."Legal Stage",
			        r."Agent", r."Status", r."Recovery Date"
			 FROM "Recovery Master Sheet" r
			 LEFT JOIN "Accounts" a ON r."CIF Number"=a."CIF Number"
			 WHERE 1=1%s ORDER BY r."Recovery Date" DESC`, f.PG()),
			f.Args()...)
		if err != nil {
			respondErr(w, 500, "Export failed")
			return
		}
		name := fmt.Sprintf("recovery_%s_%s.csv",
			coalesce(dateFrom, "all"), coalesce(dateTo, "all"))
		streamCSV(w, name, data)
	}
}

// ── New endpoints ─────────────────────────────────────────────────────────────

// recoveryByChannel aggregates recovered amounts by payment channel.
// Uses recovery_payments.channel, which is PG-only.
func recoveryByChannel(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT channel,
			       COALESCE(SUM(amount_kobo), 0) AS amount_kobo,
			       ROUND(
			           100.0 * SUM(amount_kobo)
			               / NULLIF(SUM(SUM(amount_kobo)) OVER (), 0),
			           1
			       ) AS pct
			FROM recovery_payments
			GROUP BY channel
			ORDER BY amount_kobo DESC`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

// recoveryByAgent aggregates case counts and recovered totals per assigned agent.
func recoveryByAgent(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT
			    COALESCE(u.full_name, 'Unassigned') AS agent_name,
			    COUNT(rc.id) AS case_count,
			    COALESCE(SUM(rc.recovered_kobo), 0) AS recovered_kobo,
			    ROUND(
			        100.0
			            * COUNT(*) FILTER (WHERE rc.status = 'closed')
			            / NULLIF(COUNT(*), 0),
			        1
			    ) AS success_rate_pct
			FROM recovery_cases rc
			LEFT JOIN o3c_users u ON rc.assigned_agent_id = u.id
			GROUP BY u.full_name
			ORDER BY recovered_kobo DESC`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

// recoveryLegal lists recovery cases that have entered the legal stage.
func recoveryLegal(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := qint(r, "limit", 200, 1, 1000)
		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT
			    rc.id,
			    rc.account_cif,
			    rc.outstanding_kobo,
			    rc.legal_stage AS current_milestone,
			    lp.court_name AS solicitor,
			    lp.next_hearing_date AS next_court_date,
			    EXTRACT(DAY FROM NOW() - rc.opened_at)::int AS days_in_legal
			FROM recovery_cases rc
			LEFT JOIN LATERAL (
			    SELECT court_name, next_hearing_date
			    FROM legal_proceedings
			    WHERE case_id = rc.id
			    ORDER BY filing_date DESC
			    LIMIT 1
			) lp ON true
			WHERE rc.legal_stage IS NOT NULL
			ORDER BY rc.updated_at DESC
			LIMIT %d`, limit))
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

// recoveryLegalKPIs returns aggregate KPIs for cases in legal.
func recoveryLegalKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT
			    COUNT(DISTINCT rc.id) AS total_cases,
			    COUNT(*) FILTER (WHERE lp.outcome = 'won') AS won,
			    ROUND(AVG(
			        EXTRACT(DAY FROM COALESCE(rc.closed_at, NOW()) - rc.opened_at)
			    ))::int AS avg_days
			FROM recovery_cases rc
			LEFT JOIN legal_proceedings lp ON lp.case_id = rc.id
			WHERE rc.legal_stage IS NOT NULL`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		kpis := core.Row{"total_cases": 0, "won": 0, "avg_days": 0}
		if len(rows) > 0 {
			kpis = rows[0]
		}
		respond(w, kpis, "pg")
	}
}

// recoveryLegalMilestones lists legal proceedings for a case, shaped as milestones.
func recoveryLegalMilestones(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid case ID")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT
			    id,
			    proceeding_type AS milestone_type,
			    filing_date AS milestone_date,
			    notes,
			    (status NOT IN ('active', 'pending') OR status IS NULL) AS completed
			FROM legal_proceedings
			WHERE case_id = $1
			ORDER BY filing_date ASC`, id)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

// recoveryAddLegalMilestone inserts a new legal proceeding milestone for a case.
func recoveryAddLegalMilestone(db *core.DB) http.HandlerFunc {
	type body struct {
		MilestoneType string `json:"milestone_type"`
		MilestoneDate string `json:"milestone_date"`
		Notes         string `json:"notes"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid case ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.MilestoneType == "" || b.MilestoneDate == "" {
			respondErr(w, 422, "milestone_type and milestone_date are required")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO legal_proceedings
			    (case_id, proceeding_type, filing_date, notes, status, created_at)
			VALUES ($1, $2, $3, $4, 'active', NOW())
			RETURNING id,
			          proceeding_type AS milestone_type,
			          filing_date AS milestone_date,
			          notes,
			          status`,
			id, b.MilestoneType, b.MilestoneDate, b.Notes)
		if err != nil {
			respondErr(w, 500, "Insert failed")
			return
		}
		if len(rows) == 0 {
			respondErr(w, 500, "Insert returned no result")
			return
		}
		respond(w, rows[0], "pg")
	}
}

// ── TPA (Third-Party Agency) endpoints ───────────────────────────────────────
// The tpa_agencies table may not exist yet. PGQuery handles missing tables by
// returning empty rows, so GETs degrade gracefully. For mutations, an error from
// a missing table is caught and surfaced as a 422 with a clear message.

func recoveryTPAAgencies(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT
			    ta.id,
			    ta.name,
			    ta.licence_number,
			    ta.contact_name,
			    ta.contact_phone,
			    ta.commission_pct,
			    COUNT(rc.id) AS accounts_assigned,
			    COALESCE(SUM(rc.recovered_kobo), 0) AS recovered_kobo,
			    ROUND(COALESCE(SUM(rc.recovered_kobo), 0) * ta.commission_pct / 100.0) AS commission_accrued_kobo,
			    ta.active
			FROM tpa_agencies ta
			LEFT JOIN recovery_cases rc ON rc.tpa_agency_id = ta.id
			GROUP BY ta.id, ta.name, ta.licence_number, ta.contact_name,
			         ta.contact_phone, ta.commission_pct, ta.active
			ORDER BY ta.name`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

func recoveryCreateTPAAgency(db *core.DB) http.HandlerFunc {
	type body struct {
		Name          string  `json:"name"`
		LicenceNumber string  `json:"licence_number"`
		Address       string  `json:"address"`
		CommissionPct float64 `json:"commission_pct"`
		ContactName   string  `json:"contact_name"`
		ContactPhone  string  `json:"contact_phone"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Name == "" {
			respondErr(w, 422, "name is required")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO tpa_agencies
			    (name, licence_number, address, commission_pct, contact_name, contact_phone, active, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, true, NOW())
			RETURNING id, name, licence_number, contact_name, contact_phone, commission_pct, active`,
			b.Name, b.LicenceNumber, b.Address, b.CommissionPct, b.ContactName, b.ContactPhone)
		if err != nil {
			respondErr(w, 500, "Insert failed")
			return
		}
		if len(rows) == 0 {
			respondErr(w, 422, "tpa_agencies table not provisioned — run migration to enable TPA tracking")
			return
		}
		respond(w, rows[0], "pg")
	}
}

func recoveryUpdateTPAAgency(db *core.DB) http.HandlerFunc {
	type body struct {
		Name          string  `json:"name"`
		LicenceNumber string  `json:"licence_number"`
		Address       string  `json:"address"`
		CommissionPct float64 `json:"commission_pct"`
		ContactName   string  `json:"contact_name"`
		ContactPhone  string  `json:"contact_phone"`
		Active        *bool   `json:"active"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid agency ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		active := true
		if b.Active != nil {
			active = *b.Active
		}
		rows, err := db.PGQuery(r.Context(), `
			UPDATE tpa_agencies
			SET name = $1, licence_number = $2, address = $3, commission_pct = $4,
			    contact_name = $5, contact_phone = $6, active = $7, updated_at = NOW()
			WHERE id = $8
			RETURNING id, name, licence_number, contact_name, contact_phone, commission_pct, active`,
			b.Name, b.LicenceNumber, b.Address, b.CommissionPct, b.ContactName, b.ContactPhone, active, id)
		if err != nil {
			respondErr(w, 500, "Update failed")
			return
		}
		if len(rows) == 0 {
			respondErr(w, 404, "Agency not found or tpa_agencies table not provisioned")
			return
		}
		respond(w, rows[0], "pg")
	}
}

func recoveryTPAAgencyAccounts(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid agency ID")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT
			    rc.account_cif,
			    rc.outstanding_kobo,
			    rc.status
			FROM recovery_cases rc
			WHERE rc.tpa_agency_id = $1
			ORDER BY rc.outstanding_kobo DESC`, id)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

func recoveryTPAAgencyPerformance(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid agency ID")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT
			    COUNT(rc.id) AS cases_assigned,
			    COALESCE(SUM(rc.recovered_kobo), 0) AS recovered_kobo,
			    ROUND(
			        100.0
			            * COUNT(*) FILTER (WHERE rc.status = 'closed')
			            / NULLIF(COUNT(*), 0),
			        1
			    ) AS success_rate_pct,
			    ROUND(
			        COALESCE(SUM(rc.recovered_kobo), 0)
			            * MAX(ta.commission_pct) / 100.0
			    ) AS commission_accrued_kobo
			FROM recovery_cases rc
			JOIN tpa_agencies ta ON ta.id = rc.tpa_agency_id
			WHERE rc.tpa_agency_id = $1`, id)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		perf := core.Row{
			"cases_assigned":        0,
			"recovered_kobo":        0,
			"success_rate_pct":      0.0,
			"commission_accrued_kobo": 0,
		}
		if len(rows) > 0 {
			perf = rows[0]
		}
		respond(w, perf, "pg")
	}
}

func recoveryDebtSales(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT id, buyer_name, sale_date, account_count,
			       face_value_kobo, sale_price_kobo, recovery_post_sale_kobo,
			       notes, created_at
			FROM debt_sales
			ORDER BY sale_date DESC`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

func recoveryCreateDebtSale(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			BuyerName           string `json:"buyer_name"`
			SaleDate            string `json:"sale_date"`
			AccountCount        int    `json:"account_count"`
			FaceValueKobo       int64  `json:"face_value_kobo"`
			SalePriceKobo       int64  `json:"sale_price_kobo"`
			RecoveryPostSaleKobo int64 `json:"recovery_post_sale_kobo"`
			Notes               string `json:"notes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if body.BuyerName == "" || body.SaleDate == "" {
			respondErr(w, 422, "buyer_name and sale_date are required")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO debt_sales
			    (buyer_name, sale_date, account_count, face_value_kobo,
			     sale_price_kobo, recovery_post_sale_kobo, notes)
			VALUES ($1,$2,$3,$4,$5,$6,$7)
			RETURNING id, buyer_name, sale_date, account_count,
			          face_value_kobo, sale_price_kobo, recovery_post_sale_kobo,
			          notes, created_at`,
			body.BuyerName, body.SaleDate, body.AccountCount,
			body.FaceValueKobo, body.SalePriceKobo, body.RecoveryPostSaleKobo,
			nullStr(body.Notes))
		if err != nil {
			respondErr(w, 500, "Insert failed")
			return
		}
		if len(rows) == 0 {
			respondErr(w, 500, "No row returned")
			return
		}
		respond(w, rows[0], "pg")
	}
}

func recoveryDeleteDebtSale(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		if _, err := strconv.Atoi(id); err != nil {
			respondErr(w, 400, "Invalid id")
			return
		}
		_, err := db.PGQuery(r.Context(), `DELETE FROM debt_sales WHERE id=$1`, id)
		if err != nil {
			respondErr(w, 500, "Delete failed")
			return
		}
		respond(w, map[string]any{"ok": true}, "pg")
	}
}

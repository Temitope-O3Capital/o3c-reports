package handlers

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

func RegisterBusinessDev(r chi.Router, db *core.DB) {
	r.Use(core.RequirePages("bd"))

	r.Get("/employers", bdListEmployers(db))
	r.Post("/employers", bdCreateEmployer(db))
	r.Get("/employers/{id}", bdGetEmployer(db))
	r.Put("/employers/{id}", bdUpdateEmployer(db))

	// Staff roster
	r.Get("/employers/{id}/staff", bdListStaff(db))
	r.Post("/employers/{id}/staff", bdAddStaff(db))
	r.Post("/employers/{id}/staff/import", bdImportStaff(db))
	r.Delete("/employers/{id}/staff/{staff_id}", bdDeleteStaff(db))

	// BD → Sales assignment
	r.Post("/employers/{id}/assign", bdAssignToSales(db))
	r.Get("/assignments", bdListAssignments(db))
	r.Get("/assignments/{id}", bdGetAssignment(db))
	r.Patch("/assignments/{id}", bdUpdateAssignment(db))

	r.Get("/leads", bdListLeads(db))
	r.Post("/leads", bdCreateLead(db))
	r.Post("/leads/import", bdImportLeads(db))
	r.Patch("/leads/{id}", bdUpdateLead(db))
	r.Get("/leads/{id}", bdGetLead(db))
	r.Post("/leads/{id}/activity", bdLogActivity(db))

	r.Get("/stats", bdStats(db))
	r.Get("/pipeline-kpis", bdPipelineKPIs(db))
	r.Get("/sector-analytics", bdSectorAnalytics(db))

	// Agent dashboard
	r.Get("/my-dashboard", bdMyDashboard(db))
}

func bdListEmployers(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		search := qstr(r, "search")
		sector := qstr(r, "sector")
		mou    := qstr(r, "mou_status")
		from   := qstr(r, "from")
		to     := qstr(r, "to")
		limit  := qint(r, "limit", 100, 1, 500)

		q := `SELECT e.id, e.name, e.sector, e.staff_count,
		             e.monthly_payroll_kobo, e.credit_limit_kobo,
		             e.mou_status, e.mou_date, e.mou_expiry,
		             e.contact_name, e.contact_phone, e.contact_email,
		             e.address, e.notes,
		             e.is_active, e.created_at, e.updated_at,
		             COUNT(l.id) AS lead_count
		      FROM employers e
		      LEFT JOIN bd_leads l ON l.employer_id = e.id
		      WHERE 1=1`
		var args []any
		n := 1

		if search != "" {
			q += fmt.Sprintf(" AND e.name ILIKE $%d", n)
			args = append(args, "%"+search+"%")
			n++
		}
		if sector != "" {
			q += fmt.Sprintf(" AND e.sector=$%d", n)
			args = append(args, sector)
			n++
		}
		if mou != "" {
			q += fmt.Sprintf(" AND e.mou_status=$%d", n)
			args = append(args, mou)
			n++
		}
		if from != "" {
			q += fmt.Sprintf(" AND e.created_at::date >= $%d::date", n)
			args = append(args, from); n++
		}
		if to != "" {
			q += fmt.Sprintf(" AND e.created_at::date <= $%d::date", n)
			args = append(args, to); n++
		}
		q += " GROUP BY e.id"
		args = append(args, limit)
		q += fmt.Sprintf(" ORDER BY e.name LIMIT $%d", n)

		rows, err := db.PGQuery(r.Context(), q, args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		jsonRows(w, rows)
	}
}

func bdCreateEmployer(db *core.DB) http.HandlerFunc {
	type body struct {
		Name               string  `json:"name"`
		Sector             *string `json:"sector"`
		StaffCount         *int    `json:"staff_count"`
		MonthlyPayrollKobo *int64  `json:"monthly_payroll_kobo"`
		CreditLimitKobo    *int64  `json:"credit_limit_kobo"`
		MOUStatus          *string `json:"mou_status"`
		MOUDate            *string `json:"mou_date"`
		MOUExpiry          *string `json:"mou_expiry"`
		ContactName        *string `json:"contact_name"`
		ContactPhone       *string `json:"contact_phone"`
		ContactEmail       *string `json:"contact_email"`
		Address            *string `json:"address"`
		Notes              *string `json:"notes"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil || b.Name == "" {
			respondErr(w, 400, "name is required")
			return
		}
		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(),
			`INSERT INTO employers
			 (name, sector, staff_count, monthly_payroll_kobo, credit_limit_kobo,
			  mou_status, mou_date, mou_expiry, contact_name, contact_phone,
			  contact_email, address, notes, created_by)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
			 RETURNING *`,
			b.Name, b.Sector, b.StaffCount, b.MonthlyPayrollKobo, b.CreditLimitKobo,
			b.MOUStatus, b.MOUDate, b.MOUExpiry,
			b.ContactName, b.ContactPhone, b.ContactEmail,
			b.Address, b.Notes, user.ID)
		if err != nil {
			respondErr(w, 500, "Insert failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func bdUpdateEmployer(db *core.DB) http.HandlerFunc {
	type body struct {
		Name               *string `json:"name"`
		Sector             *string `json:"sector"`
		StaffCount         *int    `json:"staff_count"`
		MonthlyPayrollKobo *int64  `json:"monthly_payroll_kobo"`
		CreditLimitKobo    *int64  `json:"credit_limit_kobo"`
		MOUStatus          *string `json:"mou_status"`
		MOUDate            *string `json:"mou_date"`
		MOUExpiry          *string `json:"mou_expiry"`
		ContactName        *string `json:"contact_name"`
		ContactPhone       *string `json:"contact_phone"`
		ContactEmail       *string `json:"contact_email"`
		Address            *string `json:"address"`
		Notes              *string `json:"notes"`
		IsActive           *bool   `json:"is_active"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}

		q := `UPDATE employers SET updated_at=NOW()`
		var args []any
		n := 1
		add := func(col string, v any) {
			q += fmt.Sprintf(", %s=$%d", col, n)
			args = append(args, v)
			n++
		}
		if b.Name != nil {
			add("name", *b.Name)
		}
		if b.Sector != nil {
			add("sector", *b.Sector)
		}
		if b.StaffCount != nil {
			add("staff_count", *b.StaffCount)
		}
		if b.MonthlyPayrollKobo != nil {
			add("monthly_payroll_kobo", *b.MonthlyPayrollKobo)
		}
		if b.CreditLimitKobo != nil {
			add("credit_limit_kobo", *b.CreditLimitKobo)
		}
		if b.MOUStatus != nil {
			add("mou_status", *b.MOUStatus)
		}
		if b.MOUDate != nil {
			add("mou_date", *b.MOUDate)
		}
		if b.MOUExpiry != nil {
			add("mou_expiry", *b.MOUExpiry)
		}
		if b.ContactName != nil {
			add("contact_name", *b.ContactName)
		}
		if b.ContactPhone != nil {
			add("contact_phone", *b.ContactPhone)
		}
		if b.ContactEmail != nil {
			add("contact_email", *b.ContactEmail)
		}
		if b.Address != nil {
			add("address", *b.Address)
		}
		if b.Notes != nil {
			add("notes", *b.Notes)
		}
		if b.IsActive != nil {
			add("is_active", *b.IsActive)
		}

		args = append(args, id)
		q += fmt.Sprintf(" WHERE id=$%d RETURNING *", n)

		rows, err := db.PGQuery(r.Context(), q, args...)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Employer not found")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func bdGetEmployer(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")

		empRows, err := db.PGQuery(r.Context(),
			`SELECT id, name, sector, staff_count,
			        monthly_payroll_kobo, credit_limit_kobo,
			        mou_status, mou_date, mou_expiry,
			        contact_name, contact_phone, contact_email,
			        address, notes, is_active, created_at, updated_at
			 FROM employers WHERE id=$1`, id)
		if err != nil || len(empRows) == 0 {
			respondErr(w, 404, "Employer not found")
			return
		}

		outRows, _ := db.PGQuery(r.Context(),
			`SELECT
			     COUNT(ba.id)                                              AS total_assignments,
			     COALESCE(SUM(ba.staff_count_at_assignment), 0)           AS total_staff_referred,
			     COUNT(cc.id)                                              AS total_crm_contacts,
			     COUNT(CASE WHEN ba.status='converted' THEN 1 END)        AS total_converted
			 FROM bd_assignments ba
			 LEFT JOIN crm_contacts cc ON cc.bd_assignment_id = ba.id
			 WHERE ba.employer_id=$1`, id)

		asgRows, _ := db.PGQuery(r.Context(),
			`SELECT ba.id, ba.assignment_type, ba.status,
			        ba.staff_count_at_assignment, ba.assigned_at,
			        u.full_name AS sales_agent_name,
			        COUNT(cc.id)                                        AS contacts_created,
			        COUNT(CASE WHEN ba.status='converted' THEN 1 END)   AS converted
			 FROM bd_assignments ba
			 LEFT JOIN o3c_users u ON u.id = ba.assigned_to
			 LEFT JOIN crm_contacts cc ON cc.bd_assignment_id = ba.id
			 WHERE ba.employer_id=$1
			 GROUP BY ba.id, u.full_name
			 ORDER BY ba.assigned_at DESC
			 LIMIT 5`, id)

		w.Header().Set("Content-Type", "application/json")
		outcomes := map[string]any{}
		if len(outRows) > 0 {
			outcomes = outRows[0]
		}
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"employer":           empRows[0],
			"outcomes":           outcomes,
			"recent_assignments": asgRows,
		})
	}
}

func bdListLeads(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		stage := qstr(r, "stage")
		assignedTo := qstr(r, "assigned_to")
		search := qstr(r, "search")
		limit := qint(r, "limit", 100, 1, 500)

		q := `SELECT l.id, l.title, l.entity_type, l.company_name, l.employer_id, l.stage,
		             l.potential_value_kobo, l.lead_type, l.lead_score,
		             l.contact_name, l.contact_phone, l.contact_email, l.assigned_to,
		             l.expected_close_date, l.notes, l.created_at, l.updated_at,
		             u.full_name AS assigned_name,
		             e.name AS employer_name
		      FROM bd_leads l
		      LEFT JOIN o3c_users u ON u.id = l.assigned_to
		      LEFT JOIN employers e ON e.id = l.employer_id
		      WHERE 1=1`
		var args []any
		n := 1

		if stage != "" {
			q += fmt.Sprintf(" AND l.stage=$%d", n)
			args = append(args, stage)
			n++
		}
		if assignedTo != "" {
			q += fmt.Sprintf(" AND l.assigned_to=$%d", n)
			args = append(args, assignedTo)
			n++
		}
		if search != "" {
			q += fmt.Sprintf(" AND (l.title ILIKE $%d OR l.company_name ILIKE $%d OR l.contact_name ILIKE $%d)", n, n, n)
			args = append(args, "%"+search+"%")
			n++
		}
		if from := qstr(r, "from"); from != "" {
			q += fmt.Sprintf(" AND l.created_at::date >= $%d::date", n)
			args = append(args, from); n++
		}
		if to := qstr(r, "to"); to != "" {
			q += fmt.Sprintf(" AND l.created_at::date <= $%d::date", n)
			args = append(args, to); n++
		}
		args = append(args, limit)
		q += fmt.Sprintf(" ORDER BY l.updated_at DESC LIMIT $%d", n)

		rows, err := db.PGQuery(r.Context(), q, args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		jsonRows(w, rows)
	}
}

func bdCreateLead(db *core.DB) http.HandlerFunc {
	type body struct {
		Title              string  `json:"title"`
		EntityType         string  `json:"entity_type"`
		CompanyName        *string `json:"company_name"`
		EmployerName       *string `json:"employer_name"`
		EmployerID         *int64  `json:"employer_id"`
		Stage              string  `json:"stage"`
		PotentialValueKobo *int64  `json:"potential_value_kobo"`
		LeadType           *string `json:"lead_type"`
		ContactName        *string `json:"contact_name"`
		ContactPhone       *string `json:"contact_phone"`
		ContactEmail       *string `json:"contact_email"`
		AssignedTo         *int64  `json:"assigned_to"`
		ExpectedCloseDate  *string `json:"expected_close_date"`
		Notes              *string `json:"notes"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil || b.Title == "" {
			respondErr(w, 400, "title is required")
			return
		}
		if b.Stage == "" {
			b.Stage = "prospect"
		}
		validBDStages := map[string]bool{"prospect": true, "qualified": true, "proposal": true, "negotiation": true, "won": true, "lost": true}
		if !validBDStages[b.Stage] {
			respondErr(w, 422, "invalid stage")
			return
		}
		if b.EntityType == "" {
			b.EntityType = "company"
		}
		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(),
			`INSERT INTO bd_leads
			 (title, entity_type, company_name, employer_id, stage, potential_value_kobo,
			  lead_type, contact_name, contact_phone, contact_email,
			  assigned_to, expected_close_date, notes, created_by)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
			b.Title, b.EntityType, b.CompanyName, b.EmployerID, b.Stage,
			b.PotentialValueKobo, b.LeadType,
			b.ContactName, b.ContactPhone, b.ContactEmail,
			b.AssignedTo, b.ExpectedCloseDate, b.Notes, user.ID)
		if err != nil {
			respondErr(w, 500, "Insert failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func bdGetLead(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		rows, err := db.PGQuery(r.Context(), `
			SELECT l.*, u.full_name AS assigned_name, e.name AS employer_name
			FROM bd_leads l
			LEFT JOIN o3c_users u ON u.id = l.assigned_to
			LEFT JOIN employers e ON e.id = l.employer_id
			WHERE l.id=$1`, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Lead not found")
			return
		}
		activities, _ := db.PGQuery(r.Context(), `
			SELECT a.*, u.full_name AS agent_name
			FROM bd_activities a
			JOIN o3c_users u ON u.id = a.agent_id
			WHERE a.lead_id=$1 ORDER BY a.created_at DESC`, id)
		if activities == nil {
			activities = []map[string]any{}
		}
		lead := rows[0]
		lead["activities"] = activities
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(lead) //nolint:errcheck
	}
}

func bdUpdateLead(db *core.DB) http.HandlerFunc {
	type body struct {
		Stage              *string `json:"stage"`
		LeadType           *string `json:"lead_type"`
		EntityType         *string `json:"entity_type"`
		Notes              *string `json:"notes"`
		AssignedTo         *int64  `json:"assigned_to"`
		PotentialValueKobo *int64  `json:"potential_value_kobo"`
		ExpectedCloseDate  *string `json:"expected_close_date"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		q := `UPDATE bd_leads SET updated_at=NOW()`
		var args []any
		n := 1
		add := func(col string, v any) {
			q += fmt.Sprintf(", %s=$%d", col, n)
			args = append(args, v)
			n++
		}
		if b.Stage != nil {
			add("stage", *b.Stage)
		}
		if b.LeadType != nil {
			add("lead_type", *b.LeadType)
		}
		if b.EntityType != nil {
			add("entity_type", *b.EntityType)
		}
		if b.Notes != nil {
			add("notes", *b.Notes)
		}
		if b.AssignedTo != nil {
			add("assigned_to", *b.AssignedTo)
		}
		if b.PotentialValueKobo != nil {
			add("potential_value_kobo", *b.PotentialValueKobo)
		}
		if b.ExpectedCloseDate != nil {
			add("expected_close_date", *b.ExpectedCloseDate)
		}
		args = append(args, id)
		q += fmt.Sprintf(" WHERE id=$%d RETURNING *", n)
		rows, err := db.PGQuery(r.Context(), q, args...)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Lead not found")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func bdLogActivity(db *core.DB) http.HandlerFunc {
	type body struct {
		ActivityType string  `json:"activity_type"`
		Notes        *string `json:"notes"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil || b.ActivityType == "" {
			respondErr(w, 400, "activity_type is required")
			return
		}
		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(),
			`INSERT INTO bd_activities (lead_id, agent_id, activity_type, notes)
			 VALUES ($1,$2,$3,$4) RETURNING *`,
			id, user.ID, b.ActivityType, b.Notes)
		if err != nil {
			respondErr(w, 500, "Insert failed")
			return
		}
		db.PGExec(r.Context(), `UPDATE bd_leads SET updated_at=NOW() WHERE id=$1`, id) //nolint:errcheck
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func bdStats(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		from := qstr(r, "from")
		to   := qstr(r, "to")

		pipeline, _ := db.PGQuery(ctx, `
			SELECT stage,
			       COUNT(*) AS count,
			       COALESCE(SUM(potential_value_kobo), 0) AS total_value_kobo
			FROM bd_leads
			WHERE ($1='' OR created_at::date >= $1::date)
			  AND ($2='' OR created_at::date <= $2::date)
			GROUP BY stage
			ORDER BY CASE stage
			  WHEN 'prospect' THEN 1 WHEN 'qualified' THEN 2
			  WHEN 'proposal' THEN 3  WHEN 'negotiation' THEN 4
			  WHEN 'won' THEN 5       WHEN 'lost' THEN 6 ELSE 7
			END`, from, to)

		employers, _ := db.PGQuery(ctx, `
			SELECT COUNT(*) FILTER (WHERE is_active)                                         AS active,
			       COUNT(*) FILTER (WHERE mou_status='signed')                               AS mou_signed,
			       COUNT(*) FILTER (WHERE mou_expiry < CURRENT_DATE AND mou_status='signed') AS mou_expiring
			FROM employers`)

		totalsRow := map[string]any{"active": 0, "mou_signed": 0, "mou_expiring": 0}
		if len(employers) > 0 {
			totalsRow = employers[0]
		}
		if pipeline == nil {
			pipeline = []map[string]any{}
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"pipeline":  pipeline,
			"employers": totalsRow,
		})
	}
}

// bdSectorAnalytics returns a per-sector breakdown of the employer partner base:
// employer count, total staff, total monthly payroll, and lead count. Source is
// employers.sector (free-text). Lead counts are pre-aggregated in a subquery to avoid
// join fan-out inflating the staff/payroll sums.
func bdSectorAnalytics(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT
				COALESCE(NULLIF(e.sector, ''), 'Unspecified') AS sector,
				COUNT(*)                                      AS employer_count,
				COALESCE(SUM(e.staff_count), 0)               AS staff_total,
				COALESCE(SUM(e.monthly_payroll_kobo), 0)      AS payroll_total_kobo,
				COALESCE(SUM(lc.cnt), 0)                      AS lead_count
			FROM employers e
			LEFT JOIN (SELECT employer_id, COUNT(*) AS cnt FROM bd_leads GROUP BY employer_id) lc
			  ON lc.employer_id = e.id
			WHERE e.is_active = TRUE
			GROUP BY 1
			ORDER BY payroll_total_kobo DESC, employer_count DESC`)
		if err != nil {
			respond(w, []any{}, "pg")
			return
		}
		respond(w, rows, "pg")
	}
}

// bdPipelineKPIs summarises the lead book, optionally for one owner.
//
// The scope must match the table it sits above. My Pipeline shows your leads, so
// KPI cards reading "Total Leads 340" over a table of 18 rows describe a different
// population than the one on screen — the numbers are not wrong, they are answering
// a question nobody asked.
func bdPipelineKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		where := ""
		var args []any
		if q := qstr(r, "assigned_to"); q != "" {
			id, err := parseUserID(q)
			if err != nil {
				respondErr(w, 400, err.Error())
				return
			}
			where = " WHERE assigned_to = $1"
			args = append(args, id)
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT
			  COUNT(*)                                                                         AS total_leads,
			  COUNT(*) FILTER (WHERE created_at >= date_trunc('month', CURRENT_DATE))         AS this_month,
			  CASE WHEN COUNT(*) > 0 THEN
			    ROUND(100.0 * COUNT(*) FILTER (WHERE stage = 'won') / COUNT(*), 1)
			  ELSE 0 END                                                                       AS conversion_rate_pct,
			  COALESCE(AVG(potential_value_kobo) FILTER (WHERE potential_value_kobo > 0), 0)  AS avg_deal_kobo
			FROM bd_leads`+where, args...)
		if err != nil || len(rows) == 0 {
			respond(w, map[string]any{
				"total_leads": 0, "this_month": 0,
				"conversion_rate_pct": 0.0, "avg_deal_kobo": 0,
			}, "pg")
			return
		}
		respond(w, rows[0], "pg")
	}
}

// ── CSV Import ────────────────────────────────────────────────────────────────

func bdImportLeads(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseMultipartForm(8 << 20); err != nil {
			respondErr(w, 400, "Invalid multipart form")
			return
		}
		f, _, err := r.FormFile("file")
		if err != nil {
			respondErr(w, 400, "No file uploaded")
			return
		}
		defer f.Close()

		reader := csv.NewReader(f)
		reader.TrimLeadingSpace = true
		reader.FieldsPerRecord = -1 // allow variable columns

		headers, err := reader.Read()
		if err != nil {
			respondErr(w, 400, "Could not read CSV header")
			return
		}
		// Normalise headers
		hdrIdx := make(map[string]int)
		for i, h := range headers {
			hdrIdx[strings.ToLower(strings.TrimSpace(h))] = i
		}

		col := func(row []string, name string) string {
			i, ok := hdrIdx[name]
			if !ok || i >= len(row) {
				return ""
			}
			return strings.TrimSpace(row[i])
		}

		ctx := r.Context()
		imported, skipped := 0, 0

		for {
			row, err := reader.Read()
			if err != nil {
				break
			}
			entityType := col(row, "entity_type")
			if entityType == "" {
				entityType = "company"
			}
			companyName := col(row, "company_name")
			contactName := col(row, "contact_name")
			// Support first_name/last_name columns (matches the New Lead form) —
			// fall back to them when a single contact_name column isn't provided.
			if contactName == "" {
				contactName = strings.TrimSpace(col(row, "first_name") + " " + col(row, "last_name"))
			}
			title := col(row, "title")
			if title == "" {
				if contactName != "" {
					title = contactName
				} else {
					title = companyName
				}
			}
			if title == "" {
				skipped++
				continue
			}

			email := col(row, "contact_email")
			phone := col(row, "contact_phone")
			leadType := col(row, "lead_type")
			stage := col(row, "stage")
			if stage == "" {
				stage = "prospect"
			}
			notes := col(row, "notes")
			valStr := col(row, "potential_value_naira")
			var valueKobo int64
			if valStr != "" {
				var v float64
				fmt.Sscanf(valStr, "%f", &v)
				valueKobo = int64(math.Round(v * 100))
			}

			_, err = db.PGExec(ctx, `
				INSERT INTO bd_leads
					(entity_type, title, company_name, contact_name, contact_email,
					 contact_phone, lead_type, stage, potential_value_kobo, notes, created_at, updated_at)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW())`,
				entityType, title, coalesce(companyName, ""), coalesce(contactName, ""),
				coalesce(email, ""), coalesce(phone, ""), coalesce(leadType, ""),
				stage, valueKobo, coalesce(notes, ""))
			if err != nil {
				skipped++
			} else {
				imported++
			}
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"imported": imported,
			"skipped":  skipped,
		})
	}
}

// ── Staff roster ──────────────────────────────────────────────────────────────

func bdListStaff(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		employerID := chi.URLParam(r, "id")
		rows, err := db.PGQuery(r.Context(), `
			SELECT id, employer_id, full_name, job_title, department, phone, email, created_at
			FROM employer_staff
			WHERE employer_id = $1
			ORDER BY full_name`, employerID)
		if err != nil {
			respondErr(w, 500, err.Error()); return
		}
		respond(w, rows, "staff")
	}
}

func bdAddStaff(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		employerID := chi.URLParam(r, "id")
		var b struct {
			FullName   string  `json:"full_name"`
			JobTitle   *string `json:"job_title"`
			Department *string `json:"department"`
			Phone      *string `json:"phone"`
			Email      *string `json:"email"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "invalid JSON"); return
		}
		if b.FullName == "" {
			respondErr(w, 422, "full_name is required"); return
		}
		userID := core.UserFromCtx(r.Context()).ID
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO employer_staff (employer_id, full_name, job_title, department, phone, email, created_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7)
			RETURNING id, employer_id, full_name, job_title, department, phone, email, created_at`,
			employerID, b.FullName, b.JobTitle, b.Department, b.Phone, b.Email, userID)
		if err != nil {
			respondErr(w, 500, err.Error()); return
		}
		if len(rows) == 0 {
			respondErr(w, 500, "insert returned no row"); return
		}
		// Keep employer.staff_count in sync
		db.PGExec(r.Context(), `UPDATE employers SET staff_count = (SELECT COUNT(*) FROM employer_staff WHERE employer_id=$1) WHERE id=$1`, employerID) //nolint:errcheck
		respond(w, rows[0], "staff")
	}
}

func bdImportStaff(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		employerID := chi.URLParam(r, "id")
		if err := r.ParseMultipartForm(4 << 20); err != nil {
			respondErr(w, 400, "multipart parse error"); return
		}
		f, _, err := r.FormFile("file")
		if err != nil {
			respondErr(w, 400, "file field required"); return
		}
		defer f.Close()

		userID := core.UserFromCtx(r.Context()).ID
		rdr := csv.NewReader(f)
		rdr.TrimLeadingSpace = true
		records, err := rdr.ReadAll()
		if err != nil {
			respondErr(w, 400, "CSV parse error: "+err.Error()); return
		}

		imported, skipped := 0, 0
		ctx := r.Context()
		for i, rec := range records {
			if i == 0 { continue } // skip header
			col := func(idx int) string {
				if idx < len(rec) { return strings.TrimSpace(rec[idx]) }
				return ""
			}
			fullName := col(0)
			if fullName == "" { skipped++; continue }
			jobTitle := col(1); dept := col(2); phone := col(3); email := col(4)
			_, dbErr := db.PGExec(ctx, `
				INSERT INTO employer_staff (employer_id, full_name, job_title, department, phone, email, created_by)
				VALUES ($1,$2,$3,$4,$5,$6,$7)`,
				employerID, fullName, nullStr(jobTitle), nullStr(dept), nullStr(phone), nullStr(email), userID)
			if dbErr != nil { skipped++ } else { imported++ }
		}
		db.PGExec(ctx, `UPDATE employers SET staff_count = (SELECT COUNT(*) FROM employer_staff WHERE employer_id=$1) WHERE id=$1`, employerID) //nolint:errcheck
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"imported": imported, "skipped": skipped}) //nolint:errcheck
	}
}

func bdDeleteStaff(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		employerID := chi.URLParam(r, "id")
		staffID := chi.URLParam(r, "staff_id")
		_, err := db.PGExec(r.Context(), `DELETE FROM employer_staff WHERE id=$1 AND employer_id=$2`, staffID, employerID)
		if err != nil {
			respondErr(w, 500, err.Error()); return
		}
		db.PGExec(r.Context(), `UPDATE employers SET staff_count = (SELECT COUNT(*) FROM employer_staff WHERE employer_id=$1) WHERE id=$1`, employerID) //nolint:errcheck
		w.WriteHeader(http.StatusNoContent)
	}
}

// ── BD → Sales assignment ─────────────────────────────────────────────────────

func bdAssignToSales(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		employerID := chi.URLParam(r, "id")
		var b struct {
			SalesAgentID   int64   `json:"sales_agent_id"`
			AssignmentType string  `json:"assignment_type"` // full_company | specific_staff
			StaffIDs       []int64 `json:"staff_ids"`       // only for specific_staff
			Notes          *string `json:"notes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "invalid JSON"); return
		}
		if b.SalesAgentID == 0 {
			respondErr(w, 422, "sales_agent_id is required"); return
		}
		if b.AssignmentType != "full_company" && b.AssignmentType != "specific_staff" {
			respondErr(w, 422, "assignment_type must be full_company or specific_staff"); return
		}
		if b.AssignmentType == "specific_staff" && len(b.StaffIDs) == 0 {
			respondErr(w, 422, "staff_ids required for specific_staff assignment"); return
		}

		bdOfficerID := core.UserFromCtx(r.Context()).ID
		ctx := r.Context()

		// Count staff being assigned
		var staffCount int
		if b.AssignmentType == "full_company" {
			rows, _ := db.PGQuery(ctx, `SELECT COUNT(*) AS n FROM employer_staff WHERE employer_id=$1`, employerID)
			if len(rows) > 0 {
				staffCount = int(toInt64(rows[0]["n"]))
			}
		} else {
			staffCount = len(b.StaffIDs)
		}

		// Create assignment record
		aRows, err := db.PGQuery(ctx, `
			INSERT INTO bd_assignments (employer_id, bd_officer_id, sales_agent_id, assignment_type, staff_count_at_assignment, notes)
			VALUES ($1,$2,$3,$4,$5,$6)
			RETURNING id`,
			employerID, bdOfficerID, b.SalesAgentID, b.AssignmentType, staffCount, b.Notes)
		if err != nil {
			respondErr(w, 500, err.Error()); return
		}
		assignmentID := toInt64(aRows[0]["id"])

		// Determine which staff to create CRM contacts for
		var staffRows []map[string]any
		if b.AssignmentType == "full_company" {
			staffRows, _ = db.PGQuery(ctx, `SELECT id, full_name, phone, email FROM employer_staff WHERE employer_id=$1`, employerID)
		} else {
			// Build IN clause
			placeholders := make([]string, len(b.StaffIDs))
			args := []any{employerID}
			for i, sid := range b.StaffIDs {
				placeholders[i] = fmt.Sprintf("$%d", i+2)
				args = append(args, sid)
				db.PGExec(ctx, `INSERT INTO bd_assignment_staff (assignment_id, staff_id) VALUES ($1,$2)`, assignmentID, sid) //nolint:errcheck
			}
			staffRows, _ = db.PGQuery(ctx, fmt.Sprintf(`
				SELECT id, full_name, phone, email FROM employer_staff
				WHERE employer_id=$1 AND id IN (%s)`, strings.Join(placeholders, ",")), args...)
		}

		// Bulk-create CRM contacts for assigned staff
		contactsCreated := 0
		for _, s := range staffRows {
			name := str(s["full_name"])
			parts := strings.SplitN(name, " ", 2)
			firstName := parts[0]; lastName := ""
			if len(parts) > 1 { lastName = parts[1] }
			_, cErr := db.PGExec(ctx, `
				INSERT INTO crm_contacts
					(first_name, last_name, phone, email, source, source_type, bd_assignment_id, employer_id, assigned_to, status, created_by)
				VALUES ($1,$2,$3,$4,'bd_assigned','bd_assigned',$5,$6,$7,'lead',$8)
				ON CONFLICT DO NOTHING`,
				firstName, lastName, s["phone"], s["email"],
				assignmentID, employerID, b.SalesAgentID, bdOfficerID)
			if cErr == nil { contactsCreated++ }
		}

		respond(w, map[string]any{
			"assignment_id":    assignmentID,
			"contacts_created": contactsCreated,
			"staff_count":      staffCount,
		}, "assignment")
	}
}

func bdListAssignments(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		bdOfficerID := core.UserFromCtx(r.Context()).ID
		rows, err := db.PGQuery(r.Context(), `
			SELECT
				a.id, a.employer_id, e.name AS employer_name,
				a.bd_officer_id, bo.full_name AS bd_officer_name,
				a.sales_agent_id, u.full_name AS sales_agent_name,
				a.assignment_type, a.status,
				a.staff_count_at_assignment, a.notes, a.assigned_at,
				COUNT(DISTINCT c.id)                                       AS contacts_total,
				COUNT(DISTINCT c.id) FILTER (WHERE c.status = 'customer') AS contacts_converted,
				COUNT(DISTINCT d.id) FILTER (WHERE d.id IS NOT NULL)       AS deals_open
			FROM bd_assignments a
			JOIN employers     e ON e.id = a.employer_id
			JOIN o3c_users     u ON u.id = a.sales_agent_id
			LEFT JOIN o3c_users bo ON bo.id = a.bd_officer_id
			LEFT JOIN crm_contacts c ON c.bd_assignment_id = a.id
			LEFT JOIN crm_deals    d ON d.contact_id = c.id AND (d.is_won IS NULL OR d.is_won = false) AND (d.is_lost IS NULL OR d.is_lost = false)
			WHERE a.bd_officer_id = $1
			GROUP BY a.id, e.name, bo.full_name, u.full_name
			ORDER BY a.assigned_at DESC`, bdOfficerID)
		if err != nil {
			respondErr(w, 500, err.Error()); return
		}
		respond(w, rows, "assignments")
	}
}

func bdGetAssignment(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		aRows, err := db.PGQuery(r.Context(), `
			SELECT a.*, e.name AS employer_name, u.full_name AS sales_agent_name
			FROM bd_assignments a
			JOIN employers e ON e.id = a.employer_id
			JOIN o3c_users u ON u.id = a.sales_agent_id
			WHERE a.id = $1`, id)
		if err != nil || len(aRows) == 0 {
			respondErr(w, 404, "assignment not found"); return
		}
		contacts, _ := db.PGQuery(r.Context(), `
			SELECT c.id, c.first_name, c.last_name, c.phone, c.email, c.status,
			       u.full_name AS assigned_name,
			       COUNT(d.id) AS open_deals
			FROM crm_contacts c
			LEFT JOIN o3c_users u ON u.id = c.assigned_to
			LEFT JOIN crm_deals d ON d.contact_id = c.id AND (d.is_won IS NULL OR d.is_won=false) AND (d.is_lost IS NULL OR d.is_lost=false)
			WHERE c.bd_assignment_id = $1
			GROUP BY c.id, u.full_name
			ORDER BY c.first_name`, id)
		respond(w, map[string]any{
			"assignment": aRows[0],
			"contacts":   contacts,
		}, "assignment_detail")
	}
}

func bdUpdateAssignment(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var b struct {
			Status *string `json:"status"`
			Notes  *string `json:"notes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "invalid JSON"); return
		}
		q := "UPDATE bd_assignments SET updated_at=NOW()"
		args := []any{}
		n := 1
		add := func(col string, v any) { q += fmt.Sprintf(", %s=$%d", col, n); args = append(args, v); n++ }
		if b.Status != nil { add("status", *b.Status) }
		if b.Notes != nil  { add("notes", *b.Notes) }
		q += fmt.Sprintf(" WHERE id=$%d", n)
		args = append(args, id)
		if _, err := db.PGExec(r.Context(), q, args...); err != nil {
			respondErr(w, 500, err.Error()); return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func bdMyDashboard(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)

		// ── Employer-level KPIs ───────────────────────────────────────────────
		empRows, _ := db.PGQuery(ctx, `
			SELECT
			  COUNT(DISTINCT e.id)                                              AS employers_managed,
			  COUNT(DISTINCT e.id) FILTER (WHERE e.mou_status = 'signed')      AS mou_signed,
			  COUNT(DISTINCT e.id) FILTER (
			      WHERE e.mou_status = 'signed'
			      AND e.mou_expiry BETWEEN CURRENT_DATE AND CURRENT_DATE + 30
			  )                                                                 AS mou_expiring_soon
			FROM employers e
			WHERE EXISTS (
			    SELECT 1 FROM bd_leads l WHERE l.employer_id = e.id AND l.assigned_to = $1
			) OR EXISTS (
			    SELECT 1 FROM bd_assignments a WHERE a.employer_id = e.id AND a.bd_officer_id = $1
			)`, user.ID)

		// ── Assignment outcome KPIs (MTD + last-month for comparison) ─────────
		asgRows, _ := db.PGQuery(ctx, `
			SELECT
			  -- MTD
			  COALESCE(SUM(a.staff_count_at_assignment) FILTER (
			      WHERE a.assigned_at >= date_trunc('month', CURRENT_DATE)
			  ), 0)                                                             AS staff_referred_mtd,
			  COUNT(DISTINCT c.id) FILTER (
			      WHERE c.status = 'customer'
			      AND c.updated_at >= date_trunc('month', CURRENT_DATE)
			  )                                                                 AS conversions_mtd,
			  -- Last month (for % change arrows)
			  COALESCE(SUM(a.staff_count_at_assignment) FILTER (
			      WHERE a.assigned_at >= date_trunc('month', CURRENT_DATE - INTERVAL '1 month')
			      AND   a.assigned_at <  date_trunc('month', CURRENT_DATE)
			  ), 0)                                                             AS staff_referred_lm,
			  COUNT(DISTINCT c.id) FILTER (
			      WHERE c.status = 'customer'
			      AND c.updated_at >= date_trunc('month', CURRENT_DATE - INTERVAL '1 month')
			      AND c.updated_at <  date_trunc('month', CURRENT_DATE)
			  )                                                                 AS conversions_lm,
			  -- All-time totals (funnel)
			  COALESCE(SUM(a.staff_count_at_assignment), 0)                    AS total_staff_referred,
			  COUNT(DISTINCT c.id)                                             AS total_crm_contacts,
			  COUNT(DISTINCT c.id) FILTER (WHERE c.status = 'customer')       AS total_converted,
			  -- MTD totals (funnel MTD view)
			  COUNT(DISTINCT c.id) FILTER (
			      WHERE c.created_at >= date_trunc('month', CURRENT_DATE)
			  )                                                                 AS mtd_crm_contacts,
			  COUNT(DISTINCT c.id) FILTER (
			      WHERE c.status = 'customer'
			      AND c.updated_at >= date_trunc('month', CURRENT_DATE)
			  )                                                                 AS mtd_converted
			FROM bd_assignments a
			LEFT JOIN crm_contacts c ON c.bd_assignment_id = a.id
			WHERE a.bd_officer_id = $1`, user.ID)

		// ── Activity KPIs (MTD + last-month) ─────────────────────────────────
		actRows, _ := db.PGQuery(ctx, `
			SELECT
			  COUNT(*) FILTER (
			      WHERE activity_type = 'call'
			      AND created_at >= date_trunc('month', CURRENT_DATE)
			  )                AS calls_made_mtd,
			  COUNT(*) FILTER (
			      WHERE activity_type = 'meeting'
			      AND created_at >= date_trunc('month', CURRENT_DATE)
			  )                AS meetings_mtd,
			  COUNT(*) FILTER (
			      WHERE activity_type = 'call'
			      AND created_at >= date_trunc('month', CURRENT_DATE - INTERVAL '1 month')
			      AND created_at <  date_trunc('month', CURRENT_DATE)
			  )                AS calls_lm,
			  COUNT(*) FILTER (
			      WHERE activity_type = 'meeting'
			      AND created_at >= date_trunc('month', CURRENT_DATE - INTERVAL '1 month')
			      AND created_at <  date_trunc('month', CURRENT_DATE)
			  )                AS meetings_lm
			FROM bd_activities
			WHERE agent_id = $1`, user.ID)

		// ── Funnel: applications (all-time + MTD) ─────────────────────────────
		funnelRows, _ := db.PGQuery(ctx, `
			SELECT
			  COUNT(DISTINCT la.id) AS applications,
			  COUNT(DISTINCT la.id) FILTER (
			      WHERE la.created_at >= date_trunc('month', CURRENT_DATE)
			  )                     AS mtd_applications
			FROM bd_assignments a
			JOIN crm_contacts c ON c.bd_assignment_id = a.id
			JOIN loan_applications la ON la.applicant_cif = c.cif_number
			WHERE a.bd_officer_id = $1 AND c.cif_number IS NOT NULL`, user.ID)

		// ── Windowed funnel — driven by the page date filter (empty = all-time) ──
		from := qstr(r, "from")
		to := qstr(r, "to")
		winStaff := int64(0)
		if rows, _ := db.PGQuery(ctx, `
			SELECT COALESCE(SUM(staff_count_at_assignment), 0) AS n
			FROM bd_assignments
			WHERE bd_officer_id = $1
			  AND ($2 = '' OR assigned_at::date >= $2::date)
			  AND ($3 = '' OR assigned_at::date <= $3::date)`, user.ID, from, to); len(rows) > 0 {
			winStaff = toInt64(rows[0]["n"])
		}
		winContacts, winConverted := int64(0), int64(0)
		if rows, _ := db.PGQuery(ctx, `
			SELECT
			  COUNT(DISTINCT c.id) FILTER (
			      WHERE ($2 = '' OR c.created_at::date >= $2::date)
			      AND   ($3 = '' OR c.created_at::date <= $3::date)) AS crm_contacts,
			  COUNT(DISTINCT c.id) FILTER (
			      WHERE c.status = 'customer'
			      AND ($2 = '' OR c.updated_at::date >= $2::date)
			      AND ($3 = '' OR c.updated_at::date <= $3::date)) AS converted
			FROM bd_assignments a
			JOIN crm_contacts c ON c.bd_assignment_id = a.id
			WHERE a.bd_officer_id = $1`, user.ID, from, to); len(rows) > 0 {
			winContacts = toInt64(rows[0]["crm_contacts"])
			winConverted = toInt64(rows[0]["converted"])
		}
		winApps := int64(0)
		if rows, _ := db.PGQuery(ctx, `
			SELECT COUNT(DISTINCT la.id) AS n
			FROM bd_assignments a
			JOIN crm_contacts c ON c.bd_assignment_id = a.id
			JOIN loan_applications la ON la.applicant_cif = c.cif_number
			WHERE a.bd_officer_id = $1 AND c.cif_number IS NOT NULL
			  AND ($2 = '' OR la.created_at::date >= $2::date)
			  AND ($3 = '' OR la.created_at::date <= $3::date)`, user.ID, from, to); len(rows) > 0 {
			winApps = toInt64(rows[0]["n"])
		}

		// ── Urgency 1: MOUs expiring within 30 days (with contact for email) ──
		mouExpiring, _ := db.PGQuery(ctx, `
			SELECT e.id, e.name, e.sector,
			       e.mou_expiry::text,
			       e.contact_name, e.contact_email,
			       (e.mou_expiry - CURRENT_DATE) AS days_to_expiry
			FROM employers e
			WHERE e.mou_status = 'signed'
			  AND e.mou_expiry BETWEEN CURRENT_DATE AND CURRENT_DATE + 30
			  AND (
			      EXISTS (SELECT 1 FROM bd_leads l WHERE l.employer_id = e.id AND l.assigned_to = $1)
			      OR EXISTS (SELECT 1 FROM bd_assignments a WHERE a.employer_id = e.id AND a.bd_officer_id = $1)
			  )
			ORDER BY e.mou_expiry ASC`, user.ID)

		// ── Urgency 2: Assignments with 0 CRM contacts after 7 days ──────────
		stale, _ := db.PGQuery(ctx, `
			SELECT a.id, e.name AS employer_name,
			       a.staff_count_at_assignment, a.assigned_at::text,
			       (CURRENT_DATE - a.assigned_at::date) AS days_stale,
			       u.full_name AS sales_agent_name,
			       u.email     AS sales_agent_email
			FROM bd_assignments a
			JOIN employers e ON e.id = a.employer_id
			JOIN o3c_users u ON u.id = a.sales_agent_id
			WHERE a.bd_officer_id = $1
			  AND a.status NOT IN ('converted','lost')
			  AND a.assigned_at < NOW() - INTERVAL '7 days'
			  AND NOT EXISTS (SELECT 1 FROM crm_contacts c WHERE c.bd_assignment_id = a.id)
			ORDER BY a.assigned_at ASC`, user.ID)

		// ── Urgency 3: Dormant partnerships — MOU signed 14+ days, never assigned ──
		dormant, _ := db.PGQuery(ctx, `
			SELECT e.id, e.name, e.sector,
			       e.mou_date::text,
			       e.contact_name, e.contact_email,
			       (CURRENT_DATE - e.mou_date) AS days_since_signed
			FROM employers e
			WHERE e.mou_status = 'signed'
			  AND e.mou_date IS NOT NULL
			  AND e.mou_date < CURRENT_DATE - INTERVAL '14 days'
			  AND EXISTS (
			      SELECT 1 FROM bd_leads l WHERE l.employer_id = e.id AND l.assigned_to = $1
			  )
			  AND NOT EXISTS (
			      SELECT 1 FROM bd_assignments a WHERE a.employer_id = e.id AND a.bd_officer_id = $1
			  )
			ORDER BY e.mou_date ASC
			LIMIT 5`, user.ID)

		// ── My Employers with outcomes ────────────────────────────────────────
		employers, _ := db.PGQuery(ctx, `
			SELECT e.id, e.name, e.sector, e.staff_count,
			       e.mou_status, e.mou_expiry::text,
			       COUNT(DISTINCT a.id)                                        AS assignments_count,
			       COALESCE(SUM(a.staff_count_at_assignment), 0)              AS staff_referred,
			       COUNT(DISTINCT c.id)                                       AS contacts_created,
			       COUNT(DISTINCT c.id) FILTER (WHERE c.status = 'customer') AS converted
			FROM employers e
			LEFT JOIN bd_assignments a ON a.employer_id = e.id AND a.bd_officer_id = $1
			LEFT JOIN crm_contacts c ON c.bd_assignment_id = a.id
			WHERE EXISTS (
			    SELECT 1 FROM bd_leads l WHERE l.employer_id = e.id AND l.assigned_to = $1
			) OR EXISTS (
			    SELECT 1 FROM bd_assignments a2 WHERE a2.employer_id = e.id AND a2.bd_officer_id = $1
			)
			GROUP BY e.id
			ORDER BY e.updated_at DESC
			LIMIT 20`, user.ID)

		// ── Recent assignments ────────────────────────────────────────────────
		recentAssignments, _ := db.PGQuery(ctx, `
			SELECT a.id, e.name AS employer_name, a.assignment_type, a.status,
			       a.staff_count_at_assignment, a.assigned_at::text,
			       u.full_name AS sales_agent_name,
			       COUNT(DISTINCT c.id)                                        AS contacts_created,
			       COUNT(DISTINCT c.id) FILTER (WHERE c.status = 'customer')  AS converted
			FROM bd_assignments a
			JOIN employers e ON e.id = a.employer_id
			JOIN o3c_users u ON u.id = a.sales_agent_id
			LEFT JOIN crm_contacts c ON c.bd_assignment_id = a.id
			WHERE a.bd_officer_id = $1
			GROUP BY a.id, e.name, u.full_name
			ORDER BY a.assigned_at DESC
			LIMIT 10`, user.ID)

		// ── Defaults ─────────────────────────────────────────────────────────
		empKPI := map[string]any{"employers_managed": 0, "mou_signed": 0, "mou_expiring_soon": 0}
		if len(empRows) > 0 { empKPI = empRows[0] }

		asgKPI := map[string]any{
			"staff_referred_mtd": 0, "conversions_mtd": 0,
			"staff_referred_lm": 0, "conversions_lm": 0,
			"total_staff_referred": 0, "total_crm_contacts": 0, "total_converted": 0,
			"mtd_crm_contacts": 0, "mtd_converted": 0,
		}
		if len(asgRows) > 0 { asgKPI = asgRows[0] }

		actKPI := map[string]any{"calls_made_mtd": 0, "meetings_mtd": 0, "calls_lm": 0, "meetings_lm": 0}
		if len(actRows) > 0 { actKPI = actRows[0] }

		funnelRow := map[string]any{"applications": 0, "mtd_applications": 0}
		if len(funnelRows) > 0 { funnelRow = funnelRows[0] }

		if mouExpiring == nil       { mouExpiring = []map[string]any{} }
		if stale == nil             { stale = []map[string]any{} }
		if dormant == nil           { dormant = []map[string]any{} }
		if employers == nil         { employers = []map[string]any{} }
		if recentAssignments == nil { recentAssignments = []map[string]any{} }

		respond(w, map[string]any{
			"kpis": map[string]any{
				"employers_managed":  empKPI["employers_managed"],
				"mou_signed":         empKPI["mou_signed"],
				"mou_expiring_soon":  empKPI["mou_expiring_soon"],
				"staff_referred_mtd": asgKPI["staff_referred_mtd"],
				"staff_referred_lm":  asgKPI["staff_referred_lm"],
				"conversions_mtd":    asgKPI["conversions_mtd"],
				"conversions_lm":     asgKPI["conversions_lm"],
				"calls_made_mtd":     actKPI["calls_made_mtd"],
				"calls_lm":           actKPI["calls_lm"],
				"meetings_mtd":       actKPI["meetings_mtd"],
				"meetings_lm":        actKPI["meetings_lm"],
			},
			"funnel_all": map[string]any{
				"staff_referred": asgKPI["total_staff_referred"],
				"crm_contacts":   asgKPI["total_crm_contacts"],
				"applications":   funnelRow["applications"],
				"converted":      asgKPI["total_converted"],
			},
			"funnel_mtd": map[string]any{
				"staff_referred": asgKPI["staff_referred_mtd"],
				"crm_contacts":   asgKPI["mtd_crm_contacts"],
				"applications":   funnelRow["mtd_applications"],
				"converted":      asgKPI["mtd_converted"],
			},
			// Windowed funnel driven by the page date filter (replaces the funnel's
			// old all-time/this-month toggle).
			"funnel": map[string]any{
				"staff_referred": winStaff,
				"crm_contacts":   winContacts,
				"applications":   winApps,
				"converted":      winConverted,
			},
			"urgency": map[string]any{
				"mou_expiring":      mouExpiring,
				"stale_assignments": stale,
				"dormant":           dormant,
			},
			"employers":          employers,
			"recent_assignments": recentAssignments,
		}, "my_dashboard")
	}
}


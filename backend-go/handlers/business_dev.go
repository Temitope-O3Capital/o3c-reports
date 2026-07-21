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
	r.Put("/employers/{id}", bdUpdateEmployer(db))

	r.Get("/leads", bdListLeads(db))
	r.Post("/leads", bdCreateLead(db))
	r.Post("/leads/import", bdImportLeads(db))
	r.Patch("/leads/{id}", bdUpdateLead(db))
	r.Get("/leads/{id}", bdGetLead(db))
	r.Post("/leads/{id}/activity", bdLogActivity(db))

	r.Get("/stats", bdStats(db))
	r.Get("/pipeline-kpis", bdPipelineKPIs(db))
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

func bdPipelineKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT
			  COUNT(*)                                                                         AS total_leads,
			  COUNT(*) FILTER (WHERE created_at >= date_trunc('month', CURRENT_DATE))         AS this_month,
			  CASE WHEN COUNT(*) > 0 THEN
			    ROUND(100.0 * COUNT(*) FILTER (WHERE stage = 'won') / COUNT(*), 1)
			  ELSE 0 END                                                                       AS conversion_rate_pct,
			  COALESCE(AVG(potential_value_kobo) FILTER (WHERE potential_value_kobo > 0), 0)  AS avg_deal_kobo
			FROM bd_leads`)
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

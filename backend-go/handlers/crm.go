package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

var crmAccess = core.RequirePages(
	"crm_pipeline", "crm_contacts", "crm_tasks", "crm_requests", "crm_reports",
)
var crmReportAccess = core.RequirePages("crm_reports")

func RegisterCRM(r chi.Router, db *core.DB) {
	// Contacts
	r.With(crmAccess).Get("/contacts", listContacts(db))
	r.With(crmAccess).Post("/contacts", createContact(db))
	r.With(crmAccess).Get("/contacts/{id}", getContact(db))
	r.With(crmAccess).Put("/contacts/{id}", updateContact(db))
	r.With(crmAccess).Delete("/contacts/{id}", deleteContact(db))
	r.With(crmAccess).Get("/contacts/{id}/360", customer360(db))

	// Pipeline / Deals
	r.With(crmAccess).Get("/stages", listStages(db))
	r.With(crmAccess).Get("/pipeline", getPipeline(db))
	r.With(crmAccess).Get("/deals", listDeals(db))
	r.With(crmAccess).Post("/deals", createDeal(db))
	r.With(crmAccess).Put("/deals/{id}", updateDeal(db))
	r.With(crmAccess).Delete("/deals/{id}", deleteDeal(db))

	// Activities
	r.With(crmAccess).Get("/activities", listActivities(db))
	r.With(crmAccess).Post("/activities", createActivity(db))
	r.With(crmAccess).Delete("/activities/{id}", deleteActivity(db))

	// Tasks
	r.With(crmAccess).Get("/tasks", listTasks(db))
	r.With(crmAccess).Post("/tasks", createTask(db))
	r.With(crmAccess).Put("/tasks/{id}", updateTask(db))
	r.With(crmAccess).Delete("/tasks/{id}", deleteTask(db))

	// Requests — /requests/types must be registered before /requests/{id}
	r.With(crmAccess).Get("/requests/types", getRequestTypes())
	r.With(crmAccess).Get("/requests", listRequests(db))
	r.With(crmAccess).Post("/requests", createRequest(db))
	r.With(crmAccess).Put("/requests/{id}", updateRequest(db))

	// Reports
	r.With(crmReportAccess).Get("/reports/overview", crmReportOverview(db))
	r.With(crmReportAccess).Get("/reports/pipeline", crmReportPipeline(db))
	r.With(crmReportAccess).Get("/reports/conversion", crmReportConversion(db))
	r.With(crmReportAccess).Get("/reports/agent-performance", crmReportAgentPerformance(db))
	r.With(crmReportAccess).Get("/reports/activity-trend", crmReportActivityTrend(db))
	r.With(crmReportAccess).Get("/reports/contacts-by-source", crmReportContactsBySource(db))
	r.With(crmReportAccess).Get("/reports/requests-sla", crmReportRequestsSLA(db))
	r.With(crmReportAccess).Get("/reports/new-contacts-trend", crmReportNewContactsTrend(db))
}

// ── buildSet — whitelisted dynamic SET clause ─────────────────────────────────
// body keys not in allowed are silently ignored. Present-but-null values are
// included (allows callers to explicitly clear a field).
func buildSet(body map[string]any, allowed []string, startN int) ([]string, []any) {
	var parts []string
	var args []any
	n := startN
	for _, col := range allowed {
		if v, ok := body[col]; ok {
			parts = append(parts, fmt.Sprintf("%s=$%d", col, n))
			args = append(args, v)
			n++
		}
	}
	return parts, args
}

// ── Contacts ──────────────────────────────────────────────────────────────────

var contactUpdateCols = []string{
	"first_name", "last_name", "phone", "email", "state", "city", "address",
	"date_of_birth", "gender", "occupation", "employer", "income_range",
	"id_type", "id_number", "source", "cif_number", "status",
	"assigned_to", "tags", "notes",
}

func listContacts(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := qint(r, "limit", 100, 1, 500)
		offset := qint(r, "offset", 0, 0, 1<<30)
		where := "1=1"
		var args []any
		n := 1

		if q := qstr(r, "q"); q != "" {
			where += fmt.Sprintf(
				` AND (c.first_name ILIKE $%d OR c.last_name ILIKE $%d OR c.phone ILIKE $%d OR c.email ILIKE $%d OR c.cif_number ILIKE $%d)`,
				n, n, n, n, n)
			args = append(args, "%"+q+"%")
			n++
		}
		if v := qstr(r, "status"); v != "" {
			where += fmt.Sprintf(" AND c.status=$%d", n)
			args = append(args, v); n++
		}
		if v := qstr(r, "source"); v != "" {
			where += fmt.Sprintf(" AND c.source=$%d", n)
			args = append(args, v); n++
		}
		if v := qstr(r, "assigned_to"); v != "" {
			where += fmt.Sprintf(" AND c.assigned_to=$%d", n)
			args = append(args, v); n++
		}

		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT c.*,
			       u.full_name  AS assigned_name,
			       cb.full_name AS created_by_name,
			       (SELECT COUNT(*) FROM crm_deals      d WHERE d.contact_id=c.id)                       AS deal_count,
			       (SELECT COUNT(*) FROM crm_activities a WHERE a.contact_id=c.id)                       AS activity_count,
			       (SELECT COUNT(*) FROM crm_tasks      t WHERE t.contact_id=c.id AND t.status='open')   AS open_tasks
			FROM crm_contacts c
			LEFT JOIN o3c_users u  ON u.id=c.assigned_to
			LEFT JOIN o3c_users cb ON cb.id=c.created_by
			WHERE %s
			ORDER BY c.updated_at DESC
			LIMIT $%d OFFSET $%d`, where, n, n+1), append(args, limit, offset)...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}

		total := 0
		if tr, err2 := db.PGQuery(r.Context(),
			fmt.Sprintf("SELECT COUNT(*) AS n FROM crm_contacts c WHERE %s", where), args...); err2 == nil && len(tr) > 0 {
			total = int(toInt64(tr[0]["n"]))
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": rows, "total": total}) //nolint:errcheck
	}
}

func createContact(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			FirstName   string  `json:"first_name"`
			LastName    string  `json:"last_name"`
			Phone       *string `json:"phone"`
			Email       *string `json:"email"`
			State       *string `json:"state"`
			City        *string `json:"city"`
			Address     *string `json:"address"`
			DateOfBirth *string `json:"date_of_birth"`
			Gender      *string `json:"gender"`
			Occupation  *string `json:"occupation"`
			Employer    *string `json:"employer"`
			IncomeRange *string `json:"income_range"`
			IDType      *string `json:"id_type"`
			IDNumber    *string `json:"id_number"`
			Source      *string `json:"source"`
			CIFNumber   *string `json:"cif_number"`
			Status      *string `json:"status"`
			AssignedTo  *int64  `json:"assigned_to"`
			Tags        *string `json:"tags"`
			Notes       *string `json:"notes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON"); return
		}
		if b.FirstName == "" || b.LastName == "" {
			respondErr(w, 422, "first_name and last_name are required"); return
		}
		src := coalesce(deref(b.Source), "walk_in")
		st := coalesce(deref(b.Status), "lead")
		user := core.UserFromCtx(r.Context())

		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO crm_contacts
			  (first_name, last_name, phone, email, state, city, address,
			   date_of_birth, gender, occupation, employer, income_range,
			   id_type, id_number, source, cif_number, status,
			   assigned_to, tags, notes, created_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
			RETURNING *`,
			b.FirstName, b.LastName, b.Phone, b.Email, b.State, b.City, b.Address,
			b.DateOfBirth, b.Gender, b.Occupation, b.Employer, b.IncomeRange,
			b.IDType, b.IDNumber, src, b.CIFNumber, st,
			b.AssignedTo, b.Tags, b.Notes, user.ID)
		if err != nil {
			respondErr(w, 500, "Create failed"); return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func getContact(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		rows, err := db.PGQuery(r.Context(), `
			SELECT c.*, u.full_name AS assigned_name, cb.full_name AS created_by_name
			FROM crm_contacts c
			LEFT JOIN o3c_users u  ON u.id=c.assigned_to
			LEFT JOIN o3c_users cb ON cb.id=c.created_by
			WHERE c.id=$1`, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Contact not found"); return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func updateContact(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			respondErr(w, 400, "Invalid JSON"); return
		}
		parts, args := buildSet(body, contactUpdateCols, 1)
		if len(parts) == 0 {
			respondErr(w, 422, "No fields to update"); return
		}
		parts = append(parts, "updated_at=NOW()")
		args = append(args, id)
		rows, err := db.PGQuery(r.Context(),
			fmt.Sprintf("UPDATE crm_contacts SET %s WHERE id=$%d RETURNING *",
				strings.Join(parts, ","), len(args)), args...)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Contact not found"); return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func deleteContact(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		db.PGExec(r.Context(), "DELETE FROM crm_contacts WHERE id=$1", chi.URLParam(r, "id")) //nolint:errcheck
		w.WriteHeader(204)
	}
}

func customer360(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		contactRows, err := db.PGQuery(r.Context(), `
			SELECT c.*, u.full_name AS assigned_name
			FROM crm_contacts c
			LEFT JOIN o3c_users u ON u.id=c.assigned_to
			WHERE c.id=$1`, id)
		if err != nil || len(contactRows) == 0 {
			respondErr(w, 404, "Contact not found"); return
		}
		contact := contactRows[0]

		activities, _ := db.PGQuery(r.Context(), `
			SELECT a.*, u.full_name AS agent_name
			FROM crm_activities a
			LEFT JOIN o3c_users u ON u.id=a.created_by
			WHERE a.contact_id=$1 ORDER BY a.created_at DESC LIMIT 50`, id)

		deals, _ := db.PGQuery(r.Context(), `
			SELECT d.*, s.name AS stage_name, s.color AS stage_color, u.full_name AS assigned_name
			FROM crm_deals d
			LEFT JOIN crm_pipeline_stages s ON s.id=d.stage_id
			LEFT JOIN o3c_users u ON u.id=d.assigned_to
			WHERE d.contact_id=$1 ORDER BY d.updated_at DESC`, id)

		tasks, _ := db.PGQuery(r.Context(), `
			SELECT t.*, u.full_name AS assigned_name
			FROM crm_tasks t
			LEFT JOIN o3c_users u ON u.id=t.assigned_to
			WHERE t.contact_id=$1 ORDER BY t.due_date ASC NULLS LAST`, id)

		reqs, _ := db.PGQuery(r.Context(), `
			SELECT rq.*, u.full_name AS assigned_name
			FROM crm_requests rq
			LEFT JOIN o3c_users u ON u.id=rq.assigned_to
			WHERE rq.contact_id=$1 ORDER BY rq.created_at DESC`, id)

		var accountInfo core.Row
		var txns, colls []core.Row
		if cif := str(contact["cif_number"]); cif != "" {
			if ar, _ := db.PGQuery(r.Context(), `
				SELECT a.*, p."Product Name", p."Account Status", p."Account Manager"
				FROM "Accounts" a
				LEFT JOIN "Products" p ON p."CIF Number"=a."CIF Number"
				WHERE a."CIF Number"=$1 LIMIT 1`, cif); len(ar) > 0 {
				accountInfo = ar[0]
			}
			txns, _ = db.PGQuery(r.Context(), `
				SELECT "Transaction Date","Amount","Description","Merchant_Name"
				FROM "Transactions" WHERE "CIF Number"=$1 ORDER BY "Transaction Date" DESC LIMIT 30`, cif)
			colls, _ = db.PGQuery(r.Context(), `
				SELECT "Date","Amount","Mode Of Payment","Agent","Payment Receipt"
				FROM "Collections Log" WHERE "CIF"=$1 ORDER BY "Date" DESC LIMIT 20`, cif)
		}

		nilToEmpty := func(s []core.Row) []core.Row {
			if s == nil {
				return []core.Row{}
			}
			return s
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"contact":      contact,
			"account_info": accountInfo,
			"deals":        nilToEmpty(deals),
			"activities":   nilToEmpty(activities),
			"tasks":        nilToEmpty(tasks),
			"requests":     nilToEmpty(reqs),
			"transactions": nilToEmpty(txns),
			"collections":  nilToEmpty(colls),
		})
	}
}

// ── Pipeline / Deals ──────────────────────────────────────────────────────────

var dealUpdateCols = []string{
	"title", "stage_id", "product", "expected_value", "probability",
	"expected_close_date", "lost_reason", "assigned_to",
}

func listStages(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), "SELECT * FROM crm_pipeline_stages ORDER BY order_index")
		if err != nil {
			respondErr(w, 500, "Query failed"); return
		}
		jsonRows(w, rows)
	}
}

func getPipeline(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		stages, err := db.PGQuery(r.Context(), "SELECT * FROM crm_pipeline_stages ORDER BY order_index")
		if err != nil {
			respondErr(w, 500, "Query failed"); return
		}
		deals, _ := db.PGQuery(r.Context(), `
			SELECT d.*, s.name AS stage_name, s.color AS stage_color, s.is_won, s.is_lost,
			       c.first_name, c.last_name, c.phone, c.status AS contact_status,
			       u.full_name AS assigned_name
			FROM crm_deals d
			JOIN crm_pipeline_stages s ON s.id=d.stage_id
			JOIN crm_contacts c ON c.id=d.contact_id
			LEFT JOIN o3c_users u ON u.id=d.assigned_to
			ORDER BY d.updated_at DESC`)

		byStage := map[string][]core.Row{}
		for _, d := range deals {
			key := fmt.Sprintf("%v", d["stage_id"])
			byStage[key] = append(byStage[key], d)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"stages": stages, "deals": byStage}) //nolint:errcheck
	}
}

func listDeals(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := qint(r, "limit", 200, 1, 500)
		where := "1=1"
		var args []any
		n := 1
		if v := qstr(r, "contact_id"); v != "" {
			where += fmt.Sprintf(" AND d.contact_id=$%d", n); args = append(args, v); n++
		}
		if v := qstr(r, "stage_id"); v != "" {
			where += fmt.Sprintf(" AND d.stage_id=$%d", n); args = append(args, v); n++
		}
		args = append(args, limit)
		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT d.*, s.name AS stage_name, s.color AS stage_color,
			       c.first_name, c.last_name, u.full_name AS assigned_name
			FROM crm_deals d
			LEFT JOIN crm_pipeline_stages s ON s.id=d.stage_id
			LEFT JOIN crm_contacts c ON c.id=d.contact_id
			LEFT JOIN o3c_users u ON u.id=d.assigned_to
			WHERE %s ORDER BY d.updated_at DESC LIMIT $%d`, where, n), args...)
		if err != nil {
			respondErr(w, 500, "Query failed"); return
		}
		jsonRows(w, rows)
	}
}

func createDeal(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			ContactID         int64    `json:"contact_id"`
			Title             string   `json:"title"`
			StageID           *int64   `json:"stage_id"`
			Product           *string  `json:"product"`
			ExpectedValue     *float64 `json:"expected_value"`
			Probability       *int     `json:"probability"`
			ExpectedCloseDate *string  `json:"expected_close_date"`
			AssignedTo        *int64   `json:"assigned_to"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON"); return
		}
		if b.ContactID == 0 || b.Title == "" {
			respondErr(w, 422, "contact_id and title are required"); return
		}
		if b.StageID == nil {
			if sr, _ := db.PGQuery(r.Context(),
				"SELECT id FROM crm_pipeline_stages WHERE is_won=FALSE AND is_lost=FALSE ORDER BY order_index LIMIT 1"); len(sr) > 0 {
				sid := toInt64(sr[0]["id"])
				b.StageID = &sid
			}
		}
		prob := 50
		if b.Probability != nil {
			prob = *b.Probability
		}
		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO crm_deals
			  (contact_id, title, stage_id, product, expected_value,
			   probability, expected_close_date, assigned_to, created_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
			b.ContactID, b.Title, b.StageID, b.Product, b.ExpectedValue,
			prob, b.ExpectedCloseDate, b.AssignedTo, user.ID)
		if err != nil {
			respondErr(w, 500, "Create failed"); return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func updateDeal(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			respondErr(w, 400, "Invalid JSON"); return
		}
		parts, args := buildSet(body, dealUpdateCols, 1)
		if len(parts) == 0 {
			respondErr(w, 422, "No fields to update"); return
		}
		parts = append(parts, "updated_at=NOW()")
		args = append(args, id)
		rows, err := db.PGQuery(r.Context(),
			fmt.Sprintf("UPDATE crm_deals SET %s WHERE id=$%d RETURNING *",
				strings.Join(parts, ","), len(args)), args...)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Deal not found"); return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func deleteDeal(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		db.PGExec(r.Context(), "DELETE FROM crm_deals WHERE id=$1", chi.URLParam(r, "id")) //nolint:errcheck
		w.WriteHeader(204)
	}
}

// ── Activities ────────────────────────────────────────────────────────────────

func listActivities(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := qint(r, "limit", 100, 1, 500)
		offset := qint(r, "offset", 0, 0, 1<<30)
		where := "1=1"
		var args []any
		n := 1
		if v := qstr(r, "contact_id"); v != "" {
			where += fmt.Sprintf(" AND a.contact_id=$%d", n); args = append(args, v); n++
		}
		if v := qstr(r, "type"); v != "" {
			where += fmt.Sprintf(" AND a.type=$%d", n); args = append(args, v); n++
		}
		args = append(args, limit, offset)
		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT a.*, u.full_name AS agent_name, c.first_name, c.last_name
			FROM crm_activities a
			LEFT JOIN o3c_users    u ON u.id=a.created_by
			LEFT JOIN crm_contacts c ON c.id=a.contact_id
			WHERE %s ORDER BY a.created_at DESC LIMIT $%d OFFSET $%d`, where, n, n+1), args...)
		if err != nil {
			respondErr(w, 500, "Query failed"); return
		}
		jsonRows(w, rows)
	}
}

func createActivity(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			ContactID    int64   `json:"contact_id"`
			DealID       *int64  `json:"deal_id"`
			Type         string  `json:"type"`
			Direction    *string `json:"direction"`
			Subject      *string `json:"subject"`
			Body         *string `json:"body"`
			Outcome      *string `json:"outcome"`
			DurationMins *int    `json:"duration_mins"`
			NextFollowUp *string `json:"next_follow_up"`
			Completed    bool    `json:"completed"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON"); return
		}
		if b.ContactID == 0 || b.Type == "" {
			respondErr(w, 422, "contact_id and type are required"); return
		}
		completedAtExpr := "NULL"
		if b.Completed {
			completedAtExpr = "NOW()"
		}
		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			INSERT INTO crm_activities
			  (contact_id, deal_id, type, direction, subject, body,
			   outcome, duration_mins, next_follow_up, completed, completed_at, created_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,%s,$11) RETURNING *`, completedAtExpr),
			b.ContactID, b.DealID, b.Type, b.Direction, b.Subject, b.Body,
			b.Outcome, b.DurationMins, b.NextFollowUp, b.Completed, user.ID)
		if err != nil {
			respondErr(w, 500, "Create failed"); return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func deleteActivity(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		db.PGExec(r.Context(), "DELETE FROM crm_activities WHERE id=$1", chi.URLParam(r, "id")) //nolint:errcheck
		w.WriteHeader(204)
	}
}

// ── Tasks ─────────────────────────────────────────────────────────────────────

var taskUpdateCols = []string{
	"title", "description", "due_date", "priority", "status", "assigned_to",
}

func listTasks(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := qint(r, "limit", 200, 1, 500)
		user := core.UserFromCtx(r.Context())
		where := "1=1"
		var args []any
		n := 1

		if r.URL.Query().Get("mine") == "true" {
			where += fmt.Sprintf(" AND t.assigned_to=$%d", n)
			args = append(args, user.ID); n++
		}
		if v := qstr(r, "status"); v != "" {
			where += fmt.Sprintf(" AND t.status=$%d", n); args = append(args, v); n++
		}
		if v := qstr(r, "priority"); v != "" {
			where += fmt.Sprintf(" AND t.priority=$%d", n); args = append(args, v); n++
		}
		if v := qstr(r, "contact_id"); v != "" {
			where += fmt.Sprintf(" AND t.contact_id=$%d", n); args = append(args, v); n++
		}
		if r.URL.Query().Get("overdue") == "true" {
			where += " AND t.due_date < NOW() AND t.status NOT IN ('done','cancelled')"
		}
		args = append(args, limit)
		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT t.*, u.full_name AS assigned_name, c.first_name, c.last_name,
			       CASE WHEN t.due_date < NOW() AND t.status NOT IN ('done','cancelled') THEN TRUE ELSE FALSE END AS is_overdue
			FROM crm_tasks t
			LEFT JOIN o3c_users    u ON u.id=t.assigned_to
			LEFT JOIN crm_contacts c ON c.id=t.contact_id
			WHERE %s
			ORDER BY
			  CASE t.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
			  t.due_date ASC NULLS LAST
			LIMIT $%d`, where, n), args...)
		if err != nil {
			respondErr(w, 500, "Query failed"); return
		}
		jsonRows(w, rows)
	}
}

func createTask(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			Title       string  `json:"title"`
			ContactID   *int64  `json:"contact_id"`
			DealID      *int64  `json:"deal_id"`
			Description *string `json:"description"`
			DueDate     *string `json:"due_date"`
			Priority    *string `json:"priority"`
			AssignedTo  *int64  `json:"assigned_to"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON"); return
		}
		if b.Title == "" {
			respondErr(w, 422, "title is required"); return
		}
		pri := coalesce(deref(b.Priority), "medium")
		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO crm_tasks
			  (contact_id, deal_id, title, description, due_date, priority, assigned_to, created_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
			b.ContactID, b.DealID, b.Title, b.Description, b.DueDate, pri, b.AssignedTo, user.ID)
		if err != nil {
			respondErr(w, 500, "Create failed"); return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func updateTask(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			respondErr(w, 400, "Invalid JSON"); return
		}
		parts, args := buildSet(body, taskUpdateCols, 1)
		if len(parts) == 0 {
			respondErr(w, 422, "No fields to update"); return
		}
		parts = append(parts, "updated_at=NOW()")
		args = append(args, id)
		rows, err := db.PGQuery(r.Context(),
			fmt.Sprintf("UPDATE crm_tasks SET %s WHERE id=$%d RETURNING *",
				strings.Join(parts, ","), len(args)), args...)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Task not found"); return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func deleteTask(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		db.PGExec(r.Context(), "DELETE FROM crm_tasks WHERE id=$1", chi.URLParam(r, "id")) //nolint:errcheck
		w.WriteHeader(204)
	}
}

// ── Requests ──────────────────────────────────────────────────────────────────

var requestTypes = []string{
	"card_issue", "card_replacement", "card_upgrade",
	"dispute", "complaint", "limit_increase",
	"pin_reset", "statement_request", "account_info",
	"fraud_report", "general",
}

var requestTypesSet = func() map[string]bool {
	m := make(map[string]bool, len(requestTypes))
	for _, t := range requestTypes {
		m[t] = true
	}
	return m
}()

var requestUpdateCols = []string{
	"subject", "description", "priority", "status", "resolution",
	"assigned_to", "escalated_to",
}

func getRequestTypes() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(requestTypes) //nolint:errcheck
	}
}

func listRequests(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := qint(r, "limit", 200, 1, 500)
		offset := qint(r, "offset", 0, 0, 1<<30)
		where := "1=1"
		var args []any
		n := 1

		if v := qstr(r, "status"); v != "" {
			where += fmt.Sprintf(" AND r.status=$%d", n); args = append(args, v); n++
		}
		if v := qstr(r, "request_type"); v != "" {
			where += fmt.Sprintf(" AND r.request_type=$%d", n); args = append(args, v); n++
		}
		if v := qstr(r, "priority"); v != "" {
			where += fmt.Sprintf(" AND r.priority=$%d", n); args = append(args, v); n++
		}
		if v := qstr(r, "contact_id"); v != "" {
			where += fmt.Sprintf(" AND r.contact_id=$%d", n); args = append(args, v); n++
		}
		if r.URL.Query().Get("sla_breached") == "true" {
			where += " AND r.status NOT IN ('resolved','closed') AND r.created_at+(r.sla_hours||' hours')::INTERVAL < NOW()"
		}

		filterArgs := append([]any(nil), args...) // capture before appending limit/offset
		args = append(args, limit, offset)

		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT r.*,
			       u.full_name  AS assigned_name,
			       e.full_name  AS escalated_name,
			       c.first_name, c.last_name, c.phone,
			       cb.full_name AS created_by_name,
			       (r.created_at+(r.sla_hours||' hours')::INTERVAL) AS sla_deadline,
			       CASE WHEN r.status IN ('resolved','closed') THEN FALSE
			            WHEN r.created_at+(r.sla_hours||' hours')::INTERVAL < NOW() THEN TRUE
			            ELSE FALSE END AS sla_breached,
			       EXTRACT(EPOCH FROM (
			         LEAST(COALESCE(r.resolved_at,NOW()), r.created_at+(r.sla_hours||' hours')::INTERVAL)
			         - r.created_at
			       ))/3600 AS hours_elapsed
			FROM crm_requests r
			LEFT JOIN o3c_users    u  ON u.id =r.assigned_to
			LEFT JOIN o3c_users    e  ON e.id =r.escalated_to
			LEFT JOIN o3c_users    cb ON cb.id=r.created_by
			LEFT JOIN crm_contacts c  ON c.id =r.contact_id
			WHERE %s
			ORDER BY
			  CASE r.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
			  r.created_at DESC
			LIMIT $%d OFFSET $%d`, where, n, n+1), args...)
		if err != nil {
			respondErr(w, 500, "Query failed"); return
		}

		total := 0
		if tr, err2 := db.PGQuery(r.Context(),
			fmt.Sprintf("SELECT COUNT(*) AS n FROM crm_requests r LEFT JOIN crm_contacts c ON c.id=r.contact_id WHERE %s", where),
			filterArgs...); err2 == nil && len(tr) > 0 {
			total = int(toInt64(tr[0]["n"]))
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": rows, "total": total}) //nolint:errcheck
	}
}

func createRequest(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			RequestType string  `json:"request_type"`
			Subject     string  `json:"subject"`
			Description *string `json:"description"`
			ContactID   *int64  `json:"contact_id"`
			CIFNumber   *string `json:"cif_number"`
			Priority    *string `json:"priority"`
			SLAHours    *int    `json:"sla_hours"`
			AssignedTo  *int64  `json:"assigned_to"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON"); return
		}
		if b.Subject == "" {
			respondErr(w, 422, "subject is required"); return
		}
		if !requestTypesSet[b.RequestType] {
			b.RequestType = "general"
		}
		pri := coalesce(deref(b.Priority), "medium")
		slaH := 24
		if b.SLAHours != nil {
			slaH = *b.SLAHours
		}
		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO crm_requests
			  (contact_id, cif_number, request_type, subject, description,
			   priority, sla_hours, assigned_to, created_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
			b.ContactID, b.CIFNumber, b.RequestType, b.Subject, b.Description,
			pri, slaH, b.AssignedTo, user.ID)
		if err != nil {
			respondErr(w, 500, "Create failed"); return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func updateRequest(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			respondErr(w, 400, "Invalid JSON"); return
		}
		parts, args := buildSet(body, requestUpdateCols, 1)
		if len(parts) == 0 {
			respondErr(w, 422, "No fields to update"); return
		}
		if st, ok := body["status"].(string); ok && (st == "resolved" || st == "closed") {
			parts = append(parts, "resolved_at=NOW()")
		}
		parts = append(parts, "updated_at=NOW()")
		args = append(args, id)
		rows, err := db.PGQuery(r.Context(),
			fmt.Sprintf("UPDATE crm_requests SET %s WHERE id=$%d RETURNING *",
				strings.Join(parts, ","), len(args)), args...)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Request not found"); return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

// ── Reports ───────────────────────────────────────────────────────────────────

func crmReportOverview(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT
			  (SELECT COUNT(*) FROM crm_contacts)                                           AS total_contacts,
			  (SELECT COUNT(*) FROM crm_contacts WHERE status='lead')                       AS total_leads,
			  (SELECT COUNT(*) FROM crm_contacts WHERE status='customer')                   AS total_customers,
			  (SELECT COUNT(*) FROM crm_deals)                                              AS total_deals,
			  (SELECT COUNT(*) FROM crm_deals d JOIN crm_pipeline_stages s ON s.id=d.stage_id WHERE s.is_won)  AS won_deals,
			  (SELECT COUNT(*) FROM crm_deals d JOIN crm_pipeline_stages s ON s.id=d.stage_id WHERE s.is_lost) AS lost_deals,
			  (SELECT COUNT(*) FROM crm_activities WHERE created_at >= NOW()-INTERVAL '30 days') AS activities_30d,
			  (SELECT COUNT(*) FROM crm_tasks WHERE status='open')                          AS open_tasks,
			  (SELECT COUNT(*) FROM crm_tasks WHERE status NOT IN ('done','cancelled') AND due_date < NOW()) AS overdue_tasks,
			  (SELECT COUNT(*) FROM crm_requests WHERE status='open')                       AS open_requests,
			  (SELECT COUNT(*) FROM crm_requests
			    WHERE status NOT IN ('resolved','closed')
			    AND created_at+(sla_hours||' hours')::INTERVAL < NOW())                     AS sla_breached,
			  (SELECT ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at-created_at))/3600)::NUMERIC,1)
			    FROM crm_requests WHERE resolved_at IS NOT NULL)                            AS avg_resolution_hrs`)
		if err != nil || len(rows) == 0 {
			respondErr(w, 500, "Query failed"); return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func crmReportPipeline(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT s.name, s.color, s.order_index, s.is_won, s.is_lost,
			       COUNT(d.id) AS deal_count,
			       COALESCE(SUM(d.expected_value),0) AS pipeline_value,
			       ROUND(AVG(d.probability)::NUMERIC,1) AS avg_probability
			FROM crm_pipeline_stages s
			LEFT JOIN crm_deals d ON d.stage_id=s.id
			GROUP BY s.id,s.name,s.color,s.order_index,s.is_won,s.is_lost
			ORDER BY s.order_index`)
		if err != nil {
			respondErr(w, 500, "Query failed"); return
		}
		jsonRows(w, rows)
	}
}

func crmReportConversion(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT s.name, s.order_index, s.color, COUNT(DISTINCT d.contact_id) AS contacts
			FROM crm_pipeline_stages s
			LEFT JOIN crm_deals d ON d.stage_id=s.id
			GROUP BY s.id,s.name,s.order_index,s.color
			ORDER BY s.order_index`)
		if err != nil {
			respondErr(w, 500, "Query failed"); return
		}
		jsonRows(w, rows)
	}
}

func crmReportAgentPerformance(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		days := qint(r, "days", 30, 1, 365)
		rows, err := db.PGQuery(r.Context(), `
			SELECT u.id, u.full_name, u.role,
			       COUNT(DISTINCT a.id) FILTER (WHERE a.created_at >= NOW()-($1::int||' days')::INTERVAL) AS activities,
			       COUNT(DISTINCT d.id)                                 AS deals_owned,
			       COUNT(DISTINCT d.id) FILTER (WHERE s.is_won)        AS deals_won,
			       COUNT(DISTINCT t.id)                                 AS tasks_assigned,
			       COUNT(DISTINCT t.id) FILTER (WHERE t.status='done') AS tasks_done,
			       COUNT(DISTINCT c.id)                                 AS contacts_owned
			FROM o3c_users u
			LEFT JOIN crm_activities      a ON a.created_by =u.id
			LEFT JOIN crm_deals           d ON d.assigned_to=u.id
			LEFT JOIN crm_pipeline_stages s ON s.id=d.stage_id
			LEFT JOIN crm_tasks           t ON t.assigned_to=u.id
			LEFT JOIN crm_contacts        c ON c.assigned_to=u.id
			WHERE u.role IN ('sales','management','admin','collections','call_centre')
			GROUP BY u.id,u.full_name,u.role
			ORDER BY activities DESC NULLS LAST`, days)
		if err != nil {
			respondErr(w, 500, "Query failed"); return
		}
		jsonRows(w, rows)
	}
}

func crmReportActivityTrend(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		days := qint(r, "days", 30, 1, 180)
		rows, err := db.PGQuery(r.Context(), `
			SELECT DATE(created_at) AS day, type, COUNT(*) AS count
			FROM crm_activities
			WHERE created_at >= NOW()-($1::int||' days')::INTERVAL
			GROUP BY DATE(created_at),type ORDER BY day`, days)
		if err != nil {
			respondErr(w, 500, "Query failed"); return
		}
		jsonRows(w, rows)
	}
}

func crmReportContactsBySource(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT source, COUNT(*) AS total,
			       COUNT(*) FILTER (WHERE status='customer') AS converted
			FROM crm_contacts GROUP BY source ORDER BY total DESC`)
		if err != nil {
			respondErr(w, 500, "Query failed"); return
		}
		jsonRows(w, rows)
	}
}

func crmReportRequestsSLA(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT request_type,
			       COUNT(*) AS total,
			       COUNT(*) FILTER (WHERE status IN ('resolved','closed')) AS resolved,
			       COUNT(*) FILTER (WHERE status NOT IN ('resolved','closed')
			         AND created_at+(sla_hours||' hours')::INTERVAL < NOW()) AS sla_breached,
			       ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at-created_at))/3600)
			         FILTER (WHERE resolved_at IS NOT NULL)::NUMERIC,1) AS avg_resolution_hrs
			FROM crm_requests GROUP BY request_type ORDER BY total DESC`)
		if err != nil {
			respondErr(w, 500, "Query failed"); return
		}
		jsonRows(w, rows)
	}
}

func crmReportNewContactsTrend(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT TO_CHAR(DATE_TRUNC('month',created_at),'Mon YYYY') AS month,
			       COUNT(*) AS new_contacts,
			       COUNT(*) FILTER (WHERE status='customer') AS converted
			FROM crm_contacts
			WHERE created_at >= NOW()-INTERVAL '12 months'
			GROUP BY DATE_TRUNC('month',created_at)
			ORDER BY DATE_TRUNC('month',created_at)`)
		if err != nil {
			respondErr(w, 500, "Query failed"); return
		}
		jsonRows(w, rows)
	}
}

// deref safely dereferences a *string, returning "" for nil.
func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

func RegisterLOS(r chi.Router, db *core.DB) {
	base := core.RequirePages("los")
	all := core.RequirePages("los_all")
	assign := core.RequirePages("los_all", "los_assign")

	r.With(base).Get("/stats", losStats(db))
	r.With(base).Get("/queue", losQueue(db))
	r.With(all).Get("/all", losAll(db))
	r.With(base).Post("/", losCreate(db))
	r.With(base).Get("/{id}", losGet(db))
	r.With(assign).Put("/{id}/assign", losAssign(db))
	r.With(base).Put("/{id}/advance", losAdvance(db))
	r.With(base).Put("/{id}/decline", losDecline(db))
	r.With(base).Put("/{id}/request-info", losRequestInfo(db))
	r.With(base).Post("/{id}/conditions", losAddCondition(db))
	r.With(base).Put("/{id}/conditions/{cid}", losMarkConditionMet(db))
	r.With(base).Post("/{id}/notes", losAddNote(db))
	r.With(base).Get("/{id}/events", losGetEvents(db))
}

// allowedTransitions maps from_stage → []to_stage
var allowedTransitions = map[string][]string{
	"draft":              {"submitted"},
	"submitted":          {"document_collection"},
	"document_collection": {"risk_review"},
	"risk_review":        {"risk_head_review"},
	"risk_head_review":   {"pending_conditions"},
	"pending_conditions": {"finance_approval"},
	"finance_approval":   {"booking"},
	"booking":            {"active"},
}

func losParseID(r *http.Request) (int64, error) {
	return strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
}

func losStats(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT status, COUNT(*) AS count
			FROM loan_applications
			GROUP BY status
			ORDER BY status`)
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

func losQueue(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		limit := qint(r, "limit", 50, 1, 200)
		offset := qint(r, "offset", 0, 0, 1<<30)

		rows, err := db.PGQuery(r.Context(), `
			SELECT id, reference, applicant_name, applicant_cif, product_type,
			       amount_requested_kobo, amount_approved_kobo, status, stage,
			       assigned_to_user_id, submitted_at, created_at, updated_at
			FROM loan_applications
			WHERE assigned_to_user_id = $1
			ORDER BY updated_at DESC
			LIMIT $2 OFFSET $3`,
			user.ID, limit, offset)
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

func losAll(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		status := qstr(r, "status")
		stage := qstr(r, "stage")
		limit := qint(r, "limit", 100, 1, 500)
		offset := qint(r, "offset", 0, 0, 1<<30)

		query := `SELECT id, reference, applicant_name, applicant_cif, product_type,
		                 amount_requested_kobo, amount_approved_kobo, status, stage,
		                 assigned_to_user_id, submitted_at, created_at, updated_at
		          FROM loan_applications WHERE 1=1`
		args := []any{}
		n := 1
		if status != "" {
			query += fmt.Sprintf(" AND status = $%d", n)
			args = append(args, status)
			n++
		}
		if stage != "" {
			query += fmt.Sprintf(" AND stage = $%d", n)
			args = append(args, stage)
			n++
		}
		query += fmt.Sprintf(" ORDER BY updated_at DESC LIMIT $%d OFFSET $%d", n, n+1)
		args = append(args, limit, offset)

		rows, err := db.PGQuery(r.Context(), query, args...)
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

func losGet(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := losParseID(r)
		if err != nil {
			respondErr(w, 400, "Invalid application ID")
			return
		}
		ctx := r.Context()

		apps, err := db.PGQuery(ctx, `
			SELECT * FROM loan_applications WHERE id = $1`, id)
		if err != nil || len(apps) == 0 {
			respondErr(w, 404, "Application not found")
			return
		}

		events, _ := db.PGQuery(ctx, `
			SELECT * FROM application_events
			WHERE application_id = $1 ORDER BY created_at ASC`, id)

		conditions, _ := db.PGQuery(ctx, `
			SELECT * FROM application_conditions
			WHERE application_id = $1 ORDER BY created_at ASC`, id)

		notes, _ := db.PGQuery(ctx, `
			SELECT * FROM application_notes
			WHERE application_id = $1 ORDER BY created_at ASC`, id)

		if events == nil {
			events = []core.Row{}
		}
		if conditions == nil {
			conditions = []core.Row{}
		}
		if notes == nil {
			notes = []core.Row{}
		}

		result := map[string]any{
			"application": apps[0],
			"events":      events,
			"conditions":  conditions,
			"notes":       notes,
		}
		respond(w, result, "pg")
	}
}

func losCreate(db *core.DB) http.HandlerFunc {
	type body struct {
		ApplicantName     string `json:"applicant_name"`
		ApplicantCIF      string `json:"applicant_cif"`
		ApplicantEmail    string `json:"applicant_email"`
		ApplicantPhone    string `json:"applicant_phone"`
		ProductType       string `json:"product_type"`
		AmountRequested   int64  `json:"amount_requested_kobo"`
		TenorMonths       int    `json:"tenor_months"`
		InterestRateBPS   int    `json:"interest_rate_bps"`
		Purpose           string `json:"purpose"`
		Employer          string `json:"employer"`
		MonthlyIncome     int64  `json:"monthly_income_kobo"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.ApplicantName == "" || b.ProductType == "" {
			respondErr(w, 422, "applicant_name and product_type are required")
			return
		}

		user := core.UserFromCtx(r.Context())
		ctx := r.Context()

		// Generate reference: LOS-YYYYMM-XXXX
		now := time.Now().UTC()
		prefix := fmt.Sprintf("LOS-%s-", now.Format("200601"))
		countRows, err := db.PGQuery(ctx,
			`SELECT COUNT(*) AS c FROM loan_applications
			 WHERE reference LIKE $1`, prefix+"%")
		if err != nil {
			respondErr(w, 500, "Reference generation failed")
			return
		}
		seq := int64(1)
		if len(countRows) > 0 {
			seq = toInt64(countRows[0]["c"]) + 1
		}
		ref := fmt.Sprintf("%s%04d", prefix, seq)

		rows, err := db.PGQuery(ctx, `
			INSERT INTO loan_applications (
				reference, applicant_name, applicant_cif, applicant_email, applicant_phone,
				product_type, amount_requested_kobo, tenor_months, interest_rate_bps,
				purpose, employer, monthly_income_kobo,
				status, stage, sales_officer_id, assigned_to_user_id,
				created_at, updated_at
			) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'draft','draft',$13,$13,NOW(),NOW())
			RETURNING id, reference, status, stage`,
			ref, b.ApplicantName, b.ApplicantCIF, b.ApplicantEmail, b.ApplicantPhone,
			b.ProductType, b.AmountRequested, b.TenorMonths, b.InterestRateBPS,
			b.Purpose, b.Employer, b.MonthlyIncome, user.ID)
		if err != nil {
			respondErr(w, 500, "Create failed")
			return
		}
		respond(w, rows[0], "pg")
	}
}

func losAssign(db *core.DB) http.HandlerFunc {
	type body struct {
		AssignToUserID int64  `json:"assign_to_user_id"`
		Notes          string `json:"notes"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := losParseID(r)
		if err != nil {
			respondErr(w, 400, "Invalid application ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.AssignToUserID == 0 {
			respondErr(w, 422, "assign_to_user_id is required")
			return
		}

		user := core.UserFromCtx(r.Context())
		ctx := r.Context()

		_, err = db.PGExec(ctx,
			`UPDATE loan_applications SET assigned_to_user_id = $1, updated_at = NOW() WHERE id = $2`,
			b.AssignToUserID, id)
		if err != nil {
			respondErr(w, 500, "Assign failed")
			return
		}

		db.PGExec(ctx, `
			INSERT INTO application_events (application_id, event_type, actor_user_id, notes, created_at)
			VALUES ($1, 'assigned', $2, $3, NOW())`,
			id, user.ID, b.Notes) //nolint:errcheck

		// Notify new assignee
		sendNotification(ctx, db, b.AssignToUserID, "los_assigned",
			"Application Assigned",
			fmt.Sprintf("A loan application has been assigned to you"),
			"loan_application", id) //nolint:errcheck

		respondErr(w, 200, "Assigned successfully")
	}
}

func losAdvance(db *core.DB) http.HandlerFunc {
	type body struct {
		ToStage string `json:"to_stage"`
		Notes   string `json:"notes"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := losParseID(r)
		if err != nil {
			respondErr(w, 400, "Invalid application ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.ToStage == "" {
			respondErr(w, 422, "to_stage is required")
			return
		}

		user := core.UserFromCtx(r.Context())
		ctx := r.Context()

		apps, err := db.PGQuery(ctx, `SELECT stage, status FROM loan_applications WHERE id = $1`, id)
		if err != nil || len(apps) == 0 {
			respondErr(w, 404, "Application not found")
			return
		}
		fromStage := str(apps[0]["stage"])

		// Validate transition
		allowed := allowedTransitions[fromStage]
		ok := false
		for _, s := range allowed {
			if s == b.ToStage {
				ok = true
				break
			}
		}
		if !ok {
			respondErr(w, 422, fmt.Sprintf("Transition from '%s' to '%s' is not allowed", fromStage, b.ToStage))
			return
		}

		// Build extra field updates based on transition
		extra := ""
		switch b.ToStage {
		case "submitted":
			extra = ", submitted_at = NOW()"
		case "risk_review":
			extra = ", risk_officer_id = assigned_to_user_id"
		case "finance_approval":
			extra = ", finance_officer_id = assigned_to_user_id"
		case "booking":
			extra = ", finance_approved_at = NOW(), cards_ops_officer_id = assigned_to_user_id"
		case "active":
			extra = ", booked_at = NOW()"
		}

		_, err = db.PGExec(ctx,
			fmt.Sprintf(`UPDATE loan_applications SET stage = $1, status = $1%s, updated_at = NOW() WHERE id = $2`, extra),
			b.ToStage, id)
		if err != nil {
			respondErr(w, 500, "Advance failed")
			return
		}

		db.PGExec(ctx, `
			INSERT INTO application_events (application_id, event_type, from_stage, to_stage, actor_user_id, notes, created_at)
			VALUES ($1, 'stage_advance', $2, $3, $4, $5, NOW())`,
			id, fromStage, b.ToStage, user.ID, b.Notes) //nolint:errcheck

		respondErr(w, 200, "Stage advanced")
	}
}

func losDecline(db *core.DB) http.HandlerFunc {
	type body struct {
		Reason string `json:"reason"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := losParseID(r)
		if err != nil {
			respondErr(w, 400, "Invalid application ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Reason == "" {
			respondErr(w, 422, "reason is required")
			return
		}

		user := core.UserFromCtx(r.Context())
		ctx := r.Context()

		apps, err := db.PGQuery(ctx, `SELECT stage FROM loan_applications WHERE id = $1`, id)
		if err != nil || len(apps) == 0 {
			respondErr(w, 404, "Application not found")
			return
		}
		fromStage := str(apps[0]["stage"])

		_, err = db.PGExec(ctx,
			`UPDATE loan_applications SET status = 'declined', stage = 'declined',
			 decline_reason = $1, updated_at = NOW() WHERE id = $2`,
			b.Reason, id)
		if err != nil {
			respondErr(w, 500, "Decline failed")
			return
		}

		db.PGExec(ctx, `
			INSERT INTO application_events (application_id, event_type, from_stage, to_stage, actor_user_id, notes, created_at)
			VALUES ($1, 'declined', $2, 'declined', $3, $4, NOW())`,
			id, fromStage, user.ID, b.Reason) //nolint:errcheck

		respondErr(w, 200, "Application declined")
	}
}

func losRequestInfo(db *core.DB) http.HandlerFunc {
	type body struct {
		Notes string `json:"notes"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := losParseID(r)
		if err != nil {
			respondErr(w, 400, "Invalid application ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}

		user := core.UserFromCtx(r.Context())
		ctx := r.Context()

		apps, err := db.PGQuery(ctx,
			`SELECT stage, request_info_count FROM loan_applications WHERE id = $1`, id)
		if err != nil || len(apps) == 0 {
			respondErr(w, 404, "Application not found")
			return
		}

		count := int(toInt64(apps[0]["request_info_count"]))
		if count >= 2 {
			respondErr(w, 422, "Maximum request-info cycles (2) already reached")
			return
		}

		fromStage := str(apps[0]["stage"])

		// Find previous stage to revert to
		prevStage := "document_collection"
		stageOrder := []string{
			"draft", "submitted", "document_collection", "risk_review",
			"risk_head_review", "pending_conditions", "finance_approval", "booking",
		}
		for i, s := range stageOrder {
			if s == fromStage && i > 0 {
				prevStage = stageOrder[i-1]
				break
			}
		}

		_, err = db.PGExec(ctx,
			`UPDATE loan_applications SET stage = $1, status = $1,
			 request_info_count = request_info_count + 1, updated_at = NOW() WHERE id = $2`,
			prevStage, id)
		if err != nil {
			respondErr(w, 500, "Request info failed")
			return
		}

		db.PGExec(ctx, `
			INSERT INTO application_events (application_id, event_type, from_stage, to_stage, actor_user_id, notes, created_at)
			VALUES ($1, 'request_info', $2, $3, $4, $5, NOW())`,
			id, fromStage, prevStage, user.ID, b.Notes) //nolint:errcheck

		respondErr(w, 200, "Sent back for more information")
	}
}

func losAddCondition(db *core.DB) http.HandlerFunc {
	type body struct {
		ConditionText string `json:"condition_text"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := losParseID(r)
		if err != nil {
			respondErr(w, 400, "Invalid application ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.ConditionText == "" {
			respondErr(w, 422, "condition_text is required")
			return
		}

		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO application_conditions (application_id, condition_text, is_met, created_at)
			VALUES ($1, $2, FALSE, NOW())
			RETURNING id, condition_text, is_met, created_at`,
			id, b.ConditionText)
		if err != nil {
			respondErr(w, 500, "Create condition failed")
			return
		}
		respond(w, rows[0], "pg")
	}
}

func losMarkConditionMet(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := losParseID(r)
		if err != nil {
			respondErr(w, 400, "Invalid application ID")
			return
		}
		cid, err := strconv.ParseInt(chi.URLParam(r, "cid"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid condition ID")
			return
		}

		user := core.UserFromCtx(r.Context())

		_, err = db.PGExec(r.Context(), `
			UPDATE application_conditions
			SET is_met = TRUE, met_by = $1, met_at = NOW()
			WHERE id = $2 AND application_id = $3`,
			user.ID, cid, id)
		if err != nil {
			respondErr(w, 500, "Update failed")
			return
		}
		respondErr(w, 200, "Condition marked as met")
	}
}

func losAddNote(db *core.DB) http.HandlerFunc {
	type body struct {
		Body       string `json:"body"`
		IsInternal bool   `json:"is_internal"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := losParseID(r)
		if err != nil {
			respondErr(w, 400, "Invalid application ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Body == "" {
			respondErr(w, 422, "body is required")
			return
		}

		user := core.UserFromCtx(r.Context())

		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO application_notes (application_id, author_id, body, is_internal, created_at)
			VALUES ($1, $2, $3, $4, NOW())
			RETURNING id, body, is_internal, created_at`,
			id, user.ID, b.Body, b.IsInternal)
		if err != nil {
			respondErr(w, 500, "Add note failed")
			return
		}
		respond(w, rows[0], "pg")
	}
}

func losGetEvents(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := losParseID(r)
		if err != nil {
			respondErr(w, 400, "Invalid application ID")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT e.*, u.full_name AS actor_name
			FROM application_events e
			LEFT JOIN o3c_users u ON e.actor_user_id = u.id
			WHERE e.application_id = $1
			ORDER BY e.created_at ASC`, id)
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

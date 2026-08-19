package handlers

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

func RegisterLOS(r chi.Router, db *core.DB) {
	base := core.RequirePages("los")
	all := core.RequirePages("los_all")
	assign := core.RequirePages("los_all", "los_assign")

	r.With(base).Get("/stats", losStats(db))
	r.With(base).Get("/funnel", losFunnel(db))
	r.With(base).Get("/overview", losOverview(db))
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
	r.With(base).Put("/{id}/credit-assessment", losSaveCreditAssessment(db))
	r.With(base).Get("/{id}/documents", losGetDocuments(db))
	r.With(base).Post("/{id}/documents", losUploadDocument(db))
	r.With(base).Delete("/documents/{doc_id}", losDeleteDocument(db))
	r.With(base).Get("/team-users", losTeamUsers(db))
	r.With(base).Get("/{id}/messages", losGetMessages(db))
	r.With(base).Post("/{id}/messages", losPostMessage(db))
	r.With(base).Get("/{id}/eye-report", losEyeReport(db))
}

// allowedTransitions maps from_stage → []to_stage
var allowedTransitions = map[string][]string{
	"draft":               {"submitted"},
	"submitted":           {"document_collection"},
	"document_collection": {"risk_review"},
	"risk_review":         {"risk_head_review"},
	"risk_head_review":    {"pending_conditions"},
	"pending_conditions":  {"finance_approval"},
	"finance_approval":    {"booking"},
	"booking":             {"active"},
}

// transitionRequiredPage maps "from:to" → the LOS page that authorises that transition.
// Any user with "los_all" may bypass the per-transition check (supervisor override).
var transitionRequiredPage = map[string]string{
	"draft:submitted":                     "los",
	"submitted:document_collection":       "los",
	"document_collection:risk_review":     "los_risk_review",
	"risk_review:risk_head_review":        "los_risk_review",
	"risk_head_review:pending_conditions": "los_risk_head",
	"pending_conditions:finance_approval": "los_finance",
	"finance_approval:booking":            "los_finance_approve",
	"booking:active":                      "los_booking",
}

func losParseID(r *http.Request) (int64, error) {
	return strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
}

func losStats(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		byStatus, err := db.PGQuery(ctx, `
			SELECT status, COUNT(*) AS count
			FROM loan_applications
			GROUP BY status
			ORDER BY status`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if byStatus == nil {
			byStatus = []core.Row{}
		}

		// Pipeline value grouped by stage — used for funnel and header KPI.
		byStage, err := db.PGQuery(ctx, `
			SELECT stage,
			       COUNT(*)                                          AS count,
			       COALESCE(SUM(amount_requested_kobo), 0)          AS pipeline_kobo,
			       COALESCE(SUM(amount_approved_kobo),  0)          AS approved_kobo
			FROM loan_applications
			WHERE stage NOT IN ('declined', 'active', 'closed')
			GROUP BY stage
			ORDER BY stage`)
		if err != nil {
			respondErr(w, 500, "Stage query failed")
			return
		}
		if byStage == nil {
			byStage = []core.Row{}
		}

		// Total pipeline and avg days to close
		totals, _ := db.PGQuery(ctx, `
			SELECT
				COALESCE(SUM(CASE WHEN stage NOT IN ('declined','active','closed') THEN amount_requested_kobo END), 0) AS total_pipeline_kobo,
				COALESCE(SUM(CASE WHEN stage = 'active' THEN amount_approved_kobo END), 0)                           AS total_disbursed_kobo,
				COUNT(CASE WHEN stage NOT IN ('declined','active','closed') THEN 1 END)                              AS open_count,
				COALESCE(AVG(CASE WHEN stage IN ('active','declined') THEN EXTRACT(EPOCH FROM (updated_at - created_at))/86400 END), 0) AS avg_days_to_close
			FROM loan_applications`)

		resp := map[string]any{
			"by_status": byStatus,
			"by_stage":  byStage,
		}
		if len(totals) > 0 {
			resp["total_pipeline_kobo"] = totals[0]["total_pipeline_kobo"]
			resp["total_disbursed_kobo"] = totals[0]["total_disbursed_kobo"]
			resp["open_count"] = totals[0]["open_count"]
			resp["avg_days_to_close"] = totals[0]["avg_days_to_close"]
		}
		respond(w, resp, "pg")
	}
}

func losQueue(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		limit := qint(r, "limit", 50, 1, 200)
		// M10: cursor-based pagination via after_id (keyset on updated_at + id).
		// Falls back to offset-based when after_id is absent for backwards compatibility.
		afterID := qint(r, "after_id", 0, 0, 1<<62)

		var rows []core.Row
		var err error
		if afterID > 0 {
			// Keyset pagination: fetch records older than the cursor row.
			rows, err = db.PGQuery(r.Context(), `
				SELECT la.id, la.reference, la.applicant_name, la.applicant_cif, la.product_type,
				       la.amount_requested_kobo, la.amount_approved_kobo, la.status, la.stage,
				       la.assigned_to_user_id, la.submitted_at, la.disbursed_at, la.created_at, la.updated_at,
				       u.full_name AS assigned_officer_name
				FROM loan_applications la
				LEFT JOIN o3c_users u ON u.id = la.assigned_to_user_id
				WHERE la.assigned_to_user_id = $1
				  AND (la.updated_at, la.id) < (
				      SELECT updated_at, id FROM loan_applications WHERE id = $2
				  )
				ORDER BY la.updated_at DESC, la.id DESC
				LIMIT $3`,
				user.ID, afterID, limit)
		} else {
			offset := qint(r, "offset", 0, 0, 1<<30)
			// H3: join users table so assigned_officer_name is available without a second fetch.
			rows, err = db.PGQuery(r.Context(), `
				SELECT la.id, la.reference, la.applicant_name, la.applicant_cif, la.product_type,
				       la.amount_requested_kobo, la.amount_approved_kobo, la.status, la.stage,
				       la.assigned_to_user_id, la.submitted_at, la.disbursed_at, la.created_at, la.updated_at,
				       u.full_name AS assigned_officer_name
				FROM loan_applications la
				LEFT JOIN o3c_users u ON u.id = la.assigned_to_user_id
				WHERE la.assigned_to_user_id = $1
				ORDER BY la.updated_at DESC, la.id DESC
				LIMIT $2 OFFSET $3`,
				user.ID, limit, offset)
		}
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		// Include next cursor in response so frontend knows how to fetch next page.
		var nextCursor int64
		if len(rows) == limit {
			nextCursor = toInt64(rows[len(rows)-1]["id"])
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"data":        rows,
			"next_cursor": nextCursor,
			"has_more":    nextCursor > 0,
		})
	}
}

func losAll(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		status := qstr(r, "status")
		stage := qstr(r, "stage")
		limit := qint(r, "limit", 100, 1, 500)
		// M24: cursor-based pagination via after_id; falls back to offset.
		afterID := qint(r, "after_id", 0, 0, 1<<62)
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
		if afterID > 0 {
			query += fmt.Sprintf(` AND (updated_at, id) < (SELECT updated_at, id FROM loan_applications WHERE id=$%d)`, n)
			args = append(args, afterID)
			n++
			query += fmt.Sprintf(" ORDER BY updated_at DESC, id DESC LIMIT $%d", n)
			args = append(args, limit)
		} else {
			query += fmt.Sprintf(" ORDER BY updated_at DESC LIMIT $%d OFFSET $%d", n, n+1)
			args = append(args, limit, offset)
		}

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
		ApplicantName   string `json:"applicant_name"`
		ApplicantCIF    string `json:"applicant_cif"`
		ApplicantEmail  string `json:"applicant_email"`
		ApplicantPhone  string `json:"applicant_phone"`
		ProductType     string `json:"product_type"`
		AmountRequested int64  `json:"amount_requested_kobo"`
		TenorMonths     int    `json:"tenor_months"`
		InterestRateBPS int    `json:"interest_rate_bps"`
		Purpose         string `json:"purpose"`
		Employer        string `json:"employer"`
		MonthlyIncome   int64  `json:"monthly_income_kobo"`
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

		// Generate reference: LOS-YYYYMM-XXXX using a sequence to avoid TOCTOU races
		now := time.Now().UTC()
		seqRow, err := db.PGQuery(ctx, `SELECT nextval('los_ref_seq') AS seq`)
		if err != nil || len(seqRow) == 0 {
			respondErr(w, 500, "Reference generation failed")
			return
		}
		seq := toInt64(seqRow[0]["seq"])
		ref := fmt.Sprintf("LOS-%s-%04d", now.Format("200601"), seq)

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

		respondOK(w, "Assigned successfully")
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

		user := core.UserFromCtx(r.Context())
		ctx := r.Context()

		// source_system is read so the Phoenix hand-off below can skip applications
		// Phoenix originated — sending one back would create a duplicate over there.
		apps, err := db.PGQuery(ctx, `SELECT stage, status, reference, amount_approved_kobo, amount_requested_kobo, sales_officer_id, COALESCE(source_system,'workspace') AS source_system FROM loan_applications WHERE id = $1`, id)
		if err != nil || len(apps) == 0 {
			respondErr(w, 404, "Application not found")
			return
		}
		fromStage := str(apps[0]["stage"])

		// The pipeline is linear — every stage has exactly one successor — so an omitted
		// to_stage resolves to that successor rather than failing. The Risk App Review
		// screen posted only {notes} and got a 422 on every click; rather than teach one
		// caller the stage machine, the server answers the question it already knows.
		// Ambiguity (0 or >1 successors) still 422s, so branching stages added later
		// cannot silently pick a path.
		if b.ToStage == "" {
			next := allowedTransitions[fromStage]
			if len(next) != 1 {
				respondErr(w, 422, fmt.Sprintf(
					"to_stage is required: stage '%s' has %d possible next stages", fromStage, len(next)))
				return
			}
			b.ToStage = next[0]
		}
		loanRef := str(apps[0]["reference"])
		loanKobo := toInt64(apps[0]["amount_approved_kobo"])
		if loanKobo == 0 {
			loanKobo = toInt64(apps[0]["amount_requested_kobo"])
		}
		salesOfficerID := toInt64(apps[0]["sales_officer_id"])

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

		// Check that the user's role is authorised for this specific transition.
		// los_all acts as a supervisor override (managers can advance any stage).
		if reqPage := transitionRequiredPage[fromStage+":"+b.ToStage]; reqPage != "" {
			if !user.HasPage(reqPage) && !user.HasPage("los_all") {
				respondErr(w, 403, fmt.Sprintf("Your role is not authorised to advance from '%s' to '%s'", fromStage, b.ToStage))
				return
			}
		} else {
			// Transition is allowed but has no mapped page requirement — deny by default so
			// future transitions added to allowedTransitions without a corresponding entry in
			// transitionRequiredPage don't silently become open to all authenticated users.
			if !user.HasPage("los_all") {
				respondErr(w, 403, fmt.Sprintf("Your role is not authorised to advance from '%s' to '%s'", fromStage, b.ToStage))
				return
			}
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

		// Wrap UPDATE + event INSERT in a transaction so the audit trail is always consistent.
		tx, err := db.PG.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
		if err != nil {
			respondErr(w, 500, "Transaction failed")
			return
		}
		defer tx.Rollback() //nolint:errcheck

		// Conditional UPDATE: only succeeds if stage hasn't changed since we read it (optimistic lock).
		var updatedID int64
		err = tx.QueryRowContext(ctx,
			fmt.Sprintf(`UPDATE loan_applications SET stage = $1, status = $2%s, updated_at = NOW()
			             WHERE id = $3 AND stage = $4 RETURNING id`, extra),
			b.ToStage, losStageToStatus(b.ToStage), id, fromStage).Scan(&updatedID)
		if err == sql.ErrNoRows {
			respondErr(w, 409, "Application stage changed concurrently — please refresh and try again")
			return
		}
		if err != nil {
			respondErr(w, 500, "Advance failed")
			return
		}

		_, err = tx.ExecContext(ctx, `
			INSERT INTO application_events (application_id, event_type, from_stage, to_stage, actor_user_id, notes, created_at)
			VALUES ($1, 'stage_advance', $2, $3, $4, $5, NOW())`,
			id, fromStage, b.ToStage, user.ID, b.Notes)
		if err != nil {
			respondErr(w, 500, "Event log failed")
			return
		}

		// Post GL entry when loan is activated (disbursed)
		if b.ToStage == "active" && loanKobo > 0 {
			if err = postJournalTx(ctx, tx, glEntry{
				Date:          time.Now(),
				Description:   fmt.Sprintf("Loan disbursement — %s", loanRef),
				Reference:     loanRef,
				DebitAccount:  "1100", // Loan Receivable
				CreditAccount: "1001", // Cash/Bank Clearing
				AmountKobo:    loanKobo,
				SourceType:    "loan_disbursement",
				SourceID:      id,
				PostedBy:      user.ID,
			}); err != nil {
				respondErr(w, 500, "GL journal post failed")
				return
			}
		}

		if err = tx.Commit(); err != nil {
			respondErr(w, 500, "Commit failed")
			return
		}

		// Post-commit notifications (non-blocking)
		switch b.ToStage {
		case "submitted":
			go NotifyRoles(context.Background(), db, []string{"risk_officer", "risk_head"}, NotifPayload{
				EventType: EvtLoanSubmitted,
				Title:     "New Loan Application Submitted",
				Body:      fmt.Sprintf("Application %s is ready for risk review", loanRef),
				ActionURL: fmt.Sprintf("/operations/risk/applications/%d", id),
				EntityRef: fmt.Sprintf("loan_application:%d", id),
			})
		case "risk_review":
			if salesOfficerID != 0 && salesOfficerID != user.ID {
				go Notify(context.Background(), db, NotifPayload{
					EventType: EvtLoanStageChanged,
					UserID:    salesOfficerID,
					Title:     "Application sent to Risk Review",
					Body:      fmt.Sprintf("Application %s has been sent to risk review", loanRef),
					ActionURL: fmt.Sprintf("/sales/applications/%d", id),
					EntityRef: fmt.Sprintf("loan_application:%d", id),
				})
			}
			// Hand off to Phoenix for a credit decision. risk_review is the right
			// trigger: documents have been collected, so this is the first moment the
			// application is complete enough to decide on.
			//
			// Queued, not called inline — a Phoenix restart or a slow decision must not
			// fail the officer's click. Skipped for applications Phoenix originated
			// (they are already decisioned there) and a no-op until Phoenix is
			// configured, at which point the worker drains the backlog.
			if str(apps[0]["source_system"]) != "phoenix" {
				go func() {
					if err := phoenixEnqueue(context.WithoutCancel(ctx), db, id); err != nil {
						slog.Error("phoenix enqueue failed", "application_id", id, "err", err)
					}
				}()
			}
		case "pending_conditions":
			go NotifyRole(context.Background(), db, "risk_head", NotifPayload{
				EventType: EvtLoanStageChanged,
				Title:     "Application ready for condition tracking",
				Body:      fmt.Sprintf("Application %s is ready for condition tracking", loanRef),
				ActionURL: fmt.Sprintf("/operations/risk/applications/%d", id),
				EntityRef: fmt.Sprintf("loan_application:%d", id),
			})
		case "finance_approval":
			go NotifyRole(context.Background(), db, "finance_officer", NotifPayload{
				EventType: EvtLoanStageChanged,
				Title:     "Application ready for finance approval",
				Body:      fmt.Sprintf("Application %s is ready for finance approval", loanRef),
				ActionURL: fmt.Sprintf("/operations/risk/applications/%d", id),
				EntityRef: fmt.Sprintf("loan_application:%d", id),
			})
		case "booking":
			go NotifyRole(context.Background(), db, "finance_head", NotifPayload{
				EventType: EvtLoanStageChanged,
				Title:     "Application approved — ready for booking",
				Body:      fmt.Sprintf("Application %s has been approved and is ready for booking", loanRef),
				ActionURL: fmt.Sprintf("/operations/risk/applications/%d", id),
				EntityRef: fmt.Sprintf("loan_application:%d", id),
			})
		case "active":
			go NotifyRole(context.Background(), db, "finance_head", NotifPayload{
				EventType: EvtLoanApproved,
				Title:     "Loan Disbursed",
				Body:      fmt.Sprintf("Application %s has been disbursed", loanRef),
				ActionURL: fmt.Sprintf("/sales/applications/%d", id),
				EntityRef: fmt.Sprintf("loan_application:%d", id),
			})
			if salesOfficerID != 0 && salesOfficerID != user.ID {
				go Notify(context.Background(), db, NotifPayload{
					EventType: EvtLoanApproved,
					UserID:    salesOfficerID,
					Title:     "Loan Application Disbursed",
					Body:      fmt.Sprintf("Application %s has been approved and disbursed", loanRef),
					ActionURL: fmt.Sprintf("/sales/applications/%d", id),
					EntityRef: fmt.Sprintf("loan_application:%d", id),
				})
			}
		}

		respondOK(w, "Stage advanced")
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

		apps, err := db.PGQuery(ctx, `SELECT stage, sales_officer_id, reference FROM loan_applications WHERE id = $1`, id)
		if err != nil || len(apps) == 0 {
			respondErr(w, 404, "Application not found")
			return
		}
		fromStage := str(apps[0]["stage"])
		declSalesID := toInt64(apps[0]["sales_officer_id"])
		loanRefDecl := str(apps[0]["reference"])

		// Atomic decline: guard against concurrent state changes and terminal stages
		updated, err := db.PGQuery(ctx,
			`UPDATE loan_applications SET status = 'declined', stage = 'declined',
			 decline_reason = $1, updated_at = NOW()
			 WHERE id = $2 AND stage = $3 AND stage NOT IN ('active', 'declined')
			 RETURNING id`,
			b.Reason, id, fromStage)
		if err != nil {
			respondErr(w, 500, "Decline failed")
			return
		}
		if len(updated) == 0 {
			respondErr(w, 409, "Application is already in a terminal state or was updated concurrently")
			return
		}

		db.PGExec(ctx, `
			INSERT INTO application_events (application_id, event_type, from_stage, to_stage, actor_user_id, notes, created_at)
			VALUES ($1, 'declined', $2, 'declined', $3, $4, NOW())`,
			id, fromStage, user.ID, b.Reason) //nolint:errcheck

		if declSalesID != 0 && declSalesID != user.ID {
			go Notify(context.Background(), db, NotifPayload{
				EventType: EvtLoanRejected,
				UserID:    declSalesID,
				Title:     "Loan Application Declined",
				Body:      fmt.Sprintf("Application %s has been declined: %s", loanRefDecl, b.Reason),
				ActionURL: fmt.Sprintf("/sales/applications/%d", id),
				EntityRef: fmt.Sprintf("loan_application:%d", id),
			})
		}

		respondOK(w, "Application declined")
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
			`UPDATE loan_applications SET stage = $1, status = $2,
			 request_info_count = request_info_count + 1, updated_at = NOW() WHERE id = $3`,
			prevStage, losStageToStatus(prevStage), id)
		if err != nil {
			respondErr(w, 500, "Request info failed")
			return
		}

		db.PGExec(ctx, `
			INSERT INTO application_events (application_id, event_type, from_stage, to_stage, actor_user_id, notes, created_at)
			VALUES ($1, 'request_info', $2, $3, $4, $5, NOW())`,
			id, fromStage, prevStage, user.ID, b.Notes) //nolint:errcheck

		respondOK(w, "Sent back for more information")
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
		respondOK(w, "Condition marked as met")
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

func losFunnel(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT
				stage,
				COUNT(*)                                                                     AS count,
				COALESCE(SUM(amount_requested_kobo), 0)                                     AS pipeline_kobo,
				COALESCE(AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) / 86400.0), 0)  AS avg_days_in_stage
			FROM loan_applications
			GROUP BY stage
			ORDER BY
				CASE stage
					WHEN 'draft'             THEN 1
					WHEN 'submitted'         THEN 2
					WHEN 'document_collection' THEN 3
					WHEN 'risk_review'       THEN 4
					WHEN 'risk_head_review'  THEN 5
					WHEN 'pending_conditions' THEN 6
					WHEN 'finance_approval'  THEN 7
					WHEN 'booking'           THEN 8
					WHEN 'active'            THEN 9
					WHEN 'declined'          THEN 10
					ELSE 11
				END`)
		if err != nil {
			respondErr(w, 500, "Funnel query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

// losOverview returns the loan pipeline as { by_stage: [{stage, count}] } in
// canonical stage order, excluding terminal (declined/closed) applications.
// Consumed by the marketing acquisition funnel (LOS Pipeline column).
func losOverview(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT stage, COUNT(*) AS count
			FROM loan_applications
			WHERE stage NOT IN ('declined', 'closed')
			GROUP BY stage
			ORDER BY
				CASE stage
					WHEN 'draft'               THEN 1
					WHEN 'submitted'           THEN 2
					WHEN 'document_collection' THEN 3
					WHEN 'risk_review'         THEN 4
					WHEN 'risk_head_review'    THEN 5
					WHEN 'pending_conditions'  THEN 6
					WHEN 'finance_approval'    THEN 7
					WHEN 'booking'             THEN 8
					WHEN 'active'              THEN 9
					ELSE 10
				END`)
		if err != nil {
			respondErr(w, 500, "LOS overview query failed")
			return
		}
		byStage := make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			byStage = append(byStage, map[string]any{
				"stage": str(row["stage"]), "count": toInt64(row["count"]),
			})
		}
		respond(w, map[string]any{"by_stage": byStage}, "pg")
	}
}

func losSaveCreditAssessment(db *core.DB) http.HandlerFunc {
	type body struct {
		EyeScore              *int     `json:"eye_score"`
		EyeRating             string   `json:"eye_rating"`
		BureauSummary         string   `json:"bureau_summary"`
		DtiPct                *float64 `json:"dti_pct"`
		MonthlyIncomeKobo     *int64   `json:"monthly_income_kobo"`
		MonthlyObligationKobo *int64   `json:"monthly_obligation_kobo"`
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
		ns := func(s string) any {
			if s == "" {
				return nil
			}
			return s
		}
		ctx := r.Context()
		rows, err := db.PGQuery(ctx,
			`UPDATE loan_applications
			 SET eye_score=$1, eye_rating=$2, bureau_summary=$3, dti_pct=$4,
			     monthly_income_kobo=$5, monthly_obligation_kobo=$6, updated_at=NOW()
			 WHERE id=$7 RETURNING id, eye_score, eye_rating, bureau_summary, dti_pct,
			     monthly_income_kobo, monthly_obligation_kobo`,
			b.EyeScore, ns(b.EyeRating), ns(b.BureauSummary),
			b.DtiPct, b.MonthlyIncomeKobo, b.MonthlyObligationKobo, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 500, "Update failed")
			return
		}
		respond(w, rows[0], "json")
	}
}

// losStageToStatus maps a LOS workflow stage to its canonical status value.
func losStageToStatus(stage string) string {
	switch stage {
	case "approved", "booking":
		return "approved"
	case "declined", "rejected":
		return "declined"
	case "active":
		return "active"
	default:
		return "pending"
	}
}

// ── LOS Document Upload ────────────────────────────────────────────────────────

func losGetDocuments(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		appID, err := losParseID(r)
		if err != nil {
			respondErr(w, 400, "invalid application id")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT d.id, d.application_id, d.doc_type, d.file_name, d.file_url,
			       d.file_size_bytes, d.created_at,
			       u.full_name AS uploaded_by_name
			FROM los_documents d
			LEFT JOIN o3c_users u ON u.id = d.uploaded_by
			WHERE d.application_id = $1
			ORDER BY d.created_at ASC`, appID)
		if err != nil {
			respondErr(w, 500, "query failed: "+err.Error())
			return
		}
		jsonRows(w, rows)
	}
}

func losUploadDocument(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		appID, err := losParseID(r)
		if err != nil {
			respondErr(w, 400, "invalid application id")
			return
		}
		user := core.UserFromCtx(r.Context())

		if err := r.ParseMultipartForm(20 << 20); err != nil {
			respondErr(w, 400, "failed to parse form")
			return
		}
		docType := r.FormValue("doc_type")
		if docType == "" {
			respondErr(w, 400, "doc_type is required")
			return
		}

		file, header, err := r.FormFile("file")
		if err != nil {
			respondErr(w, 400, "field 'file' is required")
			return
		}
		defer file.Close()

		data, err := io.ReadAll(file)
		if err != nil {
			respondErr(w, 500, "failed to read file")
			return
		}

		contentType := header.Header.Get("Content-Type")
		if contentType == "" {
			contentType = "application/octet-stream"
		}

		filename := strings.ReplaceAll(header.Filename, " ", "_")
		uid := fmt.Sprintf("%d", time.Now().UnixNano())

		accountID := os.Getenv("R2_ACCOUNT_ID")
		bucketName := os.Getenv("R2_BUCKET_NAME")
		accessKey := os.Getenv("R2_ACCESS_KEY_ID")
		secretKey := os.Getenv("R2_SECRET_ACCESS_KEY")
		r2Configured := accountID != "" && bucketName != "" && accessKey != "" && secretKey != ""

		var fileURL, storageKey string

		if r2Configured {
			storageKey = fmt.Sprintf("los-documents/%d/%s/%s", appID, uid, filename)
			endpoint := fmt.Sprintf("https://%s.r2.cloudflarestorage.com/%s/%s",
				accountID, bucketName, storageKey)
			if err := r2Put(endpoint, accessKey, secretKey, accountID, bucketName, storageKey, contentType, data); err != nil {
				slog.Warn("losUploadDocument: R2 upload failed", "err", err)
				respondErr(w, 502, "file upload failed: "+err.Error())
				return
			}
			publicBase := strings.TrimRight(os.Getenv("R2_PUBLIC_BASE_URL"), "/")
			if publicBase != "" {
				fileURL = publicBase + "/" + storageKey
			} else {
				fileURL = endpoint
			}
		} else {
			// Local fallback
			dir := fmt.Sprintf("/tmp/los-documents/%d/%s", appID, uid)
			if err := os.MkdirAll(dir, 0755); err != nil {
				respondErr(w, 500, "storage error")
				return
			}
			dest := fmt.Sprintf("%s/%s", dir, filename)
			if err := os.WriteFile(dest, data, 0644); err != nil {
				respondErr(w, 500, "write error")
				return
			}
			storageKey = dest
			fileURL = fmt.Sprintf("/api/los/documents/file/%d/%s/%s", appID, uid, filename)
		}

		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO los_documents
			    (application_id, doc_type, file_name, file_url, storage_key, file_size_bytes, uploaded_by)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
			RETURNING id, application_id, doc_type, file_name, file_url, file_size_bytes, created_at`,
			appID, docType, filename, fileURL, storageKey, len(data), user.ID)
		if err != nil {
			respondErr(w, 500, "db insert failed: "+err.Error())
			return
		}
		if len(rows) == 0 {
			respondErr(w, 500, "insert returned no rows")
			return
		}
		respond(w, rows[0], "json")
	}
}

func losDeleteDocument(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		docID, err := strconv.ParseInt(chi.URLParam(r, "doc_id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "invalid doc id")
			return
		}
		user := core.UserFromCtx(r.Context())

		// Allow deleting own uploads or if user has los_all permission.
		rows, err := db.PGQuery(r.Context(),
			`SELECT id, uploaded_by FROM los_documents WHERE id = $1`, docID)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "document not found")
			return
		}
		uploadedBy := toInt64(rows[0]["uploaded_by"])
		if uploadedBy != user.ID && !user.HasPage("los_all") {
			respondErr(w, 403, "cannot delete another user's upload")
			return
		}

		if _, err := db.PGExec(r.Context(),
			`DELETE FROM los_documents WHERE id = $1`, docID); err != nil {
			respondErr(w, 500, "delete failed: "+err.Error())
			return
		}
		w.WriteHeader(204)
	}
}

// ── LOS Messaging ─────────────────────────────────────────────────────────────

func losTeamUsers(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(),
			`SELECT id, full_name, role FROM o3c_users WHERE is_active = TRUE ORDER BY full_name ASC`)
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

func losGetMessages(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := losParseID(r)
		if err != nil {
			respondErr(w, 400, "Invalid application ID")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT * FROM application_messages
			WHERE application_id = $1
			ORDER BY created_at ASC`, id)
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

func losPostMessage(db *core.DB) http.HandlerFunc {
	type body struct {
		Body       string  `json:"body"`
		MentionIDs []int64 `json:"mention_ids"`
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
		if b.MentionIDs == nil {
			b.MentionIDs = []int64{}
		}

		user := core.UserFromCtx(r.Context())
		ctx := r.Context()

		apps, err := db.PGQuery(ctx, `SELECT reference FROM loan_applications WHERE id = $1`, id)
		if err != nil || len(apps) == 0 {
			respondErr(w, 404, "Application not found")
			return
		}
		loanRef := str(apps[0]["reference"])

		mentionJSON, _ := json.Marshal(b.MentionIDs)
		rows, err := db.PGQuery(ctx, `
			INSERT INTO application_messages
			    (application_id, author_user_id, author_name, author_role, body, mention_ids, msg_type)
			VALUES ($1, $2, $3, $4, $5, $6, 'message')
			RETURNING id, application_id, author_user_id, author_name, author_role, body, mention_ids, msg_type, created_at`,
			id, user.ID, user.FullName, user.Role, b.Body, string(mentionJSON))
		if err != nil {
			respondErr(w, 500, "Insert failed")
			return
		}

		// Notify mentioned users (skip self)
		actionURL := fmt.Sprintf("/operations/risk/applications/%d", id)
		if loanRef == "" {
			actionURL = fmt.Sprintf("/sales/applications/%d", id)
		}
		for _, mentionID := range b.MentionIDs {
			if mentionID == user.ID {
				continue
			}
			mid := mentionID
			go Notify(context.Background(), db, NotifPayload{
				EventType: EvtLoanStageChanged,
				UserID:    mid,
				Title:     fmt.Sprintf("You were mentioned in %s", loanRef),
				Body:      fmt.Sprintf("%s mentioned you: %.100s", user.FullName, b.Body),
				ActionURL: actionURL,
				EntityRef: fmt.Sprintf("loan_application:%d", id),
			})
		}

		respond(w, rows[0], "pg")
	}
}

// losEyeReport proxies to the Phoenix OS Eye scoring service.
// On the first call it scores on demand and caches the Eye application_id (eye_report_id).
// Subsequent calls retrieve the cached decision via GET instead of re-scoring.
func losEyeReport(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		eyeURL := strings.TrimRight(os.Getenv("EYE_SERVICE_URL"), "/")
		eyeKey := os.Getenv("EYE_SERVICE_KEY")
		eyeTenant := os.Getenv("EYE_TENANT_ID")

		if eyeURL == "" {
			respondErr(w, 503, "Eye service not configured — set EYE_SERVICE_URL")
			return
		}

		appID, err := losParseID(r)
		if err != nil {
			respondErr(w, 400, "Invalid application ID")
			return
		}

		appRows, err := db.PGQuery(r.Context(), `
			SELECT applicant_cif,
			       COALESCE(amount_requested_kobo, 0)   AS amount_requested_kobo,
			       COALESCE(tenor_months, 0)             AS tenor_months,
			       COALESCE(monthly_income_kobo, 0)      AS monthly_income_kobo,
			       COALESCE(monthly_obligation_kobo, 0)  AS monthly_obligation_kobo,
			       COALESCE(eye_report_id, '')            AS eye_report_id
			FROM loan_applications WHERE id = $1`, appID)
		if err != nil || len(appRows) == 0 {
			respondErr(w, 404, "Application not found")
			return
		}
		app := appRows[0]

		eyeReportID := str(app["eye_report_id"])

		var eyeHTTPReq *http.Request
		if eyeReportID != "" {
			eyeHTTPReq, err = http.NewRequestWithContext(r.Context(), "GET",
				eyeURL+"/score/internal/"+eyeReportID, nil)
		} else {
			incomeKobo := int64(0)
			obligKobo := int64(0)
			amountKobo := int64(0)
			tenorMonths := int64(0)
			if v, ok := app["monthly_income_kobo"].(int64); ok {
				incomeKobo = v
			}
			if v, ok := app["monthly_obligation_kobo"].(int64); ok {
				obligKobo = v
			}
			if v, ok := app["amount_requested_kobo"].(int64); ok {
				amountKobo = v
			}
			if v, ok := app["tenor_months"].(int64); ok {
				tenorMonths = v
			}

			payload, _ := json.Marshal(map[string]any{
				"customer_id":       str(app["applicant_cif"]),
				"tenant_id":         eyeTenant,
				"requested_amount":  amountKobo,
				"tenor_months":      tenorMonths,
				"borrower_category": "individual",
				"open_banking": map[string]any{
					"avg_monthly_inflow":  incomeKobo,
					"avg_monthly_outflow": obligKobo,
				},
			})

			eyeHTTPReq, err = http.NewRequestWithContext(r.Context(), "POST",
				eyeURL+"/score/internal", bytes.NewReader(payload))
			if err == nil {
				eyeHTTPReq.Header.Set("Content-Type", "application/json")
			}
		}
		if err != nil {
			respondErr(w, 500, "Failed to build Eye request")
			return
		}
		eyeHTTPReq.Header.Set("X-Service-Key", eyeKey)

		eyeResp, err := http.DefaultClient.Do(eyeHTTPReq)
		if err != nil {
			respondErr(w, 502, "Eye service unreachable: "+err.Error())
			return
		}
		defer eyeResp.Body.Close()

		respBody, err := io.ReadAll(eyeResp.Body)
		if err != nil {
			respondErr(w, 502, "Failed to read Eye response")
			return
		}

		// Cache the Eye application_id so future calls retrieve the same decision.
		if eyeReportID == "" && eyeResp.StatusCode == http.StatusOK {
			var parsed map[string]any
			if json.Unmarshal(respBody, &parsed) == nil {
				if eyeAppID, ok := parsed["application_id"].(string); ok && eyeAppID != "" {
					_, _ = db.PGQuery(r.Context(),
						`UPDATE loan_applications SET eye_report_id = $1 WHERE id = $2`,
						eyeAppID, appID)
				}
			}
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(eyeResp.StatusCode)
		_, _ = w.Write(respBody)
	}
}

package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

func RegisterLoans(r chi.Router, db *core.DB) {
	r.Use(core.RequirePages("loans"))
	r.Get("/", listLoans(db))
	r.Post("/", createLoan(db))
	r.Get("/stats", loanStats(db))
	r.Route("/{id}", func(r chi.Router) {
		r.Get("/", getLoan(db))
		r.Put("/", updateLoan(db))
		r.Put("/stage", updateLoanStage(db))
		r.Post("/documents", addDocument(db))
		r.Put("/documents/{docId}/confirm", confirmDocument(db))
		r.Get("/comments", getLoanComments(db))
		r.Post("/comments", addComment(db))
		r.Get("/activity", getLoanActivity(db))
	})
}

var loanStages = map[string]bool{
	"new": true, "submitted": true, "doc_collection": true,
	"under_review": true, "finance_review": true,
	"approved": true, "rejected": true, "on_hold": true,
}

func listLoans(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		status := qstr(r, "status")
		stage := qstr(r, "stage")
		search := qstr(r, "search")
		limit := qint(r, "limit", 100, 1, 500)
		offset := qint(r, "offset", 0, 0, 1<<30)

		q := `SELECT la.id, la.reference, la.applicant_cif, la.applicant_name,
		             la.applicant_phone, la.applicant_email,
		             la.product_type, la.amount_requested_kobo, la.amount_approved_kobo,
		             la.purpose, la.status, la.stage,
		             la.assigned_to_user_id, la.sales_officer_id,
		             la.created_at, la.updated_at, u.full_name AS assigned_name
		      FROM loan_applications la
		      LEFT JOIN o3c_users u ON u.id = la.assigned_to_user_id
		      WHERE 1=1`
		var args []any
		n := 1
		if status != "" {
			q += fmt.Sprintf(" AND la.status=$%d", n)
			args = append(args, status)
			n++
		}
		if stage != "" {
			q += fmt.Sprintf(" AND la.stage=$%d", n)
			args = append(args, stage)
			n++
		}
		if search != "" {
			q += fmt.Sprintf(
				" AND (la.applicant_name ILIKE $%d OR la.reference ILIKE $%d OR la.applicant_cif ILIKE $%d)",
				n, n, n)
			args = append(args, "%"+search+"%")
			n++
		}
		args = append(args, limit, offset)
		q += fmt.Sprintf(" ORDER BY la.created_at DESC LIMIT $%d OFFSET $%d", n, n+1)

		rows, err := db.PGQuery(r.Context(), q, args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		jsonRows(w, rows)
	}
}

func loanStats(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(),
			`SELECT stage, COUNT(*) AS count FROM loan_applications GROUP BY stage ORDER BY stage`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		stats := map[string]any{}
		for _, row := range rows {
			stats[str(row["stage"])] = row["count"]
		}
		totalRows, _ := db.PGQuery(r.Context(), `SELECT COUNT(*) AS n FROM loan_applications`)
		if len(totalRows) > 0 {
			stats["total"] = totalRows[0]["n"]
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(stats) //nolint:errcheck
	}
}

func getLoan(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		rows, err := db.PGQuery(r.Context(), `
			SELECT la.*, u.full_name AS assigned_name
			FROM loan_applications la
			LEFT JOIN o3c_users u ON u.id = la.assigned_to_user_id
			WHERE la.id = $1`, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Application not found")
			return
		}
		app := rows[0]
		docs, _ := db.PGQuery(r.Context(), `
			SELECT ad.*
			FROM application_documents ad
			WHERE ad.application_id = $1 ORDER BY ad.created_at`, id)
		app["documents"] = docs
		comments, _ := db.PGQuery(r.Context(), `
			SELECT id, author_id, body, is_internal, created_at
			FROM application_notes WHERE application_id = $1 ORDER BY created_at`, id)
		app["comments"] = comments
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(app) //nolint:errcheck
	}
}

func createLoan(db *core.DB) http.HandlerFunc {
	type body struct {
		ApplicantCIF   string `json:"applicant_cif"`
		ApplicantName  string `json:"applicant_name"`
		ApplicantPhone string `json:"applicant_phone"`
		ApplicantEmail string `json:"applicant_email"`
		ProductType    string `json:"product_type"`
		LoanAmount     int64  `json:"loan_amount"` // received as loan_amount, stored as amount_requested_kobo
		TenorMonths    int    `json:"tenor_months"`
		Purpose        string `json:"purpose"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.ApplicantName == "" {
			respondErr(w, 422, "applicant_name is required")
			return
		}
		if b.ProductType == "" {
			b.ProductType = "Personal Loan"
		}
		user := core.UserFromCtx(r.Context())

		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO loan_applications
			    (reference, applicant_cif, applicant_name, applicant_phone, applicant_email,
			     product_type, amount_requested_kobo, tenor_months, purpose,
			     sales_officer_id, assigned_to_user_id, stage, status,
			     created_at, updated_at)
			VALUES (
			    'LA-' || TO_CHAR(NOW(),'YYYY') || '-' || LPAD(nextval('loan_ref_seq')::text,4,'0'),
			    $1,$2,$3,$4,$5,$6,$7,$8,$9,$9,'draft','pending',NOW(),NOW()
			)
			RETURNING *`,
			b.ApplicantCIF, b.ApplicantName, b.ApplicantPhone, b.ApplicantEmail,
			b.ProductType, b.LoanAmount, b.TenorMonths, b.Purpose, user.ID)
		if err != nil {
			respondErr(w, 500, "Create failed")
			return
		}
		created := rows[0]
		go NotifyRoles(r.Context(), db, []string{"risk_officer", "risk_head"}, NotifPayload{
			EventType: EvtLoanSubmitted,
			Title:     "New loan application",
			Body: fmt.Sprintf("Application %s submitted for %s (%s)",
				str(created["reference"]), b.ApplicantName, b.ProductType),
			ActionURL: fmt.Sprintf("/loans/%v", created["id"]),
			EntityRef: fmt.Sprintf("loan:%v", created["id"]),
		})
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(created) //nolint:errcheck
	}
}

func updateLoan(db *core.DB) http.HandlerFunc {
	type body struct {
		AssignedToUserID *int64 `json:"assigned_to_user_id"`
		LoanAmount       *int64 `json:"loan_amount"` // maps to amount_requested_kobo
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		type col struct {
			name string
			val  any
		}
		var cols []col
		if b.AssignedToUserID != nil {
			cols = append(cols, col{"assigned_to_user_id", *b.AssignedToUserID})
		}
		if b.LoanAmount != nil {
			cols = append(cols, col{"amount_requested_kobo", *b.LoanAmount})
		}
		if len(cols) == 0 {
			respondErr(w, 422, "No fields to update")
			return
		}
		cols = append(cols, col{"updated_at", time.Now()})

		var setParts []string
		var args []any
		for i, c := range cols {
			setParts = append(setParts, fmt.Sprintf("%s=$%d", c.name, i+1))
			args = append(args, c.val)
		}
		args = append(args, id)
		_, err := db.PGExec(r.Context(),
			"UPDATE loan_applications SET "+strings.Join(setParts, ",")+
				fmt.Sprintf(" WHERE id=$%d", len(args)), args...)
		if err != nil {
			respondErr(w, 500, "Update failed")
			return
		}
		rows, _ := db.PGQuery(r.Context(), `SELECT * FROM loan_applications WHERE id=$1`, id)
		if len(rows) == 0 {
			respondErr(w, 404, "Not found")
			return
		}
		jsonRows(w, rows[:1])
	}
}

func updateLoanStage(db *core.DB) http.HandlerFunc {
	type body struct {
		Stage string `json:"stage"`
		Note  string `json:"note"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if !loanStages[b.Stage] {
			respondErr(w, 422, "Invalid stage — must be one of: new, submitted, doc_collection, under_review, finance_review, approved, rejected, on_hold")
			return
		}
		cur, _ := db.PGQuery(r.Context(), `SELECT stage FROM loan_applications WHERE id=$1`, id)
		if len(cur) == 0 {
			respondErr(w, 404, "Application not found")
			return
		}
		oldStage := str(cur[0]["stage"])
		user := core.UserFromCtx(r.Context())

		atomicUpd, err := db.PGQuery(r.Context(), `
			UPDATE loan_applications SET stage=$1, status=$2, updated_at=NOW()
			WHERE id=$3 AND stage=$4 RETURNING id`,
			b.Stage, stageToStatus(b.Stage), id, oldStage)
		if err != nil {
			respondErr(w, 500, "Update failed")
			return
		}
		if len(atomicUpd) == 0 {
			respondErr(w, 409, "Stage changed concurrently — please refresh and try again")
			return
		}
		// Fire notifications based on the new stage
		appRows, _ := db.PGQuery(r.Context(),
			`SELECT reference, applicant_name, assigned_to_user_id, sales_officer_id
			 FROM loan_applications WHERE id=$1`, id)
		if len(appRows) > 0 {
			app    := appRows[0]
			ref    := str(app["reference"])
			name   := str(app["applicant_name"])
			loanURL := fmt.Sprintf("/loans/%s", id)
			eRef    := fmt.Sprintf("loan:%s", id)

			// Always notify the assigned officer if set
			if assignedID, _ := app["assigned_to_user_id"].(int64); assignedID != 0 && assignedID != user.ID {
				go Notify(r.Context(), db, NotifPayload{
					EventType: EvtLoanStageChanged,
					UserID:    assignedID,
					Title:     "Loan application stage updated",
					Body:      fmt.Sprintf("%s (%s) moved to %s", ref, name, b.Stage),
					ActionURL: loanURL, EntityRef: eRef,
				})
			}
			// Approval/rejection also notifies the sales officer who submitted
			if salesID, _ := app["sales_officer_id"].(int64); salesID != 0 && salesID != user.ID {
				switch b.Stage {
				case "approved":
					go Notify(r.Context(), db, NotifPayload{
						EventType: EvtLoanApproved,
						UserID:    salesID,
						Title:     "Loan application approved",
						Body:      fmt.Sprintf("%s (%s) has been approved", ref, name),
						ActionURL: loanURL, EntityRef: eRef,
					})
				case "rejected":
					go Notify(r.Context(), db, NotifPayload{
						EventType: EvtLoanRejected,
						UserID:    salesID,
						Title:     "Loan application rejected",
						Body:      fmt.Sprintf("%s (%s) has been rejected", ref, name),
						ActionURL: loanURL, EntityRef: eRef,
					})
				}
			}
		}

		rows, _ := db.PGQuery(r.Context(), `SELECT * FROM loan_applications WHERE id=$1`, id)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func addDocument(db *core.DB) http.HandlerFunc {
	type body struct {
		DocType  string `json:"doc_type"`
		Filename string `json:"filename"`
		Notes    string `json:"notes"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.DocType == "" {
			respondErr(w, 422, "doc_type is required")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO application_documents (application_id, doc_type, is_required, created_at)
			VALUES ($1,$2,TRUE,NOW()) RETURNING *`,
			id, b.DocType)
		if err != nil {
			respondErr(w, 500, "Create failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func confirmDocument(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		docID := chi.URLParam(r, "docId")
		user  := core.UserFromCtx(r.Context())
		// migration 016 added confirmed_by / confirmed_at to application_documents
		if _, err := db.PGExec(r.Context(),
			`UPDATE application_documents
			    SET confirmed_by=$1, confirmed_at=NOW()
			  WHERE id=$2 AND confirmed_at IS NULL`,
			user.ID, docID); err != nil {
			respondErr(w, 500, "Confirm failed")
			return
		}
		rows, _ := db.PGQuery(r.Context(), `SELECT * FROM application_documents WHERE id=$1`, docID)
		if len(rows) == 0 {
			respondErr(w, 404, "Document not found")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func getLoanComments(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		rows, err := db.PGQuery(r.Context(), `
			SELECT id, author_id, body, is_internal, created_at
			FROM application_notes WHERE application_id=$1 ORDER BY created_at`, id)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		jsonRows(w, rows)
	}
}

func addComment(db *core.DB) http.HandlerFunc {
	type body struct{ Body string `json:"body"` }
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil || b.Body == "" {
			respondErr(w, 422, "body is required")
			return
		}
		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO application_notes (application_id, author_id, body, is_internal, created_at)
			VALUES ($1,$2,$3,FALSE,NOW()) RETURNING id, author_id, body, is_internal, created_at`,
			id, user.ID, b.Body)
		if err != nil {
			respondErr(w, 500, "Create failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func getLoanActivity(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		rows, err := db.PGQuery(r.Context(), `
			SELECT e.id, e.event_type, e.from_stage, e.to_stage,
			       e.actor_user_id, e.notes, e.created_at, u.full_name AS actor_name
			FROM application_events e
			LEFT JOIN o3c_users u ON u.id = e.actor_user_id
			WHERE e.application_id=$1 ORDER BY e.created_at DESC`, id)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		jsonRows(w, rows)
	}
}

// ── helpers ───────────────────────────────────────────────────────────────────

func stageToStatus(stage string) string {
	switch stage {
	case "approved":
		return "approved"
	case "rejected":
		return "rejected"
	case "under_review", "finance_review":
		return "under_review"
	default:
		return "pending"
	}
}

func jsonRows(w http.ResponseWriter, rows []core.Row) {
	w.Header().Set("Content-Type", "application/json")
	if rows == nil {
		rows = []core.Row{}
	}
	json.NewEncoder(w).Encode(rows) //nolint:errcheck
}

func toInt64FromStr(s string) int64 {
	var n int64
	for _, c := range s {
		if c < '0' || c > '9' {
			break
		}
		n = n*10 + int64(c-'0')
	}
	return n
}

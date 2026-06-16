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

		q := `SELECT la.id, la.ref_no, la.cif, la.first_name, la.last_name, la.phone, la.email,
		             la.loan_type, la.loan_amount, la.purpose, la.status, la.stage, la.notes,
		             la.assigned_to, la.created_by, la.reviewed_by, la.reviewed_at,
		             la.created_at, la.updated_at, u.full_name AS assigned_name
		      FROM loan_applications la
		      LEFT JOIN o3c_users u ON u.id = la.assigned_to
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
				" AND (la.first_name ILIKE $%d OR la.last_name ILIKE $%d OR la.ref_no ILIKE $%d OR la.cif ILIKE $%d)",
				n, n, n, n)
			args = append(args, "%"+search+"%")
			n++
		}
		args = append(args, limit)
		q += fmt.Sprintf(" ORDER BY la.created_at DESC LIMIT $%d", n)

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
			LEFT JOIN o3c_users u ON u.id = la.assigned_to
			WHERE la.id = $1`, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Application not found")
			return
		}
		app := rows[0]
		docs, _ := db.PGQuery(r.Context(), `
			SELECT ld.*, u.full_name AS confirmed_by_name
			FROM loan_documents ld
			LEFT JOIN o3c_users u ON u.id = ld.confirmed_by
			WHERE ld.application_id = $1 ORDER BY ld.created_at`, id)
		app["documents"] = docs
		comments, _ := db.PGQuery(r.Context(), `
			SELECT id, user_id, user_name, body, created_at
			FROM loan_comments WHERE application_id = $1 ORDER BY created_at`, id)
		app["comments"] = comments
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(app) //nolint:errcheck
	}
}

func createLoan(db *core.DB) http.HandlerFunc {
	type body struct {
		CIF        string  `json:"cif"`
		FirstName  string  `json:"first_name"`
		LastName   string  `json:"last_name"`
		Phone      string  `json:"phone"`
		Email      string  `json:"email"`
		LoanType   string  `json:"loan_type"`
		LoanAmount float64 `json:"loan_amount"`
		Purpose    string  `json:"purpose"`
		Notes      string  `json:"notes"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.FirstName == "" || b.LastName == "" {
			respondErr(w, 422, "first_name and last_name are required")
			return
		}
		if b.LoanType == "" {
			b.LoanType = "Personal Loan"
		}
		user := core.UserFromCtx(r.Context())
		refNo := genRefNo(db, r)

		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO loan_applications
			    (ref_no, cif, first_name, last_name, phone, email,
			     loan_type, loan_amount, purpose, notes, created_by, stage, status)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'new','pending')
			RETURNING *`,
			refNo, b.CIF, b.FirstName, b.LastName, b.Phone, b.Email,
			b.LoanType, b.LoanAmount, b.Purpose, b.Notes, user.ID)
		if err != nil {
			respondErr(w, 500, "Create failed")
			return
		}
		logLoanAction(db, r, toInt64(rows[0]["id"]), user, "created", "", "new", "")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func updateLoan(db *core.DB) http.HandlerFunc {
	type body struct {
		Notes      *string  `json:"notes"`
		AssignedTo *int64   `json:"assigned_to"`
		LoanAmount *float64 `json:"loan_amount"`
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
		if b.Notes != nil {
			cols = append(cols, col{"notes", *b.Notes})
		}
		if b.AssignedTo != nil {
			cols = append(cols, col{"assigned_to", *b.AssignedTo})
		}
		if b.LoanAmount != nil {
			cols = append(cols, col{"loan_amount", *b.LoanAmount})
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

		_, err := db.PGExec(r.Context(), `
			UPDATE loan_applications SET stage=$1, status=$2, updated_at=NOW(),
			    reviewed_by=$3, reviewed_at=NOW() WHERE id=$4`,
			b.Stage, stageToStatus(b.Stage), user.ID, id)
		if err != nil {
			respondErr(w, 500, "Update failed")
			return
		}
		logLoanAction(db, r, toInt64FromStr(id), user, "stage_changed", oldStage, b.Stage, b.Note)

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
			INSERT INTO loan_documents (application_id, doc_type, filename, notes, status)
			VALUES ($1,$2,$3,$4,'submitted') RETURNING *`,
			id, b.DocType, b.Filename, b.Notes)
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
		user := core.UserFromCtx(r.Context())
		_, err := db.PGExec(r.Context(), `
			UPDATE loan_documents SET status='confirmed', confirmed_by=$1, confirmed_at=NOW() WHERE id=$2`,
			user.ID, docID)
		if err != nil {
			respondErr(w, 500, "Update failed")
			return
		}
		rows, _ := db.PGQuery(r.Context(), `SELECT * FROM loan_documents WHERE id=$1`, docID)
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
			SELECT id, user_id, user_name, body, created_at
			FROM loan_comments WHERE application_id=$1 ORDER BY created_at`, id)
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
			INSERT INTO loan_comments (application_id, user_id, user_name, body)
			VALUES ($1,$2,$3,$4) RETURNING *`,
			id, user.ID, user.FullName, b.Body)
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
			SELECT id, user_id, user_name, action, old_value, new_value, note, created_at
			FROM loan_activity_log WHERE application_id=$1 ORDER BY created_at DESC`, id)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		jsonRows(w, rows)
	}
}

// ── helpers ───────────────────────────────────────────────────────────────────

func genRefNo(db *core.DB, r *http.Request) string {
	year := time.Now().Year()
	rows, _ := db.PGQuery(r.Context(),
		`SELECT COUNT(*)+1 AS n FROM loan_applications WHERE EXTRACT(year FROM created_at)=$1`, year)
	n := int64(1)
	if len(rows) > 0 {
		n = toInt64(rows[0]["n"])
	}
	return fmt.Sprintf("LA-%d-%04d", year, n)
}

func logLoanAction(db *core.DB, r *http.Request, appID int64, user *core.Claims, action, oldVal, newVal, note string) {
	db.PGExec(r.Context(), //nolint:errcheck
		`INSERT INTO loan_activity_log (application_id, user_id, user_name, action, old_value, new_value, note)
		 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
		appID, user.ID, user.FullName, action, oldVal, newVal, note)
}

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

package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

var templateChannels = map[string]bool{"sms": true, "email": true}
var templateCategories = map[string]bool{
	"general": true, "collections": true, "marketing": true,
	"onboarding": true, "repayment_reminder": true,
}

var templateUpdateCols = []string{
	"name", "category", "sms_body", "email_subject",
	"email_body_html", "email_body_text", "merge_tags",
}

func RegisterMessageTemplates(r chi.Router, db *core.DB) {
	access := core.RequirePages("campaigns")
	r.With(access).Get("/", listTemplates(db))
	r.With(access).Post("/", createTemplate(db))
	r.With(access).Get("/{id}", getTemplate(db))
	r.With(access).Put("/{id}", updateTemplate(db))
	r.With(access).Delete("/{id}", deleteTemplate(db))
}

func listTemplates(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		where := "1=1"
		var args []any
		n := 1
		if v := qstr(r, "channel"); v != "" {
			where += fmt.Sprintf(" AND t.channel=$%d", n); args = append(args, v); n++
		}
		if v := qstr(r, "category"); v != "" {
			where += fmt.Sprintf(" AND t.category=$%d", n); args = append(args, v); n++
		}
		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT t.*, u.full_name AS created_by_name
			FROM message_templates t
			LEFT JOIN o3c_users u ON t.created_by=u.id
			WHERE %s ORDER BY t.created_at DESC`, where), args...)
		if err != nil {
			respondErr(w, 500, "Query failed"); return
		}
		jsonRows(w, rows)
	}
}

func createTemplate(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			Name          string   `json:"name"`
			Channel       string   `json:"channel"`
			Category      string   `json:"category"`
			SMSBody       *string  `json:"sms_body"`
			EmailSubject  *string  `json:"email_subject"`
			EmailBodyHTML *string  `json:"email_body_html"`
			EmailBodyText *string  `json:"email_body_text"`
			MergeTags     []string `json:"merge_tags"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON"); return
		}
		if b.Name == "" {
			respondErr(w, 422, "name is required"); return
		}
		if !templateChannels[b.Channel] {
			respondErr(w, 422, "channel must be sms or email"); return
		}
		if b.Category == "" {
			b.Category = "general"
		}
		if !templateCategories[b.Category] {
			b.Category = "general"
		}
		if b.MergeTags == nil {
			b.MergeTags = []string{}
		}
		tagsJSON, _ := json.Marshal(b.MergeTags)
		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO message_templates
			    (name, channel, category, sms_body, email_subject, email_body_html,
			     email_body_text, merge_tags, created_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) RETURNING *`,
			b.Name, b.Channel, b.Category, b.SMSBody, b.EmailSubject,
			b.EmailBodyHTML, b.EmailBodyText, string(tagsJSON), user.ID)
		if err != nil {
			respondErr(w, 500, "Create failed"); return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func getTemplate(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		rows, err := db.PGQuery(r.Context(), "SELECT * FROM message_templates WHERE id=$1", id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Template not found"); return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func updateTemplate(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			respondErr(w, 400, "Invalid JSON"); return
		}
		parts, args := buildSet(body, templateUpdateCols, 1)
		// merge_tags needs ::jsonb cast
		for i, p := range parts {
			if strings.HasPrefix(p, "merge_tags=") {
				parts[i] = fmt.Sprintf("merge_tags=$%d::jsonb", i+1)
				b, _ := json.Marshal(args[i])
				args[i] = string(b)
			}
		}
		if len(parts) == 0 {
			respondErr(w, 422, "No fields to update"); return
		}
		parts = append(parts, "updated_at=NOW()")
		args = append(args, id)
		rows, err := db.PGQuery(r.Context(),
			fmt.Sprintf("UPDATE message_templates SET %s WHERE id=$%d RETURNING *",
				strings.Join(parts, ","), len(args)), args...)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Template not found"); return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func deleteTemplate(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		db.PGExec(r.Context(), "DELETE FROM message_templates WHERE id=$1", id) //nolint:errcheck
		w.WriteHeader(204)
	}
}

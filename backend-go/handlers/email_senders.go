package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// RegisterEmailSenders mounts sender identity CRUD under /api/admin.
func RegisterEmailSenders(r chi.Router, db *core.DB) {
	r.Get("/email-senders", listEmailSenders(db))
	r.Post("/email-senders", createEmailSender(db))
	r.Put("/email-senders/{id}", updateEmailSender(db))
	r.Delete("/email-senders/{id}", deleteEmailSender(db))
	r.Post("/email-senders/{id}/set-default", setDefaultSender(db))
}

// RegisterRecipientSuggest mounts the recipient autocomplete under the auth group.
func RegisterRecipientSuggest(r chi.Router, db *core.DB) {
	r.Get("/suggest/recipients", suggestRecipients(db))
}

func listEmailSenders(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT id, address, name, label, purpose, is_default, is_active, created_at, updated_at
			FROM email_senders
			ORDER BY purpose, is_default DESC, label`)
		if err != nil {
			respondErr(w, 500, "Query failed"); return
		}
		if rows == nil {
			rows = []map[string]any{}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows) //nolint:errcheck
	}
}

func createEmailSender(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			Address   string `json:"address"`
			Name      string `json:"name"`
			Label     string `json:"label"`
			Purpose   string `json:"purpose"`
			IsDefault bool   `json:"is_default"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON"); return
		}
		if b.Address == "" || b.Name == "" || b.Label == "" {
			respondErr(w, 422, "address, name, and label are required"); return
		}
		if !strings.Contains(b.Address, "@") {
			respondErr(w, 422, "Invalid email address"); return
		}
		if b.Purpose == "" {
			b.Purpose = "general"
		}
		if b.IsDefault {
			db.PGExec(r.Context(), //nolint:errcheck
				`UPDATE email_senders SET is_default=FALSE WHERE purpose=$1`, b.Purpose)
		}
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO email_senders (address, name, label, purpose, is_default)
			VALUES ($1,$2,$3,$4,$5) RETURNING *`,
			b.Address, b.Name, b.Label, b.Purpose, b.IsDefault)
		if err != nil {
			respondErr(w, 500, "Create failed"); return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

var senderUpdateCols = []string{"address", "name", "label", "purpose", "is_default", "is_active"}

func updateEmailSender(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			respondErr(w, 400, "Invalid JSON"); return
		}
		// If setting as default, clear the old default for this purpose first
		if v, ok := body["is_default"]; ok && v == true {
			purpose := "general"
			if p, ok2 := body["purpose"].(string); ok2 {
				purpose = p
			} else {
				cur, _ := db.PGQuery(r.Context(), `SELECT purpose FROM email_senders WHERE id=$1`, id)
				if len(cur) > 0 {
					purpose = str(cur[0]["purpose"])
				}
			}
			db.PGExec(r.Context(), //nolint:errcheck
				`UPDATE email_senders SET is_default=FALSE WHERE purpose=$1 AND id::text!=$2`, purpose, id)
		}
		parts, args := buildSet(body, senderUpdateCols, 1)
		if len(parts) == 0 {
			respondErr(w, 422, "No fields to update"); return
		}
		parts = append(parts, "updated_at=NOW()")
		args = append(args, id)
		rows, err := db.PGQuery(r.Context(),
			fmt.Sprintf("UPDATE email_senders SET %s WHERE id=$%d RETURNING *",
				strings.Join(parts, ","), len(args)), args...)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Sender not found"); return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func deleteEmailSender(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		db.PGExec(r.Context(), //nolint:errcheck
			`UPDATE email_senders SET is_active=FALSE, updated_at=NOW() WHERE id=$1`,
			chi.URLParam(r, "id"))
		w.WriteHeader(204)
	}
}

func setDefaultSender(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		cur, err := db.PGQuery(r.Context(), `SELECT purpose FROM email_senders WHERE id=$1`, id)
		if err != nil || len(cur) == 0 {
			respondErr(w, 404, "Sender not found"); return
		}
		purpose := str(cur[0]["purpose"])
		db.PGExec(r.Context(), //nolint:errcheck
			`UPDATE email_senders SET is_default=FALSE WHERE purpose=$1`, purpose)
		db.PGExec(r.Context(), //nolint:errcheck
			`UPDATE email_senders SET is_default=TRUE, updated_at=NOW() WHERE id=$1`, id)
		w.WriteHeader(204)
	}
}

// suggestRecipients returns up to 10 matches across staff and CRM contacts.
func suggestRecipients(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := strings.TrimSpace(r.URL.Query().Get("q"))
		if len(q) < 2 {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode([]any{}) //nolint:errcheck
			return
		}
		like := "%" + q + "%"

		staffRows, _ := db.PGQuery(r.Context(), `
			SELECT full_name AS name, email, 'staff' AS source
			FROM o3c_users
			WHERE is_active=TRUE AND deleted_at IS NULL
			  AND (full_name ILIKE $1 OR email ILIKE $1)
			ORDER BY full_name LIMIT 5`, like)

		contactRows, _ := db.PGQuery(r.Context(), `
			SELECT (first_name || ' ' || last_name) AS name, email, 'contact' AS source
			FROM crm_contacts
			WHERE email IS NOT NULL AND email <> ''
			  AND (first_name ILIKE $1 OR last_name ILIKE $1 OR email ILIKE $1)
			ORDER BY first_name LIMIT 5`, like)

		seen    := map[string]bool{}
		results := []map[string]any{}
		for _, row := range append(staffRows, contactRows...) {
			email := str(row["email"])
			if email == "" || seen[email] {
				continue
			}
			seen[email] = true
			results = append(results, map[string]any{
				"name":   str(row["name"]),
				"email":  email,
				"source": str(row["source"]),
			})
			if len(results) >= 10 {
				break
			}
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(results) //nolint:errcheck
	}
}

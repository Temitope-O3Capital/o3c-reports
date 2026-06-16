package handlers

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"unicode"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

func RegisterContactLists(r chi.Router, db *core.DB) {
	access := core.RequirePages("campaigns")
	r.With(access).Get("/", listContactLists(db))
	r.With(access).Post("/", createContactList(db))
	r.With(access).Get("/{id}", getContactList(db))
	r.With(access).Put("/{id}", updateContactList(db))
	r.With(access).Delete("/{id}", deleteContactList(db))
	r.With(access).Post("/{id}/members", addListMember(db))
	r.With(access).Post("/{id}/upload", uploadListCSV(db))
	r.With(access).Delete("/{id}/members/{mid}", removeListMember(db))
}

func syncListCount(db *core.DB, r *http.Request, listID string) {
	if tr, _ := db.PGQuery(r.Context(),
		"SELECT COUNT(*) AS n FROM contact_list_members WHERE list_id=$1 AND status='active'", listID); len(tr) > 0 {
		db.PGExec(r.Context(), //nolint:errcheck
			"UPDATE contact_lists SET member_count=$1, updated_at=NOW() WHERE id=$2",
			toInt64(tr[0]["n"]), listID)
	}
}

func listContactLists(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := qint(r, "limit", 100, 1, 500)
		rows, err := db.PGQuery(r.Context(), `
			SELECT cl.*, u.full_name AS created_by_name
			FROM contact_lists cl
			LEFT JOIN o3c_users u ON cl.created_by=u.id
			ORDER BY cl.created_at DESC LIMIT $1`, limit)
		if err != nil {
			respondErr(w, 500, "Query failed"); return
		}
		jsonRows(w, rows)
	}
}

func createContactList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			Name        string  `json:"name"`
			Description *string `json:"description"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON"); return
		}
		if b.Name == "" {
			respondErr(w, 422, "name is required"); return
		}
		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(),
			"INSERT INTO contact_lists (name, description, created_by) VALUES ($1,$2,$3) RETURNING *",
			b.Name, b.Description, user.ID)
		if err != nil {
			respondErr(w, 500, "Create failed"); return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func getContactList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		limit := qint(r, "limit", 100, 1, 1000)
		offset := qint(r, "offset", 0, 0, 1<<30)

		listRows, err := db.PGQuery(r.Context(), "SELECT * FROM contact_lists WHERE id=$1", id)
		if err != nil || len(listRows) == 0 {
			respondErr(w, 404, "List not found"); return
		}
		lst := listRows[0]

		where := "list_id=$1 AND status='active'"
		args := []any{id}
		n := 2
		if s := qstr(r, "search"); s != "" {
			where += fmt.Sprintf(
				" AND (first_name ILIKE $%d OR last_name ILIKE $%d OR phone ILIKE $%d OR email ILIKE $%d)",
				n, n, n, n)
			args = append(args, "%"+s+"%"); n++
		}
		filterArgs := append([]any(nil), args...)
		args = append(args, limit, offset)

		total := 0
		if tr, _ := db.PGQuery(r.Context(),
			fmt.Sprintf("SELECT COUNT(*) AS n FROM contact_list_members WHERE %s", where), filterArgs...); len(tr) > 0 {
			total = int(toInt64(tr[0]["n"]))
		}
		members, _ := db.PGQuery(r.Context(),
			fmt.Sprintf("SELECT * FROM contact_list_members WHERE %s ORDER BY id ASC LIMIT $%d OFFSET $%d", where, n, n+1), args...)

		lst["total_members"] = total
		lst["members"] = members
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(lst) //nolint:errcheck
	}
}

func updateContactList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var b struct {
			Name        string  `json:"name"`
			Description *string `json:"description"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON"); return
		}
		rows, err := db.PGQuery(r.Context(),
			"UPDATE contact_lists SET name=$1, description=$2, updated_at=NOW() WHERE id=$3 RETURNING *",
			b.Name, b.Description, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "List not found"); return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func deleteContactList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		db.PGExec(r.Context(), "DELETE FROM contact_list_members WHERE list_id=$1", id) //nolint:errcheck
		db.PGExec(r.Context(), "DELETE FROM contact_lists WHERE id=$1", id)             //nolint:errcheck
		w.WriteHeader(204)
	}
}

func addListMember(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var b struct {
			FirstName  *string        `json:"first_name"`
			LastName   *string        `json:"last_name"`
			Phone      *string        `json:"phone"`
			Email      *string        `json:"email"`
			CIFNumber  *string        `json:"cif_number"`
			MergeData  map[string]any `json:"merge_data"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON"); return
		}
		if b.Phone == nil && b.Email == nil {
			respondErr(w, 422, "phone or email is required"); return
		}
		mergeJSON, _ := json.Marshal(b.MergeData)
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO contact_list_members
			    (list_id, first_name, last_name, phone, email, cif_number, merge_data)
			VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *`,
			id, b.FirstName, b.LastName, b.Phone, b.Email, b.CIFNumber, string(mergeJSON))
		if err != nil {
			respondErr(w, 500, "Create failed"); return
		}
		syncListCount(db, r, id)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func uploadListCSV(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")

		if err := r.ParseMultipartForm(10 << 20); err != nil {
			respondErr(w, 400, "Cannot parse multipart form"); return
		}
		file, header, err := r.FormFile("file")
		if err != nil {
			respondErr(w, 400, "file field required"); return
		}
		defer file.Close()
		if !strings.HasSuffix(strings.ToLower(header.Filename), ".csv") {
			respondErr(w, 400, "File must be a CSV"); return
		}

		known := map[string]bool{
			"first_name": true, "last_name": true, "phone": true, "email": true, "cif_number": true,
		}

		reader := csv.NewReader(file)
		records, err := reader.ReadAll()
		if err != nil || len(records) < 2 {
			respondErr(w, 422, "Invalid CSV or empty file"); return
		}

		// Normalise headers
		headers := make([]string, len(records[0]))
		for i, h := range records[0] {
			headers[i] = normaliseCSVHeader(h)
		}

		inserted := 0
		var errors []string
		for i, rec := range records[1:] {
			row := make(map[string]string, len(headers))
			for j, val := range rec {
				if j < len(headers) {
					row[headers[j]] = strings.TrimSpace(val)
				}
			}
			phone := emptyToNil(row["phone"])
			email := emptyToNil(row["email"])
			if phone == nil && email == nil {
				errors = append(errors, fmt.Sprintf("Row %d: no phone or email — skipped", i+2))
				continue
			}
			merge := map[string]string{}
			for k, v := range row {
				if !known[k] && v != "" {
					merge[k] = v
				}
			}
			mergeJSON, _ := json.Marshal(merge)
			_, err := db.PGExec(r.Context(), `
				INSERT INTO contact_list_members
				    (list_id, first_name, last_name, phone, email, cif_number, merge_data)
				VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
				id, emptyToNil(row["first_name"]), emptyToNil(row["last_name"]),
				phone, email, emptyToNil(row["cif_number"]), string(mergeJSON))
			if err != nil {
				errors = append(errors, fmt.Sprintf("Row %d: %s", i+2, err.Error()[:80]))
				continue
			}
			inserted++
		}
		syncListCount(db, r, id)
		db.PGExec(r.Context(), "UPDATE contact_lists SET source='csv', updated_at=NOW() WHERE id=$1", id) //nolint:errcheck

		maxErrors := 20
		if len(errors) < maxErrors {
			maxErrors = len(errors)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"inserted": inserted,
			"errors":   errors[:maxErrors],
		})
	}
}

func removeListMember(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		mid := chi.URLParam(r, "mid")
		rows, _ := db.PGQuery(r.Context(),
			"SELECT 1 FROM contact_list_members WHERE id=$1 AND list_id=$2", mid, id)
		if len(rows) == 0 {
			respondErr(w, 404, "Member not found"); return
		}
		db.PGExec(r.Context(), "DELETE FROM contact_list_members WHERE id=$1", mid) //nolint:errcheck
		syncListCount(db, r, id)
		w.WriteHeader(204)
	}
}

// normaliseCSVHeader lowercases and snake_cases a CSV column header.
func normaliseCSVHeader(h string) string {
	h = strings.TrimSpace(h)
	var b strings.Builder
	for _, r := range h {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(unicode.ToLower(r))
		} else {
			b.WriteByte('_')
		}
	}
	return b.String()
}

func emptyToNil(s string) interface{} {
	if s == "" {
		return nil
	}
	return s
}

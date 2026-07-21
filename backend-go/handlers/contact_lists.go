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
	r.With(access).Get("/{id}/members", listListMembers(db))
	r.With(access).Post("/{id}/members", addListMember(db))
	r.With(access).Put("/{id}/members/{mid}", updateListMember(db))
	r.With(access).Delete("/{id}/members/{mid}", removeListMember(db))
	r.With(access).Post("/{id}/preflight", preflightListCSV(db))
	r.With(access).Post("/{id}/upload", uploadListCSV(db))
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
		offset := qint(r, "offset", 0, 0, 1<<30)
		from := r.URL.Query().Get("from")
		to := r.URL.Query().Get("to")

		where := "1=1"
		var filterArgs []any
		n := 1
		if from != "" {
			filterArgs = append(filterArgs, from)
			where += " AND cl.created_at::date >= $" + itoa(n) + "::date"
			n++
		}
		if to != "" {
			filterArgs = append(filterArgs, to)
			where += " AND cl.created_at::date <= $" + itoa(n) + "::date"
			n++
		}

		total := 0
		if tr, _ := db.PGQuery(r.Context(), "SELECT COUNT(*) AS n FROM contact_lists cl WHERE "+where, filterArgs...); len(tr) > 0 {
			total = int(toInt64(tr[0]["n"]))
		}
		args := append(append([]any(nil), filterArgs...), limit, offset)
		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT cl.*, u.full_name AS created_by_name
			FROM contact_lists cl
			LEFT JOIN o3c_users u ON cl.created_by=u.id
			WHERE %s ORDER BY cl.created_at DESC LIMIT $%d OFFSET $%d`, where, n, n+1), args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"data":   rows,
			"total":  total,
			"limit":  limit,
			"offset": offset,
		})
	}
}

func createContactList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			Name        string  `json:"name"`
			Description *string `json:"description"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Name == "" {
			respondErr(w, 422, "name is required")
			return
		}
		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(),
			"INSERT INTO contact_lists (name, description, created_by) VALUES ($1,$2,$3) RETURNING *",
			b.Name, b.Description, user.ID)
		if err != nil {
			respondErr(w, 500, "Create failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func getContactList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		listRows, err := db.PGQuery(r.Context(), "SELECT * FROM contact_lists WHERE id=$1", id)
		if err != nil || len(listRows) == 0 {
			respondErr(w, 404, "List not found")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(listRows[0]) //nolint:errcheck
	}
}

func listListMembers(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		limit := qint(r, "limit", 200, 1, 1000)
		offset := qint(r, "offset", 0, 0, 1<<30)
		search := qstr(r, "q")

		if rows, _ := db.PGQuery(r.Context(), "SELECT 1 FROM contact_lists WHERE id=$1", id); len(rows) == 0 {
			respondErr(w, 404, "List not found")
			return
		}

		where := "list_id=$1 AND status='active'"
		args := []any{id}
		n := 2
		if search != "" {
			where += fmt.Sprintf(
				" AND (first_name ILIKE $%d OR last_name ILIKE $%d OR phone ILIKE $%d OR email ILIKE $%d OR cif_number ILIKE $%d)",
				n, n, n, n, n)
			args = append(args, "%"+search+"%")
			n++
		}
		filterArgs := append([]any(nil), args...)

		total := 0
		if tr, _ := db.PGQuery(r.Context(),
			fmt.Sprintf("SELECT COUNT(*) AS n FROM contact_list_members WHERE %s", where), filterArgs...); len(tr) > 0 {
			total = int(toInt64(tr[0]["n"]))
		}
		args = append(args, limit, offset)
		members, err := db.PGQuery(r.Context(),
			fmt.Sprintf("SELECT * FROM contact_list_members WHERE %s ORDER BY id ASC LIMIT $%d OFFSET $%d", where, n, n+1), args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"data":   members,
			"total":  total,
			"limit":  limit,
			"offset": offset,
		})
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
			respondErr(w, 400, "Invalid JSON")
			return
		}
		rows, err := db.PGQuery(r.Context(),
			"UPDATE contact_lists SET name=$1, description=$2, updated_at=NOW() WHERE id=$3 RETURNING *",
			b.Name, b.Description, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "List not found")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func deleteContactList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		guard, _ := db.PGQuery(r.Context(),
			"SELECT COUNT(*) AS n FROM campaigns WHERE list_id=$1", id)
		if len(guard) > 0 && toInt64(guard[0]["n"]) > 0 {
			respondErr(w, 409, "Cannot delete a contact list referenced by campaigns")
			return
		}
		db.PGExec(r.Context(), "DELETE FROM contact_list_members WHERE list_id=$1", id) //nolint:errcheck
		db.PGExec(r.Context(), "DELETE FROM contact_lists WHERE id=$1", id)             //nolint:errcheck
		w.WriteHeader(204)
	}
}

func addListMember(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var b struct {
			FirstName *string        `json:"first_name"`
			LastName  *string        `json:"last_name"`
			Phone     *string        `json:"phone"`
			Email     *string        `json:"email"`
			CIFNumber *string        `json:"cif_number"`
			MergeData map[string]any `json:"merge_data"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		b.FirstName = cleanStringPtr(b.FirstName)
		b.LastName = cleanStringPtr(b.LastName)
		b.Phone = cleanStringPtr(b.Phone)
		b.Email = cleanStringPtr(b.Email)
		b.CIFNumber = cleanStringPtr(b.CIFNumber)
		if b.FirstName == nil && b.LastName == nil && b.Phone == nil && b.Email == nil && b.CIFNumber == nil {
			respondErr(w, 422, "at least one field is required (name, phone, email, or CIF number)")
			return
		}
		mergeJSON, _ := json.Marshal(b.MergeData)
		var phoneVal, emailVal string
		if b.Phone != nil {
			phoneVal = *b.Phone
		}
		if b.Email != nil {
			emailVal = *b.Email
		}
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO contact_list_members
			    (list_id, first_name, last_name, phone, email, phone_hmac, email_hmac, cif_number, merge_data)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING *`,
			id, b.FirstName, b.LastName, b.Phone, b.Email,
			nullStr(blindContactHMAC(phoneVal)), nullStr(blindContactHMAC(emailVal)),
			b.CIFNumber, string(mergeJSON))
		if err != nil {
			respondErr(w, 500, "Create failed")
			return
		}
		syncListCount(db, r, id)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func updateListMember(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		mid := chi.URLParam(r, "mid")
		var b struct {
			FirstName *string `json:"first_name"`
			LastName  *string `json:"last_name"`
			Phone     *string `json:"phone"`
			Email     *string `json:"email"`
			CIFNumber *string `json:"cif_number"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		b.FirstName = cleanStringPtr(b.FirstName)
		b.LastName = cleanStringPtr(b.LastName)
		b.Phone = cleanStringPtr(b.Phone)
		b.Email = cleanStringPtr(b.Email)
		b.CIFNumber = cleanStringPtr(b.CIFNumber)
		var phoneVal, emailVal string
		if b.Phone != nil {
			phoneVal = *b.Phone
		}
		if b.Email != nil {
			emailVal = *b.Email
		}
		rows, err := db.PGQuery(r.Context(), `
			UPDATE contact_list_members
			SET first_name=$1, last_name=$2, phone=$3, email=$4,
			    phone_hmac=$5, email_hmac=$6, cif_number=$7, updated_at=NOW()
			WHERE id=$8 AND list_id=$9 RETURNING *`,
			b.FirstName, b.LastName, b.Phone, b.Email,
			nullStr(blindContactHMAC(phoneVal)), nullStr(blindContactHMAC(emailVal)),
			b.CIFNumber, mid, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Member not found")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func removeListMember(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		mid := chi.URLParam(r, "mid")
		rows, _ := db.PGQuery(r.Context(),
			"SELECT 1 FROM contact_list_members WHERE id=$1 AND list_id=$2", mid, id)
		if len(rows) == 0 {
			respondErr(w, 404, "Member not found")
			return
		}
		db.PGExec(r.Context(), "DELETE FROM contact_list_members WHERE id=$1", mid) //nolint:errcheck
		syncListCount(db, r, id)
		w.WriteHeader(204)
	}
}

// parseContactCSV parses a CSV file into valid rows and validation errors.
// Used by both preflight and upload endpoints.
type csvContactRow struct {
	firstName *string
	lastName  *string
	phone     interface{}
	email     interface{}
	phoneHMAC *string
	emailHMAC *string
	cifNumber interface{}
	mergeJSON string
}

var knownContactCols = map[string]bool{
	"first_name": true, "last_name": true, "phone": true, "email": true, "cif_number": true,
}

func parseContactCSV(records [][]string) ([]csvContactRow, []string) {
	headers := make([]string, len(records[0]))
	for i, h := range records[0] {
		headers[i] = normaliseCSVHeader(h)
	}
	var valid []csvContactRow
	var errors []string
	for i, rec := range records[1:] {
		row := make(map[string]string, len(headers))
		for j, val := range rec {
			if j < len(headers) {
				row[headers[j]] = strings.TrimSpace(val)
			}
		}
		fn := strings.TrimSpace(row["first_name"])
		ln := strings.TrimSpace(row["last_name"])
		cif := strings.TrimSpace(row["cif_number"])
		phone := emptyToNil(row["phone"])
		email := emptyToNil(row["email"])
		if fn == "" && ln == "" && cif == "" && phone == nil && email == nil {
			errors = append(errors, fmt.Sprintf("Row %d: no identifiable fields — skipped", i+2))
			continue
		}
		merge := map[string]string{}
		for k, v := range row {
			if !knownContactCols[k] && v != "" {
				merge[k] = v
			}
		}
		mergeJSON, _ := json.Marshal(merge)
		valid = append(valid, csvContactRow{
			firstName: func() *string {
				if fn == "" {
					return nil
				}
				return &fn
			}(),
			lastName: func() *string {
				if ln == "" {
					return nil
				}
				return &ln
			}(),
			phone:     phone,
			email:     email,
			phoneHMAC: nullStr(blindContactHMAC(row["phone"])),
			emailHMAC: nullStr(blindContactHMAC(row["email"])),
			cifNumber: emptyToNil(cif),
			mergeJSON: string(mergeJSON),
		})
	}
	return valid, errors
}

func preflightListCSV(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseMultipartForm(10 << 20); err != nil {
			respondErr(w, 400, "Cannot parse multipart form")
			return
		}
		file, header, err := r.FormFile("file")
		if err != nil {
			respondErr(w, 400, "file field required")
			return
		}
		defer file.Close()
		if !strings.HasSuffix(strings.ToLower(header.Filename), ".csv") {
			respondErr(w, 400, "File must be a CSV")
			return
		}
		records, err := csv.NewReader(file).ReadAll()
		if err != nil || len(records) < 2 {
			respondErr(w, 422, "Invalid CSV or empty file")
			return
		}
		valid, errors := parseContactCSV(records)
		maxErrors := 20
		if len(errors) < maxErrors {
			maxErrors = len(errors)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"total":   len(records) - 1,
			"valid":   len(valid),
			"invalid": len(errors),
			"errors":  errors[:maxErrors],
		})
	}
}

func uploadListCSV(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		if err := r.ParseMultipartForm(10 << 20); err != nil {
			respondErr(w, 400, "Cannot parse multipart form")
			return
		}
		file, header, err := r.FormFile("file")
		if err != nil {
			respondErr(w, 400, "file field required")
			return
		}
		defer file.Close()
		if !strings.HasSuffix(strings.ToLower(header.Filename), ".csv") {
			respondErr(w, 400, "File must be a CSV")
			return
		}
		records, err := csv.NewReader(file).ReadAll()
		if err != nil || len(records) < 2 {
			respondErr(w, 422, "Invalid CSV or empty file")
			return
		}
		validRows, parseErrors := parseContactCSV(records)

		inserted := 0
		var insertErrors []string
		const batchSize = 500
		for start := 0; start < len(validRows); start += batchSize {
			end := start + batchSize
			if end > len(validRows) {
				end = len(validRows)
			}
			batch := validRows[start:end]
			var sb strings.Builder
			sb.WriteString("INSERT INTO contact_list_members (list_id, first_name, last_name, phone, email, phone_hmac, email_hmac, cif_number, merge_data) VALUES ")
			args := make([]interface{}, 0, len(batch)*9)
			for i, row := range batch {
				if i > 0 {
					sb.WriteString(",")
				}
				n := i*9 + 1
				fmt.Fprintf(&sb, "($%d,$%d,$%d,$%d,$%d,$%d,$%d,$%d,$%d::jsonb)", n, n+1, n+2, n+3, n+4, n+5, n+6, n+7, n+8)
				args = append(args, id, row.firstName, row.lastName, row.phone, row.email, row.phoneHMAC, row.emailHMAC, row.cifNumber, row.mergeJSON)
			}
			if _, err := db.PGExec(r.Context(), sb.String(), args...); err != nil {
				errMsg := err.Error()
				if len(errMsg) > 120 {
					errMsg = errMsg[:120]
				}
				insertErrors = append(insertErrors, fmt.Sprintf("Batch rows %d-%d: %s", start+2, end+1, errMsg))
			} else {
				inserted += len(batch)
			}
		}
		syncListCount(db, r, id)
		db.PGExec(r.Context(), "UPDATE contact_lists SET source='csv', updated_at=NOW() WHERE id=$1", id) //nolint:errcheck

		allErrors := append(parseErrors, insertErrors...)
		maxErrors := 20
		if len(allErrors) < maxErrors {
			maxErrors = len(allErrors)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"inserted": inserted,
			"errors":   allErrors[:maxErrors],
		})
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

func cleanStringPtr(v *string) *string {
	if v == nil {
		return nil
	}
	s := strings.TrimSpace(*v)
	if s == "" {
		return nil
	}
	return &s
}

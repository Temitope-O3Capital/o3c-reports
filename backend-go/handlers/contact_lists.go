package handlers

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"unicode"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

func RegisterContactLists(r chi.Router, db *core.DB) {
	access := core.RequirePages("campaigns")
	r.With(access).Get("/", listContactLists(db))
	r.With(access).Post("/", createContactList(db))
	r.With(access).Get("/{id}", getContactList(db))
	r.With(access).Put("/{id}", updateContactList(db))
	r.With(access).Delete("/{id}", deleteContactList(db))
	// How this list's people may be contacted for marketing — the answer the sender now
	// requires before it will send to a list of non-customers.
	r.With(access).Put("/{id}/consent-basis", setListConsentBasis(db))
	r.With(access).Get("/{id}/members", listListMembers(db))
	r.With(access).Post("/{id}/members", addListMember(db))
	r.With(access).Put("/{id}/members/{mid}", updateListMember(db))
	r.With(access).Delete("/{id}/members/{mid}", removeListMember(db))
	r.With(access).Post("/{id}/preflight", preflightListCSV(db))
	r.With(access).Post("/{id}/upload", uploadListCSV(db))

	// Contact Segments — one-shot build a contact list from CCS filter criteria
	r.With(access).Post("/segment/preview", segmentPreview(db))
	r.With(access).Post("/segment/create", segmentCreate(db))

	// Saved (reusable/refreshable) segments
	r.With(access).Get("/segments", listSegments(db))
	r.With(access).Post("/segments", createSegment(db))
	r.With(access).Get("/segments/{sid}", getSegment(db))
	r.With(access).Put("/segments/{sid}", updateSegment(db))
	r.With(access).Delete("/segments/{sid}", deleteSegment(db))
	r.With(access).Post("/segments/{sid}/materialize", materializeSegmentHandler(db))
	// Whether this audience could lawfully be marketed to, and the one place to decide it
	// for a whole population rather than one customer at a time.
	r.With(access).Get("/segments/{sid}/consent", segmentConsentStatus(db))
	r.With(access).Post("/segments/{sid}/consent", segmentRecordConsent(db))

	// Which stored emails and phones cannot actually be used. Read-only.
	r.With(access).Get("/contact-quality", contactDataQuality(db))
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
			respondErrLog(w, 500, "Query failed", err)
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
			respondErrLog(w, 500, "Query failed", err)
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

// setListConsentBasis records how the people on a list may be contacted for marketing.
//
// Its own endpoint rather than a field on updateContactList, for two reasons. It needs to
// record WHO decided and when, which a name edit has no business touching; and a rename
// must not be able to clear a compliance decision by omitting a field.
//
// This exists because the sender now refuses a prospect list with no recorded basis. The
// 28,529 bought-in CRC contacts are not parties, so app.party_contact_consent cannot hold
// anything for them — the basis is a property of the LIST, and somebody has to state it.
func setListConsentBasis(db *core.DB) http.HandlerFunc {
	// Mirrors the CHECK in migration 343. Kept here too so the refusal is a sentence
	// rather than a constraint violation.
	allowed := map[string]string{
		"opt_in_collected":     "they asked us to contact them",
		"third_party_asserted": "the source asserts consent, we did not collect it",
		"legitimate_interest":  "existing relationship, related subject",
		"not_for_marketing":    "explicitly not to be marketed to",
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var b struct {
			Basis string `json:"basis"`
			Note  string `json:"note"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		b.Basis, b.Note = strings.TrimSpace(b.Basis), strings.TrimSpace(b.Note)
		if b.Basis != "" {
			if _, ok := allowed[b.Basis]; !ok {
				respondErr(w, 422, "\""+b.Basis+"\" is not a basis. Use one of "+
					"opt_in_collected, third_party_asserted, legitimate_interest, not_for_marketing.")
				return
			}
			// A weak basis has to be explained. "A supplier said so" is a defensible
			// position only if the record says which supplier and when.
			if b.Basis == "third_party_asserted" && b.Note == "" {
				respondErr(w, 422, "Say where this list came from and what the supplier "+
					"asserted. A third-party claim with no note cannot be defended later.")
				return
			}
		}
		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(), `
			UPDATE contact_lists
			   SET consent_basis = NULLIF($1,''), consent_note = NULLIF($2,''),
			       consent_recorded_by = $3, consent_recorded_at = NOW(), updated_at = NOW()
			 WHERE id = $4
			RETURNING id, name, consent_basis, consent_note, consent_recorded_at`,
			b.Basis, b.Note, nullableInt64(user.ID), id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "List not found")
			return
		}
		aid, aname, ateam := actorOf(user)
		//nolint:errcheck // the basis is recorded; a failed log must not undo it
		LogActivity(r.Context(), db, Activity{
			ActorUserID: aid, ActorName: aname, ActorTeam: ateam,
			Type: "note", Source: "manual",
			Subject: "Marketing basis set for list " + str(rows[0]["name"]),
			Body: fmt.Sprintf("Contact list %q may be marketed to on the basis %q (%s). Note: %s",
				str(rows[0]["name"]), orDash(b.Basis), allowed[b.Basis], orDash(b.Note)),
			EntityType: "contact_list", EntityID: id,
		})
		respond(w, rows[0], "pg")
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
			State     *string        `json:"state"`
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
		b.State = cleanStringPtr(b.State)
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
			    (list_id, first_name, last_name, phone, email, phone_hmac, email_hmac, cif_number, state, merge_data)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) RETURNING *`,
			id, b.FirstName, b.LastName, b.Phone, b.Email,
			nullStr(blindContactHMAC(phoneVal)), nullStr(blindContactHMAC(emailVal)),
			b.CIFNumber, b.State, string(mergeJSON))
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
			State     *string `json:"state"`
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
		b.State = cleanStringPtr(b.State)
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
			    phone_hmac=$5, email_hmac=$6, cif_number=$7, state=$8, updated_at=NOW()
			WHERE id=$9 AND list_id=$10 RETURNING *`,
			b.FirstName, b.LastName, b.Phone, b.Email,
			nullStr(blindContactHMAC(phoneVal)), nullStr(blindContactHMAC(emailVal)),
			b.CIFNumber, b.State, mid, id)
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
	state     interface{}
	mergeJSON string
}

var knownContactCols = map[string]bool{
	"first_name": true, "last_name": true, "phone": true, "email": true, "cif_number": true, "state": true,
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
		state := strings.TrimSpace(row["state"])
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
			state:     emptyToNil(state),
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
			sb.WriteString("INSERT INTO contact_list_members (list_id, first_name, last_name, phone, email, phone_hmac, email_hmac, cif_number, state, merge_data) VALUES ")
			args := make([]interface{}, 0, len(batch)*10)
			for i, row := range batch {
				if i > 0 {
					sb.WriteString(",")
				}
				n := i*10 + 1
				fmt.Fprintf(&sb, "($%d,$%d,$%d,$%d,$%d,$%d,$%d,$%d,$%d,$%d::jsonb)", n, n+1, n+2, n+3, n+4, n+5, n+6, n+7, n+8, n+9)
				args = append(args, id, row.firstName, row.lastName, row.phone, row.email, row.phoneHMAC, row.emailHMAC, row.cifNumber, row.state, row.mergeJSON)
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

// ── Contact Segments ──────────────────────────────────────────────────────────
// Builds a dynamic contact list from CCS / loan_applications filter criteria.

// Which population a segment is drawn from. These are not interchangeable: the loan book
// is a table of APPLICATIONS and the customer base is a table of PEOPLE, so a filter that
// means something against one is meaningless against the other.
const (
	// The loan book — what this always did, and still the default so a saved segment
	// keeps its meaning.
	segmentAudienceApplications = "applications"
	// Everyone holding a live product: app.customer_lifecycle.open_products > 0. This is
	// the platform's own definition of an active customer, the same one migration 290
	// used to seed servicing consent, so a segment and that lawful basis cannot disagree.
	segmentAudienceCustomers = "customers"

	// An explicit ceiling, reported when hit. It replaces a bare `LIMIT 5000` buried in
	// the materialiser: against 17,890 active customers that silently dropped 72% of the
	// audience and called it a success, which is the failure mode nobody notices.
	segmentMaxMembers = 100000
)

type segmentCriteria struct {
	Name string `json:"name"`
	// "customers" or "applications" (default). See the constants above.
	Audience string `json:"audience"`
	// Only include people who can actually be reached that way. Off by default, because
	// a segment is also used for SMS and the right answer differs per campaign.
	RequireEmail bool `json:"require_email"`
	RequirePhone bool `json:"require_phone"`

	// ── Customer-base filters. Meaningful ONLY for the customers audience ────────
	Buckets    []string `json:"buckets"`     // customer_lifecycle.bucket
	ValueTiers []string `json:"value_tiers"` // customer_lifecycle.value_tier
	// "Has not transacted in N days" — the audience this page is most often wanted for.
	MinDaysSinceTxn int `json:"min_days_since_txn"`
	MaxDaysSinceTxn int `json:"max_days_since_txn"`
	// What to do about the customers whose last transaction date is UNKNOWN, which is
	// 11,483 of the 17,890 active ones — the majority. "" and "exclude" leave them out,
	// "include" adds them to a days-since filter, "only" selects just them. There is no
	// sensible default that is also honest: a NULL here means no transaction data reached
	// us, NOT a customer proven to be quiet, and silently folding the two together would
	// put 11,483 people into a "dormant" campaign on the strength of a missing feed.
	NeverTransacted string `json:"never_transacted"`
	// Leave out anyone a recovery officer is already working. Off by default so it stays
	// a choice, but it is almost always the right one for marketing.
	ExcludeRecovery bool `json:"exclude_recovery"`

	// ── Loan-book filters. Meaningful ONLY for the applications audience ──────────
	DPDBuckets         []string `json:"dpd_buckets"` // e.g. ["0","1-30","31-60","61-90","91+"]
	Products           []string `json:"products"`    // e.g. ["Salary Loan","Business Loan"]
	Stages             []string `json:"stages"`      // loan_applications.stage
	Statuses           []string `json:"statuses"`    // loan_applications.status
	Employers          []string `json:"employers"`   // employer name substring
	MinDPD             int      `json:"min_dpd"`
	MaxDPD             int      `json:"max_dpd"`
	MinOutstandingKobo int64    `json:"min_outstanding_kobo"`
	MaxOutstandingKobo int64    `json:"max_outstanding_kobo"`
}

// segmentAudience normalises the audience, defaulting to the loan book.
func segmentAudience(c segmentCriteria) string {
	if strings.TrimSpace(c.Audience) == segmentAudienceCustomers {
		return segmentAudienceCustomers
	}
	return segmentAudienceApplications
}

// segmentCriteriaProblem rejects a combination that cannot mean what it says.
//
// It REFUSES rather than ignores, and that direction is the whole point. A DPD band or an
// employer filter has no counterpart in the customer base, so quietly dropping it would
// turn "active customers in arrears 31-60" into "every active customer" and then message
// all 17,890 of them. That is the same failure the DPD-bucket switch below was fixed for:
// a segment returning nobody gets noticed, one returning everybody looks like a success.
func segmentCriteriaProblem(c segmentCriteria) string {
	if segmentAudience(c) != segmentAudienceCustomers {
		// The mirror image, and just as dangerous. A lifecycle bucket or a days-since
		// filter has no counterpart on loan_applications, so ignoring it would turn
		// "applicants who have not transacted in a year" into "every applicant".
		var wrong []string
		if len(c.Buckets) > 0 {
			wrong = append(wrong, "lifecycle bucket")
		}
		if len(c.ValueTiers) > 0 {
			wrong = append(wrong, "value tier")
		}
		if c.MinDaysSinceTxn > 0 || c.MaxDaysSinceTxn > 0 || strings.TrimSpace(c.NeverTransacted) != "" {
			wrong = append(wrong, "time since last transaction")
		}
		if c.ExcludeRecovery {
			wrong = append(wrong, "already with recovery")
		}
		if len(wrong) == 0 {
			return ""
		}
		return "A loan-book segment cannot be filtered by " + strings.Join(wrong, ", ") +
			" — those describe a customer, not an application. Either drop the filter or " +
			"build this against the active customers instead."
	}
	if nt := strings.TrimSpace(c.NeverTransacted); nt != "" &&
		nt != "include" && nt != "exclude" && nt != "only" {
		return `"` + nt + `" is not a way to treat customers with no transaction date. ` +
			`Use "include", "exclude" or "only".`
	}
	var named []string
	if len(c.DPDBuckets) > 0 {
		named = append(named, "arrears band")
	}
	if len(c.Stages) > 0 {
		named = append(named, "application stage")
	}
	if len(c.Statuses) > 0 {
		named = append(named, "application status")
	}
	if len(c.Employers) > 0 {
		named = append(named, "employer")
	}
	if len(c.Products) > 0 {
		named = append(named, "loan product")
	}
	if c.MinDPD > 0 || c.MaxDPD > 0 {
		named = append(named, "days past due")
	}
	if c.MinOutstandingKobo > 0 || c.MaxOutstandingKobo > 0 {
		named = append(named, "outstanding balance")
	}
	if len(named) == 0 {
		return ""
	}
	return "An active-customer segment cannot be filtered by " + strings.Join(named, ", ") +
		" — those describe a loan application, not a customer. Either drop the filter or " +
		"build this against the loan book instead."
}

func buildSegmentWhere(c segmentCriteria) (string, []any) {
	var sb strings.Builder
	var args []any
	n := 1

	if len(c.Products) > 0 {
		placeholders := make([]string, len(c.Products))
		for i, p := range c.Products {
			placeholders[i] = fmt.Sprintf("$%d", n)
			args = append(args, p)
			n++
		}
		sb.WriteString(" AND COALESCE(product_type, loan_type) IN (" + strings.Join(placeholders, ",") + ")")
	}
	if len(c.Stages) > 0 {
		placeholders := make([]string, len(c.Stages))
		for i, s := range c.Stages {
			placeholders[i] = fmt.Sprintf("$%d", n)
			args = append(args, s)
			n++
		}
		sb.WriteString(" AND stage IN (" + strings.Join(placeholders, ",") + ")")
	}
	if len(c.Statuses) > 0 {
		placeholders := make([]string, len(c.Statuses))
		for i, s := range c.Statuses {
			placeholders[i] = fmt.Sprintf("$%d", n)
			args = append(args, s)
			n++
		}
		sb.WriteString(" AND status IN (" + strings.Join(placeholders, ",") + ")")
	}
	if len(c.Employers) > 0 {
		parts := make([]string, len(c.Employers))
		for i, e := range c.Employers {
			parts[i] = fmt.Sprintf("employer ILIKE $%d", n)
			args = append(args, "%"+e+"%")
			n++
		}
		sb.WriteString(" AND (" + strings.Join(parts, " OR ") + ")")
	}
	if c.MaxDPD > 0 {
		sb.WriteString(fmt.Sprintf(" AND COALESCE(dpd,0) <= $%d", n))
		args = append(args, c.MaxDPD)
		n++
	}
	if c.MinDPD > 0 {
		sb.WriteString(fmt.Sprintf(" AND COALESCE(dpd,0) >= $%d", n))
		args = append(args, c.MinDPD)
		n++
	}
	if c.MinOutstandingKobo > 0 {
		sb.WriteString(fmt.Sprintf(" AND COALESCE(outstanding_kobo,0) >= $%d", n))
		args = append(args, c.MinOutstandingKobo)
		n++
	}
	if c.MaxOutstandingKobo > 0 {
		sb.WriteString(fmt.Sprintf(" AND COALESCE(outstanding_kobo,0) <= $%d", n))
		args = append(args, c.MaxOutstandingKobo)
		n++
	}
	// DPD buckets, matching the values the platform actually PRODUCES.
	//
	// This switch was written against a five-step ladder ending "91+", which nothing emits.
	// app.collections_delinquent_unified (migrations 137/198/299) produces a seven-step ladder
	// whose tail is '91-180', '181-360' and '360+', and the collections queue filter offers
	// exactly those. So a segment built on ANY deep-DPD bucket matched no case, contributed no
	// clause, and — because the block below is skipped when `parts` is empty — applied NO DPD
	// FILTER AT ALL.
	//
	// That is the dangerous direction for a targeting rule: ask for the 90+ slice, get the
	// ENTIRE BOOK, then message all of it. A segment returning nobody gets noticed; one
	// returning everybody looks like a successful campaign.
	//
	// An unrecognised bucket now fails CLOSED — a FALSE disjunct, so it selects nobody rather
	// than everybody. '90+' and '91+' are kept as accepted synonyms because saved segments may
	// still hold them. '0' is <= 0 rather than = 0 to match every other ladder in the codebase.
	if len(c.DPDBuckets) > 0 {
		var parts []string
		for _, b := range c.DPDBuckets {
			switch b {
			case "0":
				parts = append(parts, "COALESCE(dpd,0) <= 0")
			case "1-30":
				parts = append(parts, "COALESCE(dpd,0) BETWEEN 1 AND 30")
			case "31-60":
				parts = append(parts, "COALESCE(dpd,0) BETWEEN 31 AND 60")
			case "61-90":
				parts = append(parts, "COALESCE(dpd,0) BETWEEN 61 AND 90")
			case "91-180":
				parts = append(parts, "COALESCE(dpd,0) BETWEEN 91 AND 180")
			case "181-360":
				parts = append(parts, "COALESCE(dpd,0) BETWEEN 181 AND 360")
			case "360+":
				parts = append(parts, "COALESCE(dpd,0) > 360")
			case "90+", "91+":
				parts = append(parts, "COALESCE(dpd,0) > 90")
			default:
				slog.Warn("contact list segment: unknown dpd bucket — selecting nobody for it "+
					"rather than widening the audience", "bucket", b)
				parts = append(parts, "FALSE")
			}
		}
		if len(parts) > 0 {
			sb.WriteString(" AND (" + strings.Join(parts, " OR ") + ")")
		}
	}
	_ = n
	return sb.String(), args
}

func segmentPreview(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var c segmentCriteria
		if err := json.NewDecoder(r.Body).Decode(&c); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if problem := segmentCriteriaProblem(c); problem != "" {
			respondErr(w, 422, problem)
			return
		}
		// Counted the way the build counts, so the preview cannot promise an audience the
		// refresh then declines to produce. The old preview ran COUNT(*) over
		// loan_applications while the build ran DISTINCT ON (applicant_cif) under a
		// 5,000 cap, so a preview of 12,000 could materialise as 5,000 and look fine.
		rows, err := segmentCandidates(r.Context(), db, c)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		truncated := 0
		if len(rows) > segmentMaxMembers {
			truncated = len(rows) - segmentMaxMembers
			rows = rows[:segmentMaxMembers]
		}
		var mailable, textable, noContact, known int
		for _, m := range rows {
			email, phone := strings.TrimSpace(str(m["email"])), strings.TrimSpace(str(m["phone"]))
			switch {
			case email == "" && phone == "":
				noContact++
			default:
				if email != "" {
					mailable++
				}
				if phone != "" {
					textable++
				}
			}
			if toInt64(m["party_id"]) > 0 {
				known++
			}
		}
		respond(w, map[string]any{
			// "count" stays the headline for the existing UI, and is now the number that
			// would actually be imported rather than the number merely matched.
			"count":        len(rows) - noContact,
			"matched":      len(rows),
			"no_contact":   noContact,
			"mailable":     mailable,
			"textable":     textable,
			"known_people": known,
			"truncated":    truncated,
			"audience":     segmentAudience(c),
		}, "pg")
	}
}

func segmentCreate(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var c segmentCriteria
		if err := json.NewDecoder(r.Body).Decode(&c); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if strings.TrimSpace(c.Name) == "" {
			respondErr(w, 400, "name is required")
			return
		}
		if problem := segmentCriteriaProblem(c); problem != "" {
			respondErr(w, 422, problem)
			return
		}

		ctx := r.Context()
		user := core.UserFromCtx(ctx)

		// Create the contact list
		listRows, err := db.PGQuery(ctx,
			`INSERT INTO contact_lists (name, description, created_by, created_at, updated_at)
			 VALUES ($1, $2, $3, NOW(), NOW()) RETURNING id`,
			c.Name, "Segment: auto-generated from CCS filters", user.ID)
		if err != nil || len(listRows) == 0 {
			respondErr(w, 500, "Failed to create list")
			return
		}
		listID := toInt64(listRows[0]["id"])

		out, err := materializeSegmentToList(ctx, db, listID, c)
		if err != nil {
			respondErrLog(w, 500, "Failed to query members", err)
			return
		}

		respond(w, map[string]any{
			"list_id":      listID,
			"name":         c.Name,
			"audience":     segmentAudience(c),
			"imported":     out.Imported,
			"no_contact":   out.NoContact,
			"mailable":     out.Mailable,
			"textable":     out.Textable,
			"known_people": out.KnownPeople,
			"collided":     out.Collided,
			"truncated":    out.Truncated,
		}, "pg")
	}
}

// segmentOutcome is what a build actually did, so the caller can say so rather than
// report a bare count that hides what was dropped.
type segmentOutcome struct {
	Imported    int `json:"imported"`
	NoContact   int `json:"no_contact"`   // matched, but no email and no phone
	Mailable    int `json:"mailable"`     // of those imported, how many can be emailed
	Textable    int `json:"textable"`     // of those imported, how many have a phone
	Truncated   int `json:"truncated"`    // matched beyond segmentMaxMembers
	KnownPeople int `json:"known_people"` // imported rows carrying a party_id
	// Dropped by the list's own unique indexes — most often two people on one phone.
	Collided int `json:"collided"`
}

// buildCustomerSegmentWhere renders the customer-base filters against
// app.v_customer_contactability. Returns a fragment beginning " AND …" and its args
// starting at $1, the same contract buildSegmentWhere has for the loan book.
func buildCustomerSegmentWhere(c segmentCriteria) (string, []any) {
	var sb strings.Builder
	var args []any
	ph := func(v any) string {
		args = append(args, v)
		return fmt.Sprintf("$%d", len(args))
	}

	// Explicit placeholders rather than = ANY($n): buildSegmentWhere in this same file
	// does it this way, and it avoids depending on the driver's array handling.
	inList := func(col string, vals []string) {
		parts := make([]string, len(vals))
		for i, v := range vals {
			parts[i] = ph(v)
		}
		sb.WriteString(" AND " + col + " IN (" + strings.Join(parts, ",") + ")")
	}
	if len(c.Buckets) > 0 {
		inList("bucket", c.Buckets)
	}
	if len(c.ValueTiers) > 0 {
		inList("value_tier", c.ValueTiers)
	}
	if c.ExcludeRecovery {
		sb.WriteString(" AND NOT COALESCE(has_open_recovery, false)")
	}
	if c.RequireEmail {
		sb.WriteString(" AND email IS NOT NULL")
	}
	if c.RequirePhone {
		sb.WriteString(" AND phone IS NOT NULL")
	}

	// Time since the last transaction, and what to do about the ones we cannot date.
	//
	// days_since_txn IS NULL is NOT "has never transacted" — it is "no transaction date
	// reached us", which on 2026-10-06 was true of 11,483 of the 17,890 active customers.
	// A plain `days_since_txn >= 90` excludes them in SQL anyway; the point of saying so
	// explicitly is that "include" is then a deliberate act, because folding the unknown
	// in with the proven-quiet is how a dormancy campaign ends up addressing the majority
	// of the book on the strength of a missing feed.
	var dateBound string
	if c.MinDaysSinceTxn > 0 {
		dateBound += " AND days_since_txn >= " + ph(c.MinDaysSinceTxn)
	}
	if c.MaxDaysSinceTxn > 0 {
		dateBound += " AND days_since_txn <= " + ph(c.MaxDaysSinceTxn)
	}
	switch strings.TrimSpace(c.NeverTransacted) {
	case "only":
		sb.WriteString(" AND days_since_txn IS NULL")
	case "include":
		if dateBound != "" {
			// "matches the window, OR we have no date for them at all"
			sb.WriteString(" AND ((TRUE" + dateBound + ") OR days_since_txn IS NULL)")
		}
		// With no window, "include" is simply no filter — everyone is already in.
	default: // "" and "exclude"
		if dateBound != "" {
			sb.WriteString(dateBound)
		}
		if strings.TrimSpace(c.NeverTransacted) == "exclude" {
			sb.WriteString(" AND days_since_txn IS NOT NULL")
		}
	}
	return sb.String(), args
}

// segmentCandidates reads the people a segment selects, for either audience.
//
// Both branches return the same shape — party_id, cif, name, email, phone — because the
// difference between the two audiences belongs in SQL and not in the loop below.
func segmentCandidates(ctx context.Context, db *core.DB, c segmentCriteria) ([]core.Row, error) {
	if segmentAudience(c) == segmentAudienceCustomers {
		// app.v_customer_contactability already holds the validated email/phone, so the
		// plausibility rule lives in exactly one place. Without it, 4,073 active customers
		// "have" the phone 08012345678 and a live SMS run texts that number 4,073 times.
		where, args := buildCustomerSegmentWhere(c)
		args = append(args, segmentMaxMembers+1)
		return db.PGQuery(ctx, fmt.Sprintf(`
			SELECT party_id, cust_id AS cif, full_name AS name, email, phone
			  FROM app.v_customer_contactability
			 WHERE open_products > 0%s
			 ORDER BY party_id
			 LIMIT $%d`, where, len(args)), args...)
	}
	// The loan book.
	//
	// Two defects fixed here. First, applicant_email/email and party_id were always on
	// this table and simply never selected, so every segment-built list had a NULL email
	// on every row and could not be mailed at all.
	//
	// Second, and worse: this required `applicant_cif <> ''` and deduped on that column.
	// On 2026-10-06 app.loan_applications held 8 rows, NONE with an applicant_cif — so
	// this branch could never return a single person, and never had. That is why
	// contact_segments was empty: the one audience the builder offered was structurally
	// incapable of producing anybody. Identity is now whatever actually identifies the
	// row, and the filter asks for a way to CONTACT them, which is what a contact list is
	// for.
	where, args := buildSegmentWhere(c)
	args = append(args, c.RequireEmail, c.RequirePhone, segmentMaxMembers+1)
	n := len(args)
	return db.PGQuery(ctx, fmt.Sprintf(`
		SELECT DISTINCT ON (COALESCE(NULLIF(applicant_cif,''), 'p'||party_id::text,
		                             lower(NULLIF(applicant_email,'')), lower(NULLIF(email,'')),
		                             NULLIF(phone,''), 'id'||id::text))
		       party_id, applicant_cif AS cif, applicant_name AS name,
		       CASE WHEN app.is_emailable(COALESCE(NULLIF(applicant_email,''), email))
		            THEN btrim(COALESCE(NULLIF(applicant_email,''), email)) END AS email,
		       CASE WHEN app.is_dialable_ng_phone(phone)
		            THEN app.normalise_ng_phone(phone) END                      AS phone
		  FROM loan_applications
		 WHERE (app.is_emailable(COALESCE(NULLIF(applicant_email,''), email))
		        OR app.is_dialable_ng_phone(phone))%s
		   AND (NOT $%d::boolean OR app.is_emailable(COALESCE(NULLIF(applicant_email,''), email)))
		   AND (NOT $%d::boolean OR app.is_dialable_ng_phone(phone))
		 ORDER BY COALESCE(NULLIF(applicant_cif,''), 'p'||party_id::text,
		                   lower(NULLIF(applicant_email,'')), lower(NULLIF(email,'')),
		                   NULLIF(phone,''), 'id'||id::text), created_at DESC
		 LIMIT $%d`, where, n-2, n-1, n), args...)
}

// materializeSegmentToList fills (or refills) a contact list with the people the segment
// selects. Reused by one-shot creation and by saved-segment refresh.
//
// Writes email and the blind-index HMACs, neither of which it used to. The HMACs matter
// because campaign_contacts snapshots them and the lookups keyed on them would otherwise
// miss; party_id matters because without it nothing downstream can consult
// app.party_contact_consent or app.is_suppressed for this person at all.
func materializeSegmentToList(ctx context.Context, db *core.DB, listID int64, c segmentCriteria) (segmentOutcome, error) {
	var out segmentOutcome
	rows, err := segmentCandidates(ctx, db, c)
	if err != nil {
		return out, err
	}
	if len(rows) > segmentMaxMembers {
		out.Truncated = len(rows) - segmentMaxMembers
		rows = rows[:segmentMaxMembers]
	}

	type member struct {
		partyID            int64
		cif, first, last   string
		email, phone       string
		phoneHMAC, mailMAC string
	}
	batch := make([]member, 0, len(rows))
	for _, r := range rows {
		email := strings.TrimSpace(str(r["email"]))
		phone := strings.TrimSpace(str(r["phone"]))
		if email == "" && phone == "" {
			// Counted, not imported. A contact list exists to contact people, and a row
			// with no address is noise in every campaign that ever uses it — but the
			// number is a work item for whoever owns the data, so it is reported.
			out.NoContact++
			continue
		}
		first, last := splitSegmentName(str(r["name"]))
		m := member{
			partyID: toInt64(r["party_id"]),
			cif:     strings.TrimSpace(str(r["cif"])),
			first:   first, last: last, email: email, phone: phone,
			phoneHMAC: blindContactHMAC(phone), mailMAC: blindContactHMAC(email),
		}
		batch = append(batch, m)
		if email != "" {
			out.Mailable++
		}
		if phone != "" {
			out.Textable++
		}
		if m.partyID > 0 {
			out.KnownPeople++
		}
	}

	// Batched, because one INSERT per person is 17,890 round trips for the active-customer
	// segment and the old loop did exactly that under a 5,000 cap.
	const chunk = 500
	for start := 0; start < len(batch); start += chunk {
		end := start + chunk
		if end > len(batch) {
			end = len(batch)
		}
		var sb strings.Builder
		sb.WriteString(`INSERT INTO contact_list_members
			(list_id, party_id, cif_number, first_name, last_name, phone, email,
			 phone_hmac, email_hmac, status, created_at, updated_at) VALUES `)
		args := []any{listID}
		for i, m := range batch[start:end] {
			if i > 0 {
				sb.WriteString(",")
			}
			b := len(args)
			fmt.Fprintf(&sb, "($1,$%d,$%d,$%d,$%d,$%d,$%d,$%d,$%d,'active',NOW(),NOW())",
				b+1, b+2, b+3, b+4, b+5, b+6, b+7, b+8)
			args = append(args,
				nullableInt64(m.partyID), nullIfBlank(m.cif), m.first, nullIfBlank(m.last),
				nullIfBlank(m.phone), nullIfBlank(m.email),
				nullIfBlank(m.phoneHMAC), nullIfBlank(m.mailMAC))
		}
		// ON CONFLICT DO NOTHING is load-bearing, and so is counting what it actually
		// wrote. contact_list_members carries UNIQUE (list_id, phone) and
		// UNIQUE (list_id, cif_number), and real people do share a number — 6,485 active
		// customers hold 6,237 distinct dialable phones, so ~248 rows collide legitimately
		// (a shared household handset). Counting the chunk SIZE instead of the rows
		// inserted would report an audience larger than the list, which is the same
		// species of lie as the silent LIMIT this function used to carry.
		sb.WriteString(" ON CONFLICT DO NOTHING")
		res, e := db.PGExec(ctx, sb.String(), args...)
		if e != nil {
			return out, e
		}
		if n, err := res.RowsAffected(); err == nil {
			out.Imported += int(n)
			out.Collided += (end - start) - int(n)
		} else {
			// Driver would not say; the chunk size is the only number available.
			out.Imported += end - start
		}
	}

	db.PGExec(ctx, //nolint:errcheck
		"UPDATE contact_lists SET member_count=$1, updated_at=NOW() WHERE id=$2", out.Imported, listID)
	return out, nil
}

// splitSegmentName splits a stored full name into first and last. The whole name goes to
// last_name when there is only one word, matching what the CSV loader does.
func splitSegmentName(full string) (first, last string) {
	full = strings.Join(strings.Fields(full), " ")
	if i := strings.Index(full, " "); i > 0 {
		return full[:i], strings.TrimSpace(full[i+1:])
	}
	return "", full
}

package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

var templateChannels = map[string]bool{"sms": true, "email": true, "whatsapp": true}
var templateCategories = map[string]bool{
	"general": true, "collections": true, "marketing": true,
	"onboarding": true, "repayment_reminder": true,
}

// templateCategoryList returns templateCategories as a sorted slice, so an error message
// cannot list a different set from the one actually enforced.
func templateCategoryList() []string {
	out := make([]string, 0, len(templateCategories))
	for k := range templateCategories {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// templateCategoryAutomation names the categories a WORKER reads on a schedule, and says
// what stops when one is left with nothing in it.
//
// Exactly ONE category is load-bearing, and the asymmetry is the whole problem. Every
// other category is a label: a campaign journey picks its template by id
// (campaign_steps.go), so filing something under 'marketing' or 'repayment_reminder'
// changes how it sorts on a screen and nothing else. 'collections' is different —
// collections_dunning.go selects WHERE category = 'collections' and, finding nothing,
// reports "no collections template configured" through a worker heartbeat and sends no
// demands. No error, no alert, no bounce: a heartbeat that reads idle.
//
// 'repayment_reminder' is the trap this exists to close, and it is the obvious place to
// file collections copy. It is NOT dead — the three starter templates under it are
// genuine pre-due reminders ("your repayment is due on {{due_date}}"), properly distinct
// from an arrears demand, and a campaign can send them. But nothing automated reads it,
// so a dunning template re-filed there simply stops going out.
var templateCategoryAutomation = map[string]string{
	"collections": "the dunning worker, which writes to customers in arrears",
}

// templateCategoryStrandsAutomation reports whether changing or removing this template
// would leave an automated category empty — and so silently switch off the worker that
// reads it.
//
// newCategory == "" means the template is being deleted. Returns the stranded category
// and the consequence, for an error message that names what would stop rather than just
// refusing.
func templateCategoryStrandsAutomation(ctx context.Context, db *core.DB, id, newCategory string) (string, string, bool) {
	rows, err := db.PGQuery(ctx, `SELECT category FROM app.message_templates WHERE id = $1`, id)
	if err != nil || len(rows) == 0 {
		// Nothing to strand, or nothing we can read. Never block an edit on a failed
		// lookup: the guard exists to prevent a silent stop, not to invent a new one.
		return "", "", false
	}
	current := str(rows[0]["category"])
	consequence, automated := templateCategoryAutomation[current]
	if !automated || current == newCategory {
		return "", "", false
	}
	left, err := db.PGQuery(ctx,
		`SELECT count(*) AS n FROM app.message_templates WHERE category = $1 AND id <> $2`,
		current, id)
	if err != nil || len(left) == 0 || toInt64(left[0]["n"]) > 0 {
		return "", "", false
	}
	return current, consequence, true
}

var templateUpdateCols = []string{
	"name", "category", "sms_body", "whatsapp_body", "email_subject",
	"email_body_html", "email_body_text", "email_blocks", "merge_tags",
}

func normalizeTemplatePayload(body map[string]any) map[string]any {
	if v, ok := body["subject"]; ok {
		body["email_subject"] = v
	}
	if v, ok := body["body"]; ok {
		switch str(body["channel"]) {
		case "email":
			body["email_body_html"] = v
		case "whatsapp":
			body["whatsapp_body"] = v
		default:
			body["sms_body"] = v
		}
	}
	if v, ok := body["variables"]; ok {
		body["merge_tags"] = v
	}
	return body
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
			where += fmt.Sprintf(" AND t.channel=$%d", n)
			args = append(args, v)
			n++
		}
		if v := qstr(r, "category"); v != "" {
			where += fmt.Sprintf(" AND t.category=$%d", n)
			args = append(args, v)
			n++
		}
		if v := qstr(r, "from"); v != "" {
			where += fmt.Sprintf(" AND t.created_at::date >= $%d::date", n)
			args = append(args, v)
			n++
		}
		if v := qstr(r, "to"); v != "" {
			where += fmt.Sprintf(" AND t.created_at::date <= $%d::date", n)
			args = append(args, v)
			n++
		}
		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT t.*, u.full_name AS created_by_name
			FROM message_templates t
			LEFT JOIN o3c_users u ON t.created_by=u.id
			WHERE %s ORDER BY t.created_at DESC`, where), args...)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
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
			Subject       *string  `json:"subject"`
			Body          *string  `json:"body"`
			SMSBody       *string  `json:"sms_body"`
			WhatsappBody  *string  `json:"whatsapp_body"`
			EmailSubject  *string  `json:"email_subject"`
			EmailBodyHTML *string  `json:"email_body_html"`
			EmailBodyText *string  `json:"email_body_text"`
			EmailBlocks   any      `json:"email_blocks"`
			Variables     []string `json:"variables"`
			MergeTags     []string `json:"merge_tags"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Name == "" {
			respondErr(w, 422, "name is required")
			return
		}
		if !templateChannels[b.Channel] {
			respondErr(w, 422, "channel must be sms, email or whatsapp")
			return
		}
		if b.Category == "" {
			b.Category = "general"
		}
		if !templateCategories[b.Category] {
			b.Category = "general"
		}
		if b.MergeTags == nil {
			b.MergeTags = b.Variables
		}
		if b.MergeTags == nil {
			b.MergeTags = []string{}
		}
		if b.EmailSubject == nil {
			b.EmailSubject = b.Subject
		}
		if b.Body != nil {
			if b.Channel == "email" && b.EmailBodyHTML == nil {
				b.EmailBodyHTML = b.Body
			}
			if b.Channel == "sms" && b.SMSBody == nil {
				b.SMSBody = b.Body
			}
			if b.Channel == "whatsapp" && b.WhatsappBody == nil {
				b.WhatsappBody = b.Body
			}
		}
		tagsJSON, _ := json.Marshal(b.MergeTags)
		blocksJSON, _ := json.Marshal(b.EmailBlocks)
		if b.EmailBlocks == nil {
			blocksJSON = []byte("[]")
		}
		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO message_templates
			    (name, channel, category, sms_body, whatsapp_body, email_subject, email_body_html,
			     email_body_text, email_blocks, merge_tags, created_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11) RETURNING *`,
			b.Name, b.Channel, b.Category, b.SMSBody, b.WhatsappBody, b.EmailSubject,
			b.EmailBodyHTML, b.EmailBodyText, string(blocksJSON), string(tagsJSON), user.ID)
		if err != nil {
			respondErr(w, 500, "Create failed")
			return
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
			respondErr(w, 404, "Template not found")
			return
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
			respondErr(w, 400, "Invalid JSON")
			return
		}
		body = normalizeTemplatePayload(body)
		// createTemplate checks both of these and this path checked NEITHER, while
		// templateUpdateCols lets a PATCH set category directly. The cost is silent: the
		// dunning worker reads WHERE category = 'collections' (collections_dunning.go), so a
		// template re-filed under a category nothing reads simply stops being sent, with no
		// error anywhere. A 422 here rather than createTemplate's quiet coercion to
		// "general", because an edit names a category deliberately.
		if v, ok := body["category"]; ok {
			c, _ := v.(string)
			if !templateCategories[c] {
				respondErr(w, 422, "category must be one of: "+vocabList(templateCategoryList()))
				return
			}
			// Validating the WORD was only half of it. The category is also a switch: move
			// the last 'collections' template out and the dunning worker stops writing to
			// customers in arrears, reporting nothing but an idle heartbeat. Refusing is the
			// same answer deleteTemplate already gives for a template an active campaign
			// needs — and this one names what would stop, because "invalid category" would
			// not explain it.
			if stranded, consequence, would := templateCategoryStrandsAutomation(r.Context(), db, id, c); would {
				respondErr(w, 409, "This is the last '"+stranded+"' template, and "+consequence+
					" reads that category. Moving it to '"+c+"' would stop those messages "+
					"going out, with no error anywhere. Create the replacement first, then "+
					"re-file this one.")
				return
			}
		}
		if v, ok := body["channel"]; ok {
			if c, _ := v.(string); !templateChannels[c] {
				respondErr(w, 422, "channel must be sms, email or whatsapp")
				return
			}
		}
		parts, args := buildSet(body, templateUpdateCols, 1)
		// jsonb fields need explicit casts.
		for i, p := range parts {
			if strings.HasPrefix(p, "merge_tags=") {
				parts[i] = fmt.Sprintf("merge_tags=$%d::jsonb", i+1)
				b, _ := json.Marshal(args[i])
				args[i] = string(b)
			}
			if strings.HasPrefix(p, "email_blocks=") {
				parts[i] = fmt.Sprintf("email_blocks=$%d::jsonb", i+1)
				b, _ := json.Marshal(args[i])
				args[i] = string(b)
			}
		}
		if len(parts) == 0 {
			respondErr(w, 422, "No fields to update")
			return
		}
		parts = append(parts, "updated_at=NOW()")
		args = append(args, id)
		rows, err := db.PGQuery(r.Context(),
			fmt.Sprintf("UPDATE message_templates SET %s WHERE id=$%d RETURNING *",
				strings.Join(parts, ","), len(args)), args...)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Template not found")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func deleteTemplate(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		// M1: refuse deletion if template is referenced by active or scheduled campaigns.
		var refCount int
		db.PG.QueryRowContext(r.Context(), //nolint:errcheck
			`SELECT COUNT(*) FROM campaigns WHERE template_id=$1 AND status IN ('active','scheduled','sending')`, id).Scan(&refCount)
		if refCount > 0 {
			respondErr(w, 409, "Cannot delete a template used by active or scheduled campaigns")
			return
		}
		// The same switch, on the other write path. Deleting the last 'collections'
		// template switches the dunning worker off exactly as moving it would, so the
		// guard belongs here too — a rule on one of two routes is not a rule.
		if stranded, consequence, would := templateCategoryStrandsAutomation(r.Context(), db, id, ""); would {
			respondErr(w, 409, "This is the last '"+stranded+"' template, and "+consequence+
				" reads that category. Deleting it would stop those messages going out, "+
				"with no error anywhere.")
			return
		}
		db.PGExec(r.Context(), "DELETE FROM message_templates WHERE id=$1", id) //nolint:errcheck
		w.WriteHeader(204)
	}
}

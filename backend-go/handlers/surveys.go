package handlers

import (
	"context"
	"crypto/rand"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

// ── Customer feedback & surveys ─────────────────────────────────────────────
//
// A survey is a reusable questionnaire distributed to customers by branded
// email. Each recipient gets an unguessable token (survey_sends.token) that
// opens the public, no-auth response page at /s/{token} — mirroring the CSAT
// flow but multi-question and keyed to a CIF. Responses land in
// survey_responses / survey_answers and surface on Customer 360's Activity
// timeline (c360Activity) so the CRM sees every response.

func RegisterSurveysPublic(r chi.Router, db *core.DB) {
	r.Get("/r/{token}", surveyPublicGet(db))
	r.Post("/r/{token}", surveyPublicSubmit(db))
	r.Post("/r/{token}/capture", surveyInlineCapture(db))
}

func RegisterSurveys(r chi.Router, db *core.DB) {
	r.Use(core.RequirePages("surveys"))
	r.Get("/", surveysList(db))
	r.Post("/", surveyCreate(db))
	r.Get("/recipient-search", surveyRecipientSearch(db))
	r.Get("/{id}", surveyGet(db))
	r.Put("/{id}", surveyUpdate(db))
	r.Delete("/{id}", surveyDelete(db))
	r.Put("/{id}/questions", surveyPutQuestions(db))
	r.Post("/{id}/status", surveySetStatus(db))
	r.Post("/{id}/clone", surveyClone(db))
	r.Get("/{id}/results", surveyResults(db))
	r.Get("/{id}/responses", surveyResponsesList(db))
	r.Get("/{id}/responses/{rid}", surveyResponseDetail(db))
	r.Get("/{id}/export", surveyExport(db))
	r.Get("/{id}/sends", surveySendsList(db))
	r.Post("/{id}/recipients", surveyAddRecipients(db))
	r.Post("/{id}/dispatch", surveyDispatch(db))
	r.Post("/{id}/test-send", surveyTestSend(db))
}

// surveyNewToken returns a 32-hex-char unguessable link token.
func surveyNewToken() string {
	b := make([]byte, 16)
	rand.Read(b) //nolint:errcheck
	return hex.EncodeToString(b)
}

// surveyBaseURL reads the public app base (same setting the CSAT links use).
func surveyBaseURL(ctx context.Context, db *core.DB) string {
	if rows, _ := db.PGQuery(ctx, `SELECT value FROM settings WHERE key='app_base_url'`); len(rows) > 0 {
		return strings.TrimRight(str(rows[0]["value"]), "/")
	}
	return ""
}

// ── Public: fetch a survey by token ─────────────────────────────────────────

func surveyPublicGet(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		token := chi.URLParam(r, "token")
		sends, _ := db.PGQuery(ctx, `
			SELECT ss.id, ss.survey_id, ss.recipient_name, ss.status, ss.responded_at,
			       s.title, s.description, s.intro, s.thank_you, s.accent_color, s.department,
			       s.signoff_name, s.signoff_title, s.status AS survey_status
			FROM survey_sends ss JOIN surveys s ON s.id = ss.survey_id
			WHERE ss.token = $1`, token)
		if len(sends) == 0 {
			respondErr(w, 404, "This survey link is invalid or has expired")
			return
		}
		snd := sends[0]
		if str(snd["survey_status"]) == "closed" {
			respondErr(w, 410, "This survey is now closed")
			return
		}
		alreadyDone := str(snd["status"]) == "responded" || snd["responded_at"] != nil

		// Mark opened (first click) without clobbering a later status.
		db.PGExec(ctx, //nolint:errcheck
			`UPDATE survey_sends SET status='opened', opened_at=COALESCE(opened_at, NOW())
			 WHERE token=$1 AND status IN ('sent','queued','draft')`, token)

		qs, _ := db.PGQuery(ctx, `
			SELECT id, position, qtype, label, help_text, required,
			       scale_min, scale_max, scale_min_label, scale_max_label, options::text AS options
			FROM survey_questions WHERE survey_id = $1 ORDER BY position, id`, toInt64(snd["survey_id"]))

		// Any answers already captured for this send (e.g. a rating tapped in the
		// email) so the page opens pre-filled and the customer just finishes.
		prefill := map[string]any{}
		if pr, _ := db.PGQuery(ctx, `
			SELECT a.question_id, a.rating_value, a.text_value
			FROM survey_answers a JOIN survey_responses r ON r.id = a.response_id
			WHERE r.send_id = $1`, toInt64(snd["id"])); len(pr) > 0 {
			for _, a := range pr {
				m := map[string]any{}
				if a["rating_value"] != nil {
					m["rating"] = toInt64(a["rating_value"])
				}
				if t := str(a["text_value"]); strings.TrimSpace(t) != "" {
					m["text"] = t
				}
				prefill[fmt.Sprintf("%d", toInt64(a["question_id"]))] = m
			}
		}

		respond(w, map[string]any{
			"title":          snd["title"],
			"description":    snd["description"],
			"intro":          snd["intro"],
			"thank_you":      snd["thank_you"],
			"accent_color":   snd["accent_color"],
			"department":     snd["department"],
			"signoff_name":   snd["signoff_name"],
			"signoff_title":  snd["signoff_title"],
			"recipient_name": snd["recipient_name"],
			"already_done":   alreadyDone,
			"prefill":        prefill,
			"questions":      surveyQuestionsOut(qs),
		}, "pg")
	}
}

// surveyQuestionsOut normalises question rows for the client (parses options JSON).
func surveyQuestionsOut(qs []core.Row) []map[string]any {
	out := make([]map[string]any, 0, len(qs))
	for _, q := range qs {
		var opts []any
		if s := str(q["options"]); s != "" {
			_ = json.Unmarshal([]byte(s), &opts)
		}
		out = append(out, map[string]any{
			"id":              toInt64(q["id"]),
			"position":        toInt64(q["position"]),
			"qtype":           q["qtype"],
			"label":           q["label"],
			"help_text":       q["help_text"],
			"required":        q["required"],
			"scale_min":       toInt64(q["scale_min"]),
			"scale_max":       toInt64(q["scale_max"]),
			"scale_min_label": q["scale_min_label"],
			"scale_max_label": q["scale_max_label"],
			"options":         opts,
		})
	}
	return out
}

// ── Public: submit a response ───────────────────────────────────────────────

func surveyPublicSubmit(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		token := chi.URLParam(r, "token")
		var body struct {
			Answers []struct {
				QuestionID int64    `json:"question_id"`
				Rating     *int     `json:"rating"`
				Text       string   `json:"text"`
				Choices    []string `json:"choices"`
			} `json:"answers"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}

		sends, _ := db.PGQuery(ctx, `
			SELECT ss.id, ss.survey_id, ss.customer_cif, ss.recipient_name, ss.recipient_email,
			       ss.status, ss.responded_at,
			       s.status AS survey_status, s.is_anonymous, s.title AS survey_title, s.created_by
			FROM survey_sends ss JOIN surveys s ON s.id = ss.survey_id
			WHERE ss.token = $1`, token)
		if len(sends) == 0 {
			respondErr(w, 404, "This survey link is invalid or has expired")
			return
		}
		snd := sends[0]
		if str(snd["status"]) == "responded" || snd["responded_at"] != nil {
			respondErr(w, 409, "You have already completed this survey")
			return
		}
		if str(snd["survey_status"]) == "closed" {
			respondErr(w, 410, "This survey is now closed")
			return
		}
		surveyID := toInt64(snd["survey_id"])
		sendID := toInt64(snd["id"])
		anonymous := snd["is_anonymous"] == true
		cif := str(snd["customer_cif"])
		if anonymous {
			cif = ""
		}

		// Load the questions for validation + derived scores.
		qrows, _ := db.PGQuery(ctx,
			`SELECT id, qtype, required, label, scale_min, scale_max, options::text AS options
			 FROM survey_questions WHERE survey_id=$1`, surveyID)
		qByID := map[int64]core.Row{}
		for _, q := range qrows {
			qByID[toInt64(q["id"])] = q
		}

		// Index submitted answers by question (last wins), then validate server-side —
		// required questions must be answered, ratings must be in range, choices must
		// be among the offered options. Never trust the client.
		byQ := map[int64]int{}
		for i := range body.Answers {
			byQ[body.Answers[i].QuestionID] = i
		}
		for _, q := range qrows {
			qtype := str(q["qtype"])
			if qtype == "section" {
				continue
			}
			qid := toInt64(q["id"])
			required := q["required"] == true
			label := str(q["label"])
			answered := false
			if idx, has := byQ[qid]; has {
				a := body.Answers[idx]
				switch qtype {
				case "rating", "nps":
					if a.Rating != nil {
						answered = true
						mn, mx := int(toInt64(q["scale_min"])), int(toInt64(q["scale_max"]))
						if *a.Rating < mn || *a.Rating > mx {
							respondErr(w, 422, fmt.Sprintf("Rating for \"%s\" must be between %d and %d", label, mn, mx))
							return
						}
					}
				case "single_choice", "multi_choice":
					if len(a.Choices) > 0 {
						answered = true
						var opts []string
						if os := str(q["options"]); os != "" {
							_ = json.Unmarshal([]byte(os), &opts)
						}
						allowed := map[string]bool{}
						for _, o := range opts {
							allowed[o] = true
						}
						for _, c := range a.Choices {
							if len(opts) > 0 && !allowed[c] {
								respondErr(w, 422, fmt.Sprintf("Invalid option for \"%s\"", label))
								return
							}
						}
						if qtype == "single_choice" && len(a.Choices) > 1 {
							respondErr(w, 422, fmt.Sprintf("Only one option may be selected for \"%s\"", label))
							return
						}
					}
				default: // text
					if strings.TrimSpace(a.Text) != "" {
						answered = true
					}
				}
			}
			if required && !answered {
				respondErr(w, 422, fmt.Sprintf("Please answer the required question: \"%s\"", label))
				return
			}
		}

		// Enrich contact details from the customer master for CRM matching (skipped
		// for anonymous surveys, which store no identifying fields).
		var custName, custEmail, custPhone string
		if !anonymous {
			custName = str(snd["recipient_name"])
			custEmail = str(snd["recipient_email"])
			if cif != "" {
				if cr, _ := db.PGQuery(ctx, `SELECT full_name, email, phone FROM app.customers WHERE cif=$1`, cif); len(cr) > 0 {
					if custName == "" {
						custName = str(cr[0]["full_name"])
					}
					if custEmail == "" {
						custEmail = str(cr[0]["email"])
					}
					custPhone = str(cr[0]["phone"])
				}
			}
		}

		// Derived scores: overall = mean of rating answers; nps = the nps answer.
		var ratingSum, ratingN int
		var npsScore *int
		for _, a := range body.Answers {
			q, ok := qByID[a.QuestionID]
			if !ok || a.Rating == nil {
				continue
			}
			switch str(q["qtype"]) {
			case "rating":
				ratingSum += *a.Rating
				ratingN++
			case "nps":
				v := *a.Rating
				npsScore = &v
			}
		}
		var overall any
		if ratingN > 0 {
			overall = float64(ratingSum) / float64(ratingN)
		}

		tx, err := db.PG.BeginTx(ctx, nil)
		if err != nil {
			respondErrLog(w, 500, "Could not save your response", err)
			return
		}
		defer tx.Rollback() //nolint:errcheck

		// Lock the send row so two concurrent submissions of the same link can't both
		// record a response — the second waits, then sees 'responded' and is rejected.
		var lockedStatus string
		if err := tx.QueryRowContext(ctx, `SELECT status FROM survey_sends WHERE id=$1 FOR UPDATE`, sendID).Scan(&lockedStatus); err != nil {
			respondErrLog(w, 500, "Could not save your response", err)
			return
		}
		if lockedStatus == "responded" {
			respondErr(w, 409, "You have already completed this survey")
			return
		}

		// Reuse the partial response an in-email tap may already have created for
		// this send (one response per send is enforced by uq_survey_responses_send),
		// otherwise create it. Either way the final submit is authoritative.
		var respID int64
		_ = tx.QueryRowContext(ctx, `SELECT id FROM survey_responses WHERE send_id=$1`, sendID).Scan(&respID)
		if respID == 0 {
			err = tx.QueryRowContext(ctx, `
				INSERT INTO survey_responses
				  (survey_id, send_id, customer_cif, customer_name, customer_email, customer_phone,
				   nps_score, overall_score, source, ip, user_agent, completed_at)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'page',$9,$10,NOW()) RETURNING id`,
				surveyID, sendID, cif, custName, custEmail, custPhone,
				npsScore, overall, clientIP(r), r.UserAgent()).Scan(&respID)
			if err != nil {
				respondErrLog(w, 500, "Could not save your response", err)
				return
			}
		} else {
			// Keep the original source (an 'email' partial stays 'email').
			if _, err := tx.ExecContext(ctx, `
				UPDATE survey_responses SET customer_cif=$2, customer_name=$3, customer_email=$4,
				  customer_phone=$5, nps_score=$6, overall_score=$7, ip=$8, user_agent=$9,
				  submitted_at=NOW(), completed_at=NOW()
				WHERE id=$1`,
				respID, cif, custName, custEmail, custPhone, npsScore, overall, clientIP(r), r.UserAgent()); err != nil {
				respondErrLog(w, 500, "Could not save your response", err)
				return
			}
		}

		for _, a := range body.Answers {
			if _, ok := qByID[a.QuestionID]; !ok {
				continue
			}
			choices := "[]"
			if len(a.Choices) > 0 {
				if b, e := json.Marshal(a.Choices); e == nil {
					choices = string(b)
				}
			}
			var rv any
			if a.Rating != nil {
				rv = *a.Rating
			}
			if _, err := tx.ExecContext(ctx, `
				INSERT INTO survey_answers (response_id, question_id, rating_value, text_value, choice_value)
				VALUES ($1,$2,$3,$4,$5::jsonb)
				ON CONFLICT (response_id, question_id) DO UPDATE SET
				  rating_value = EXCLUDED.rating_value,
				  text_value   = EXCLUDED.text_value,
				  choice_value = EXCLUDED.choice_value`,
				respID, a.QuestionID, rv, strings.TrimSpace(a.Text), choices); err != nil {
				respondErrLog(w, 500, "Could not save your response", err)
				return
			}
		}

		if _, err := tx.ExecContext(ctx,
			`UPDATE survey_sends SET status='responded', responded_at=NOW() WHERE id=$1`, sendID); err != nil {
			respondErrLog(w, 500, "Could not save your response", err)
			return
		}
		if err := tx.Commit(); err != nil {
			respondErrLog(w, 500, "Could not save your response", err)
			return
		}

		// Follow-up loop: a low overall score or an NPS detractor pings the survey
		// owner so dissatisfaction is acted on, not just recorded.
		go func() {
			detractor := npsScore != nil && *npsScore <= 6
			lowRating := ratingN > 0 && float64(ratingSum)/float64(ratingN) < 5
			ownerID := toInt64(snd["created_by"])
			if (!detractor && !lowRating) || ownerID == 0 {
				return
			}
			who := custName
			if who == "" {
				who = "A customer"
			}
			var parts []string
			if lowRating {
				parts = append(parts, fmt.Sprintf("%.1f/10 overall", float64(ratingSum)/float64(ratingN)))
			}
			if detractor {
				parts = append(parts, fmt.Sprintf("recommend %d/10", *npsScore))
			}
			Notify(context.Background(), db, NotifPayload{
				EventType: EvtSurveyLowScore,
				UserID:    ownerID,
				Title:     "Low feedback on " + str(snd["survey_title"]),
				Body:      fmt.Sprintf("%s left low scores (%s). Review and follow up.", who, strings.Join(parts, ", ")),
				ActionURL: fmt.Sprintf("/feedback/surveys/%d", surveyID),
				EntityRef: fmt.Sprintf("survey:%d", surveyID),
				Priority:  "high",
			})
		}()

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true}) //nolint:errcheck
	}
}

// clientIP extracts the best-guess client IP (leftmost X-Forwarded-For, else RemoteAddr).
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if i := strings.IndexByte(xff, ','); i > 0 {
			return strings.TrimSpace(xff[:i])
		}
		return strings.TrimSpace(xff)
	}
	if i := strings.LastIndexByte(r.RemoteAddr, ':'); i > 0 {
		return r.RemoteAddr[:i]
	}
	return r.RemoteAddr
}

// ── Public: in-email answer capture ─────────────────────────────────────────

// surveyInlineCapture durably records a single headline rating that the customer
// tapped in the email. The email links to the public page carrying the answer;
// the page (a real browser, so email link-scanners don't trigger it) POSTs it
// here on load. The partial answer lands on the SAME response row a later full
// submit reuses, so the headline metric survives even if the survey is never
// finished. Idempotent: re-tapping updates the same answer.
func surveyInlineCapture(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		token := chi.URLParam(r, "token")
		var body struct {
			QuestionID int64 `json:"question_id"`
			Value      *int  `json:"value"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Value == nil || body.QuestionID == 0 {
			respondErr(w, 400, "Invalid request")
			return
		}
		sends, _ := db.PGQuery(ctx, `
			SELECT ss.id, ss.survey_id, ss.customer_cif, ss.recipient_name, ss.recipient_email,
			       ss.status, ss.responded_at, s.status AS survey_status, s.is_anonymous
			FROM survey_sends ss JOIN surveys s ON s.id = ss.survey_id
			WHERE ss.token = $1`, token)
		if len(sends) == 0 {
			respondErr(w, 404, "This survey link is invalid or has expired")
			return
		}
		snd := sends[0]
		// A closed survey or an already-completed one is a silent no-op — the page
		// itself renders the right state; we simply don't record.
		if str(snd["survey_status"]) == "closed" ||
			str(snd["status"]) == "responded" || snd["responded_at"] != nil {
			respondOK(w, "noted")
			return
		}
		surveyID := toInt64(snd["survey_id"])
		sendID := toInt64(snd["id"])

		// The question must belong to this survey and be answerable inline (a scale).
		qr, _ := db.PGQuery(ctx, `SELECT qtype, scale_min, scale_max FROM survey_questions WHERE id=$1 AND survey_id=$2`, body.QuestionID, surveyID)
		if len(qr) == 0 {
			respondErr(w, 422, "Unknown question")
			return
		}
		if qt := str(qr[0]["qtype"]); qt != "rating" && qt != "nps" {
			respondErr(w, 422, "This question can't be answered from the email")
			return
		}
		mn, mx := int(toInt64(qr[0]["scale_min"])), int(toInt64(qr[0]["scale_max"]))
		if *body.Value < mn || *body.Value > mx {
			respondErr(w, 422, "Value out of range")
			return
		}
		anonymous := snd["is_anonymous"] == true

		tx, err := db.PG.BeginTx(ctx, nil)
		if err != nil {
			respondErrLog(w, 500, "Could not record your answer", err)
			return
		}
		defer tx.Rollback() //nolint:errcheck

		// Lock the send so a concurrent capture / full-submit serialises on this row.
		var lockedStatus string
		if err := tx.QueryRowContext(ctx, `SELECT status FROM survey_sends WHERE id=$1 FOR UPDATE`, sendID).Scan(&lockedStatus); err != nil {
			respondErrLog(w, 500, "Could not record your answer", err)
			return
		}
		if lockedStatus == "responded" {
			respondOK(w, "noted")
			return
		}

		var respID int64
		_ = tx.QueryRowContext(ctx, `SELECT id FROM survey_responses WHERE send_id=$1`, sendID).Scan(&respID)
		if respID == 0 {
			cif, name, email := str(snd["customer_cif"]), str(snd["recipient_name"]), str(snd["recipient_email"])
			if anonymous {
				cif, name, email = "", "", ""
			}
			if err := tx.QueryRowContext(ctx, `
				INSERT INTO survey_responses
				  (survey_id, send_id, customer_cif, customer_name, customer_email, source, ip, user_agent)
				VALUES ($1,$2,$3,$4,$5,'email',$6,$7) RETURNING id`,
				surveyID, sendID, cif, name, email, clientIP(r), r.UserAgent()).Scan(&respID); err != nil {
				respondErrLog(w, 500, "Could not record your answer", err)
				return
			}
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO survey_answers (response_id, question_id, rating_value)
			VALUES ($1,$2,$3)
			ON CONFLICT (response_id, question_id) DO UPDATE SET rating_value = EXCLUDED.rating_value`,
			respID, body.QuestionID, *body.Value); err != nil {
			respondErrLog(w, 500, "Could not record your answer", err)
			return
		}
		// Keep the derived scores in step with the stored answers.
		if _, err := tx.ExecContext(ctx, `
			UPDATE survey_responses r SET overall_score = sub.avg_rating, nps_score = sub.nps
			FROM (
			  SELECT avg(a.rating_value) FILTER (WHERE q.qtype='rating') AS avg_rating,
			         max(a.rating_value) FILTER (WHERE q.qtype='nps')    AS nps
			  FROM survey_answers a JOIN survey_questions q ON q.id = a.question_id
			  WHERE a.response_id = $1
			) sub WHERE r.id = $1`, respID); err != nil {
			respondErrLog(w, 500, "Could not record your answer", err)
			return
		}
		if _, err := tx.ExecContext(ctx,
			`UPDATE survey_sends SET status='partial', opened_at=COALESCE(opened_at, NOW()) WHERE id=$1 AND status <> 'responded'`, sendID); err != nil {
			respondErrLog(w, 500, "Could not record your answer", err)
			return
		}
		if err := tx.Commit(); err != nil {
			respondErrLog(w, 500, "Could not record your answer", err)
			return
		}
		respondOK(w, "noted")
	}
}

// ── Admin: list / CRUD ──────────────────────────────────────────────────────

func surveysList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT s.id, s.title, s.description, s.category, s.department, s.status,
			       s.accent_color, s.created_at, s.updated_at,
			       (SELECT count(*) FROM survey_questions q WHERE q.survey_id=s.id)  AS question_count,
			       (SELECT count(*) FROM survey_sends ss WHERE ss.survey_id=s.id)     AS sent_count,
			       (SELECT count(*) FROM survey_responses sr WHERE sr.survey_id=s.id) AS response_count,
			       (SELECT round(avg(overall_score)::numeric,1)::float8 FROM survey_responses sr WHERE sr.survey_id=s.id) AS avg_score
			FROM surveys s ORDER BY s.updated_at DESC`)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

func surveyCreate(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		var b struct {
			Title        string `json:"title"`
			Description  string `json:"description"`
			Category     string `json:"category"`
			Department   string `json:"department"`
			Intro        string `json:"intro"`
			ThankYou     string `json:"thank_you"`
			AccentColor  string `json:"accent_color"`
			SignoffName  string `json:"signoff_name"`
			SignoffTitle string `json:"signoff_title"`
			IsAnonymous  bool   `json:"is_anonymous"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if strings.TrimSpace(b.Title) == "" {
			respondErr(w, 422, "Title is required")
			return
		}
		if b.AccentColor == "" {
			b.AccentColor = "#C00000"
		}
		uid := int64(0)
		if u := core.UserFromCtx(ctx); u != nil {
			uid = u.ID
		}
		var id int64
		err := db.PG.QueryRowContext(ctx, `
			INSERT INTO surveys (title, description, category, department, intro, thank_you,
			                     accent_color, signoff_name, signoff_title, is_anonymous, created_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
			b.Title, b.Description, b.Category, b.Department, b.Intro, b.ThankYou,
			b.AccentColor, b.SignoffName, b.SignoffTitle, b.IsAnonymous, uid).Scan(&id)
		if err != nil {
			respondErrLog(w, 500, "Create failed", err)
			return
		}
		respond(w, map[string]any{"id": id}, "pg")
	}
}

func surveyGet(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		id := chi.URLParam(r, "id")
		srows, _ := db.PGQuery(ctx, `SELECT * FROM surveys WHERE id=$1`, id)
		if len(srows) == 0 {
			respondErr(w, 404, "Survey not found")
			return
		}
		qs, _ := db.PGQuery(ctx, `
			SELECT id, position, qtype, label, help_text, required,
			       scale_min, scale_max, scale_min_label, scale_max_label, options::text AS options
			FROM survey_questions WHERE survey_id=$1 ORDER BY position, id`, id)
		var respCount int64
		if rr, _ := db.PGQuery(ctx, `SELECT count(*) AS n FROM survey_responses WHERE survey_id=$1`, id); len(rr) > 0 {
			respCount = toInt64(rr[0]["n"])
		}
		respond(w, map[string]any{
			"survey":         srows[0],
			"questions":      surveyQuestionsOut(qs),
			"response_count": respCount,
		}, "pg")
	}
}

func surveyUpdate(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		id := chi.URLParam(r, "id")
		var b struct {
			Title        string `json:"title"`
			Description  string `json:"description"`
			Category     string `json:"category"`
			Department   string `json:"department"`
			Intro        string `json:"intro"`
			ThankYou     string `json:"thank_you"`
			AccentColor  string `json:"accent_color"`
			SignoffName  string `json:"signoff_name"`
			SignoffTitle string `json:"signoff_title"`
			IsAnonymous  bool   `json:"is_anonymous"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		_, err := db.PGExec(ctx, `
			UPDATE surveys SET title=$1, description=$2, category=$3, department=$4,
			  intro=$5, thank_you=$6, accent_color=$7, signoff_name=$8, signoff_title=$9,
			  is_anonymous=$10, updated_at=NOW()
			WHERE id=$11`,
			b.Title, b.Description, b.Category, b.Department, b.Intro, b.ThankYou,
			b.AccentColor, b.SignoffName, b.SignoffTitle, b.IsAnonymous, id)
		if err != nil {
			respondErrLog(w, 500, "Update failed", err)
			return
		}
		respondOK(w, "Survey saved")
	}
}

func surveyDelete(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		id := chi.URLParam(r, "id")
		// Never destroy collected feedback. A survey with responses can only be
		// closed (archived), not deleted, so the data and its 360 links survive.
		if rr, _ := db.PGQuery(ctx, `SELECT count(*) AS n FROM survey_responses WHERE survey_id=$1`, id); len(rr) > 0 && toInt64(rr[0]["n"]) > 0 {
			respondErr(w, 409, "This survey has responses and cannot be deleted. Close it instead to archive it.")
			return
		}
		if _, err := db.PGExec(ctx, `DELETE FROM surveys WHERE id=$1`, id); err != nil {
			respondErrLog(w, 500, "Delete failed", err)
			return
		}
		respondOK(w, "Survey deleted")
	}
}

// surveyPutQuestions replaces the full question set for a survey (builder save).
func surveyPutQuestions(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		id := chi.URLParam(r, "id")
		// Guard against data loss: survey_answers cascade-delete with their questions,
		// so replacing the question set after responses exist would wipe collected
		// answers. Lock the structure once there's data.
		if rr, _ := db.PGQuery(ctx, `SELECT count(*) AS n FROM survey_responses WHERE survey_id=$1`, id); len(rr) > 0 && toInt64(rr[0]["n"]) > 0 {
			respondErr(w, 409, "This survey already has responses — its questions can't be changed. Create a new survey to change the questions.")
			return
		}
		var b struct {
			Questions []struct {
				QType         string   `json:"qtype"`
				Label         string   `json:"label"`
				HelpText      string   `json:"help_text"`
				Required      bool     `json:"required"`
				ScaleMin      int      `json:"scale_min"`
				ScaleMax      int      `json:"scale_max"`
				ScaleMinLabel string   `json:"scale_min_label"`
				ScaleMaxLabel string   `json:"scale_max_label"`
				Options       []string `json:"options"`
			} `json:"questions"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		tx, err := db.PG.BeginTx(ctx, nil)
		if err != nil {
			respondErrLog(w, 500, "Save failed", err)
			return
		}
		defer tx.Rollback() //nolint:errcheck
		if _, err := tx.ExecContext(ctx, `DELETE FROM survey_questions WHERE survey_id=$1`, id); err != nil {
			respondErrLog(w, 500, "Save failed", err)
			return
		}
		for i, q := range b.Questions {
			smin, smax := q.ScaleMin, q.ScaleMax
			if smax == 0 {
				smin, smax = 1, 10
			}
			opts := "[]"
			if len(q.Options) > 0 {
				if bb, e := json.Marshal(q.Options); e == nil {
					opts = string(bb)
				}
			}
			if _, err := tx.ExecContext(ctx, `
				INSERT INTO survey_questions
				  (survey_id, position, qtype, label, help_text, required,
				   scale_min, scale_max, scale_min_label, scale_max_label, options)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
				id, i, q.QType, q.Label, q.HelpText, q.Required,
				smin, smax, q.ScaleMinLabel, q.ScaleMaxLabel, opts); err != nil {
				respondErrLog(w, 500, "Save failed", err)
				return
			}
		}
		if _, err := tx.ExecContext(ctx, `UPDATE surveys SET updated_at=NOW() WHERE id=$1`, id); err != nil {
			respondErrLog(w, 500, "Save failed", err)
			return
		}
		if err := tx.Commit(); err != nil {
			respondErrLog(w, 500, "Save failed", err)
			return
		}
		respondOK(w, "Questions saved")
	}
}

// surveyClone deep-copies a survey and its questions into a new draft. The main
// use: a survey's questions lock once it has responses, so to change them you
// duplicate it and edit the copy.
func surveyClone(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		id := chi.URLParam(r, "id")
		if rr, _ := db.PGQuery(ctx, `SELECT 1 FROM surveys WHERE id=$1`, id); len(rr) == 0 {
			respondErr(w, 404, "Survey not found")
			return
		}
		uid := int64(0)
		if u := core.UserFromCtx(ctx); u != nil {
			uid = u.ID
		}
		var newID int64
		err := db.PG.QueryRowContext(ctx, `
			INSERT INTO surveys (title, description, category, department, intro, thank_you,
			                     accent_color, signoff_name, signoff_title, is_anonymous, status, created_by)
			SELECT title||' (copy)', description, category, department, intro, thank_you,
			       accent_color, signoff_name, signoff_title, is_anonymous, 'draft', $2
			FROM surveys WHERE id=$1 RETURNING id`, id, uid).Scan(&newID)
		if err != nil {
			respondErrLog(w, 500, "Clone failed", err)
			return
		}
		if _, err := db.PGExec(ctx, `
			INSERT INTO survey_questions (survey_id, position, qtype, label, help_text, required,
			                             scale_min, scale_max, scale_min_label, scale_max_label, options)
			SELECT $1, position, qtype, label, help_text, required,
			       scale_min, scale_max, scale_min_label, scale_max_label, options
			FROM survey_questions WHERE survey_id=$2`, newID, id); err != nil {
			respondErrLog(w, 500, "Clone failed", err)
			return
		}
		respond(w, map[string]any{"id": newID}, "pg")
	}
}

func surveySetStatus(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var b struct {
			Status string `json:"status"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Status != "draft" && b.Status != "active" && b.Status != "closed" {
			respondErr(w, 422, "status must be draft, active or closed")
			return
		}
		if _, err := db.PGExec(r.Context(),
			`UPDATE surveys SET status=$1, updated_at=NOW() WHERE id=$2`, b.Status, id); err != nil {
			respondErrLog(w, 500, "Update failed", err)
			return
		}
		respondOK(w, "Status updated")
	}
}

// ── Admin: results & responses ──────────────────────────────────────────────

func surveyResults(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		id := chi.URLParam(r, "id")
		srows, _ := db.PGQuery(ctx, `SELECT * FROM surveys WHERE id=$1`, id)
		if len(srows) == 0 {
			respondErr(w, 404, "Survey not found")
			return
		}

		var responses, completed, partial, sent int64
		if rr, _ := db.PGQuery(ctx, `
			SELECT count(*) AS n,
			       count(*) FILTER (WHERE completed_at IS NOT NULL) AS c,
			       count(*) FILTER (WHERE completed_at IS NULL)     AS p
			FROM survey_responses WHERE survey_id=$1`, id); len(rr) > 0 {
			responses = toInt64(rr[0]["n"])
			completed = toInt64(rr[0]["c"])
			partial = toInt64(rr[0]["p"])
		}
		if rr, _ := db.PGQuery(ctx, `SELECT count(*) AS n FROM survey_sends WHERE survey_id=$1 AND status <> 'draft'`, id); len(rr) > 0 {
			sent = toInt64(rr[0]["n"])
		}

		// NPS: promoters (9-10) − detractors (0-6), over responses that answered an nps question.
		var promoters, passives, detractors, npsCount int64
		npsRows, _ := db.PGQuery(ctx, `
			SELECT CASE WHEN nps_score >= 9 THEN 'p' WHEN nps_score >= 7 THEN 'x' ELSE 'd' END AS band, count(*) AS n
			FROM survey_responses WHERE survey_id=$1 AND nps_score IS NOT NULL GROUP BY 1`, id)
		for _, row := range npsRows {
			n := toInt64(row["n"])
			npsCount += n
			switch str(row["band"]) {
			case "p":
				promoters = n
			case "x":
				passives = n
			case "d":
				detractors = n
			}
		}
		var npsScore any
		if npsCount > 0 {
			npsScore = int((float64(promoters)-float64(detractors)) / float64(npsCount) * 100.0)
		}

		var avgOverall any
		if rr, _ := db.PGQuery(ctx, `SELECT round(avg(overall_score)::numeric,2)::float8 AS a FROM survey_responses WHERE survey_id=$1`, id); len(rr) > 0 {
			avgOverall = rr[0]["a"]
		}

		// Per-question breakdown.
		qs, _ := db.PGQuery(ctx, `
			SELECT id, position, qtype, label, scale_min, scale_max, options::text AS options
			FROM survey_questions WHERE survey_id=$1 ORDER BY position, id`, id)
		questions := make([]map[string]any, 0, len(qs))
		for _, q := range qs {
			qid := toInt64(q["id"])
			qtype := str(q["qtype"])
			out := map[string]any{
				"id": qid, "qtype": qtype, "label": q["label"],
				"scale_min": toInt64(q["scale_min"]), "scale_max": toInt64(q["scale_max"]),
			}
			switch qtype {
			case "rating", "nps":
				dist, _ := db.PGQuery(ctx, `
					SELECT rating_value AS value, count(*) AS n
					FROM survey_answers WHERE question_id=$1 AND rating_value IS NOT NULL
					GROUP BY 1 ORDER BY 1`, qid)
				var sum, n int64
				for _, d := range dist {
					sum += toInt64(d["value"]) * toInt64(d["n"])
					n += toInt64(d["n"])
				}
				out["count"] = n
				if n > 0 {
					out["avg"] = float64(sum) / float64(n)
				}
				out["distribution"] = dist
			case "single_choice", "multi_choice":
				br, _ := db.PGQuery(ctx, `
					SELECT opt AS value, count(*) AS n
					FROM survey_answers a, jsonb_array_elements_text(a.choice_value) opt
					WHERE a.question_id=$1 GROUP BY 1 ORDER BY 2 DESC`, qid)
				out["breakdown"] = br
			default: // text
				tx, _ := db.PGQuery(ctx, `
					SELECT a.text_value AS text, r.customer_name, r.customer_cif, r.submitted_at
					FROM survey_answers a JOIN survey_responses r ON r.id=a.response_id
					WHERE a.question_id=$1 AND a.text_value <> ''
					ORDER BY r.submitted_at DESC LIMIT 300`, qid)
				out["answers"] = tx
				out["count"] = int64(len(tx))
			}
			questions = append(questions, out)
		}

		var rate any
		if sent > 0 {
			rate = float64(responses) / float64(sent) * 100.0
		}
		respond(w, map[string]any{
			"survey": srows[0],
			"summary": map[string]any{
				"responses":     responses,
				"completed":     completed,
				"partial":       partial,
				"sent":          sent,
				"response_rate": rate,
				"avg_overall":   avgOverall,
				"nps": map[string]any{
					"score": npsScore, "promoters": promoters, "passives": passives,
					"detractors": detractors, "count": npsCount,
				},
			},
			"questions": questions,
		}, "pg")
	}
}

func surveyResponsesList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		limit := qint(r, "limit", 100, 1, 500)
		rows, err := db.PGQuery(r.Context(), `
			SELECT id, customer_cif, customer_name, customer_email, nps_score,
			       round(overall_score::numeric,1)::float8 AS overall_score, submitted_at
			FROM survey_responses WHERE survey_id=$1 ORDER BY submitted_at DESC LIMIT $2`, id, limit)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

// surveyResponseDetail returns one response with every question and its answer —
// the drill-down behind a row in the Responses table.
func surveyResponseDetail(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		id := chi.URLParam(r, "id")
		rid := chi.URLParam(r, "rid")
		hrows, _ := db.PGQuery(ctx, `
			SELECT id, customer_cif, customer_name, customer_email, customer_phone,
			       nps_score, round(overall_score::numeric,1)::float8 AS overall_score, submitted_at
			FROM survey_responses WHERE id=$1 AND survey_id=$2`, rid, id)
		if len(hrows) == 0 {
			respondErr(w, 404, "Response not found")
			return
		}
		answers, _ := db.PGQuery(ctx, `
			SELECT q.id AS question_id, q.label, q.qtype, q.position,
			       a.rating_value, a.text_value, a.choice_value::text AS choice_value
			FROM survey_questions q
			LEFT JOIN survey_answers a ON a.question_id=q.id AND a.response_id=$1
			WHERE q.survey_id=$2 AND q.qtype <> 'section'
			ORDER BY q.position, q.id`, rid, id)
		respond(w, map[string]any{"response": hrows[0], "answers": answers}, "pg")
	}
}

// surveyExport streams all responses as a CSV — one row per response, one column
// per question. Downloaded from the results page.
func surveyExport(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		id := chi.URLParam(r, "id")
		qs, _ := db.PGQuery(ctx, `SELECT id, label FROM survey_questions WHERE survey_id=$1 AND qtype <> 'section' ORDER BY position, id`, id)
		var qids []int64
		header := []string{"response_id", "cif", "name", "email", "submitted_at", "overall_score", "recommend"}
		for _, q := range qs {
			qids = append(qids, toInt64(q["id"]))
			header = append(header, str(q["label"]))
		}
		resps, _ := db.PGQuery(ctx, `
			SELECT id, customer_cif, customer_name, customer_email, submitted_at::text AS submitted_at,
			       round(overall_score::numeric,1)::text AS overall_score, nps_score::text AS nps_score
			FROM survey_responses WHERE survey_id=$1 ORDER BY submitted_at`, id)
		ans, _ := db.PGQuery(ctx, `
			SELECT a.response_id, a.question_id, a.rating_value, a.text_value, a.choice_value::text AS cv
			FROM survey_answers a JOIN survey_responses r ON r.id=a.response_id WHERE r.survey_id=$1`, id)
		amap := map[string]string{}
		for _, a := range ans {
			key := fmt.Sprintf("%d:%d", toInt64(a["response_id"]), toInt64(a["question_id"]))
			val := ""
			if a["rating_value"] != nil {
				val = fmt.Sprintf("%d", toInt64(a["rating_value"]))
			} else if t := strings.TrimSpace(str(a["text_value"])); t != "" {
				val = t
			} else {
				val = strings.Trim(str(a["cv"]), "[]\"")
			}
			amap[key] = val
		}
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="survey_%s_responses.csv"`, id))
		cw := csv.NewWriter(w)
		_ = cw.Write(header)
		for _, rr := range resps {
			rid := toInt64(rr["id"])
			row := []string{
				fmt.Sprintf("%d", rid), str(rr["customer_cif"]), str(rr["customer_name"]),
				str(rr["customer_email"]), str(rr["submitted_at"]), str(rr["overall_score"]), str(rr["nps_score"]),
			}
			for _, qid := range qids {
				row = append(row, amap[fmt.Sprintf("%d:%d", rid, qid)])
			}
			_ = cw.Write(row)
		}
		cw.Flush()
	}
}

func surveySendsList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		rows, err := db.PGQuery(r.Context(), `
			SELECT status, count(*) AS n FROM survey_sends WHERE survey_id=$1 GROUP BY status`, id)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		recent, _ := db.PGQuery(r.Context(), `
			SELECT id, customer_cif, recipient_name, recipient_email, status,
			       created_at, sent_at, opened_at, responded_at, error_text
			FROM survey_sends WHERE survey_id=$1 ORDER BY created_at DESC LIMIT 200`, id)
		respond(w, map[string]any{"by_status": rows, "recent": recent}, "pg")
	}
}

// ── Admin: recipients & dispatch ────────────────────────────────────────────

// surveyRecipientSearch finds customers (with an email) to add as recipients.
func surveyRecipientSearch(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := qstr(r, "q")
		if len(q) < 2 {
			respond(w, []core.Row{}, "pg")
			return
		}
		like := "%" + strings.ToLower(q) + "%"
		rows, err := db.PGQuery(r.Context(), `
			SELECT cif, full_name, email, phone
			FROM app.customers
			WHERE email <> '' AND email IS NOT NULL
			  AND (lower(full_name) LIKE $1 OR cif LIKE $1 OR lower(email) LIKE $1)
			ORDER BY full_name LIMIT 25`, like)
		if err != nil {
			respondErrLog(w, 500, "Search failed", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

// surveyAddRecipients stages draft sends (a manual list and/or a customer segment).
func surveyAddRecipients(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		id := chi.URLParam(r, "id")
		var b struct {
			Recipients []struct {
				CIF   string `json:"cif"`
				Name  string `json:"name"`
				Email string `json:"email"`
			} `json:"recipients"`
			Segment string `json:"segment"` // e.g. "card_customers"
			Limit   int    `json:"limit"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		uid := int64(0)
		if u := core.UserFromCtx(ctx); u != nil {
			uid = u.ID
		}
		batch := surveyNewToken()
		added := 0

		add := func(cif, name, email string) {
			email = strings.TrimSpace(strings.ToLower(email))
			if email == "" || !strings.Contains(email, "@") {
				return
			}
			// De-dup: skip if this survey already has a non-cancelled send to this address.
			if ex, _ := db.PGQuery(ctx, `SELECT 1 FROM survey_sends WHERE survey_id=$1 AND lower(recipient_email)=$2 AND status <> 'cancelled' LIMIT 1`, id, email); len(ex) > 0 {
				return
			}
			if _, err := db.PGExec(ctx, `
				INSERT INTO survey_sends (survey_id, token, customer_cif, recipient_name, recipient_email, batch_id, created_by)
				VALUES ($1,$2,$3,$4,$5,$6,$7)`,
				id, surveyNewToken(), cif, name, email, batch, uid); err == nil {
				added++
			}
		}

		for _, rc := range b.Recipients {
			add(rc.CIF, rc.Name, rc.Email)
		}

		if b.Segment == "card_customers" {
			lim := b.Limit
			if lim <= 0 || lim > 5000 {
				lim = 500
			}
			seg, _ := db.PGQuery(ctx, `
				SELECT DISTINCT c.cif, c.full_name, c.email
				FROM app.customers c
				JOIN app.accounts a ON a.cif = c.cif
				WHERE c.email <> '' AND c.email IS NOT NULL AND c.email LIKE '%@%'
				ORDER BY c.full_name LIMIT $1`, lim)
			for _, s := range seg {
				add(str(s["cif"]), str(s["full_name"]), str(s["email"]))
			}
		}

		respond(w, map[string]any{"added": added, "batch_id": batch}, "pg")
	}
}

// surveyDispatch flips staged (draft) sends to 'queued'; the worker mails them.
// This is the deliberate send gate — nothing leaves until this is called.
func surveyDispatch(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		id := chi.URLParam(r, "id")
		if surveyBaseURL(ctx, db) == "" {
			respondErr(w, 422, "Public app base URL is not configured (settings.app_base_url) — cannot build survey links")
			return
		}
		// Don't send a survey nobody can answer.
		if rr, _ := db.PGQuery(ctx, `SELECT count(*) AS n FROM survey_questions WHERE survey_id=$1 AND qtype <> 'section'`, id); len(rr) == 0 || toInt64(rr[0]["n"]) == 0 {
			respondErr(w, 422, "Add at least one question before sending this survey")
			return
		}
		res, err := db.PGExec(ctx,
			`UPDATE survey_sends SET status='queued' WHERE survey_id=$1 AND status='draft'`, id)
		if err != nil {
			respondErrLog(w, 500, "Dispatch failed", err)
			return
		}
		n, _ := res.RowsAffected()
		// Activate the survey so its links resolve.
		db.PGExec(ctx, `UPDATE surveys SET status='active', updated_at=NOW() WHERE id=$1 AND status='draft'`, id) //nolint:errcheck
		respond(w, map[string]any{"queued": n}, "pg")
	}
}

// surveyTestSend emails a single live copy to a chosen address (safe preview).
func surveyTestSend(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		id := chi.URLParam(r, "id")
		var b struct {
			Email string `json:"email"`
			Name  string `json:"name"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		b.Email = strings.TrimSpace(b.Email)
		if !strings.Contains(b.Email, "@") {
			respondErr(w, 422, "A valid email is required")
			return
		}
		base := surveyBaseURL(ctx, db)
		if base == "" {
			respondErr(w, 422, "Public app base URL is not configured (settings.app_base_url)")
			return
		}
		srows, _ := db.PGQuery(ctx, `SELECT * FROM surveys WHERE id=$1`, id)
		if len(srows) == 0 {
			respondErr(w, 404, "Survey not found")
			return
		}
		uid := int64(0)
		if u := core.UserFromCtx(ctx); u != nil {
			uid = u.ID
		}
		// A real send row (marked as a test batch) so the link works end-to-end.
		token := surveyNewToken()
		db.PGExec(ctx, `
			INSERT INTO survey_sends (survey_id, token, recipient_name, recipient_email, batch_id, status, created_by, sent_at)
			VALUES ($1,$2,$3,$4,'test',$5,$6,NOW())`,
			id, token, b.Name, b.Email, "sent", uid) //nolint:errcheck
		res := sendSurveyEmail(ctx, db, srows[0], b.Name, b.Email, base, token, 0)
		if !res.OK {
			respondErr(w, 502, "Email send failed: "+res.Error)
			return
		}
		respondOK(w, "Test survey sent to "+b.Email)
	}
}

// ── Branded survey email ────────────────────────────────────────────────────

func sendSurveyEmail(ctx context.Context, db *core.DB, survey core.Row, name, email, base, token string, sendID int64) SendMailResult {
	if name == "" {
		name = "Valued Customer"
	}
	url := base + "/s/" + token
	title := str(survey["title"])
	intro := str(survey["intro"])
	if intro == "" {
		intro = "Your experience matters to us. Please take a few minutes to share your feedback — it directly shapes how we serve you."
	}
	accent := str(survey["accent_color"])
	if accent == "" {
		accent = "#C00000"
	}
	dept := str(survey["department"])
	signName := str(survey["signoff_name"])
	signTitle := str(survey["signoff_title"])

	// Resolve the survey id: the dispatch worker's joined row carries it as
	// survey_id (its id is the send id), whereas a plain survey row uses id.
	surveyID := toInt64(survey["id"])
	if v := toInt64(survey["survey_id"]); v != 0 {
		surveyID = v
	}

	// Embed the headline rating(s) as tappable links so the customer can answer
	// in the email; each tap is recorded the moment they land on the page.
	headline := surveyEmailHeadlineHTML(ctx, db, base, token, accent, surveyID)

	html := premiumSurveyEmailHTML(title, intro, accent, dept, name, url, signName, signTitle, headline)

	var tb strings.Builder
	tb.WriteString("Dear " + name + ",\n\n" + intro + "\n\n")
	if headline != "" {
		tb.WriteString("You can rate us right from this email — tap a number and complete the rest on the next page.\n\n")
	}
	tb.WriteString("Open the survey:\n" + url + "\n\n")
	tb.WriteString("The survey takes about three minutes and your responses are confidential.\n\n")
	if signName != "" {
		tb.WriteString("With appreciation,\n" + signName + "\n" + signTitle + "\n")
	}
	tb.WriteString("O3 Capital Nigeria Limited — You deserve more.")

	return SendMail(ctx, db, SendMailOptions{
		To:          []MailAddress{{Email: email, Name: name}},
		Subject:     title,
		HTMLBody:    html,
		TextBody:    tb.String(),
		Category:    "survey",
		Kind:        "survey",
		RelatedType: "survey_sends",
		RelatedID:   sendID,
		Attachments: []MailAttachment{brandedLogoAttachment()},
		CustomArgs:  map[string]string{"survey_id": strconv.FormatInt(surveyID, 10)},
	})
}

// premiumSurveyEmailHTML renders the survey invitation as a crafted, executive-style
// email: navy masthead + accent rule, a serif (Georgia) headline, a considered CTA,
// an executive signature, the company block and a confidentiality footer. Mirrored
// pixel-for-pixel by the frontend EmailPreview so the in-app preview is truthful.
// Built with string concatenation (not Sprintf) so literal % in CSS widths is safe.
func premiumSurveyEmailHTML(title, intro, accent, dept, name, url, signName, signTitle, headline string) string {
	e := escapeMailHTML
	eyebrow := "Customer Experience"
	if strings.TrimSpace(dept) != "" {
		eyebrow = e(dept) + " &middot; Customer Experience"
	}
	// When the headline questions are answerable in the email, the button just
	// opens the rest; otherwise it's the primary call to action.
	ctaLabel := "Begin the survey"
	ctaCaption := "Takes about three minutes &middot; Your responses are confidential"
	if strings.TrimSpace(headline) != "" {
		ctaLabel = "Open the full survey"
		ctaCaption = "Prefer to answer everything at once? Open the full survey &middot; about three minutes"
	}
	sig := ""
	if signName != "" {
		sig = `<tr><td style="padding:8px 44px 0;">` +
			`<div style="font-size:14px;color:#414a5a;font-family:Segoe UI,Arial,sans-serif;">With appreciation,</div>` +
			`<div style="font-family:Georgia,'Times New Roman',serif;font-size:17px;color:#0E2841;margin-top:8px;">` + e(signName) + `</div>` +
			`<div style="font-size:13px;color:#6e7889;font-family:Segoe UI,Arial,sans-serif;margin-top:1px;">` + e(signTitle) + `</div>` +
			`</td></tr>`
	}
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>` +
		`<body style="margin:0;padding:0;background:#EEF0F4;">` +
		`<div style="display:none;max-height:0;overflow:hidden;opacity:0;">A few minutes of your time — your feedback shapes how we serve you.</div>` +
		`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EEF0F4;padding:28px 12px;"><tr><td align="center">` +
		`<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:6px;overflow:hidden;box-shadow:0 4px 24px rgba(14,40,65,.10);">` +
		`<tr><td align="center" style="background:#0E2841;padding:30px 24px 26px;">` +
		`<img src="cid:o3logo" width="40" alt="O3 Capital" style="display:inline-block;vertical-align:middle;border:0;">` +
		`<span style="display:inline-block;vertical-align:middle;margin-left:10px;color:#ffffff;font-size:15px;font-weight:600;letter-spacing:3px;font-family:Segoe UI,Arial,sans-serif;">O3&nbsp;CAPITAL</span>` +
		`</td></tr>` +
		`<tr><td style="height:3px;background:` + accent + `;font-size:0;line-height:0;">&nbsp;</td></tr>` +
		`<tr><td style="padding:38px 44px 8px;">` +
		`<div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:700;color:` + accent + `;font-family:Segoe UI,Arial,sans-serif;">` + eyebrow + `</div>` +
		`<h1 style="font-family:Georgia,'Times New Roman',serif;font-size:26px;line-height:1.2;color:#0E2841;font-weight:normal;margin:12px 0 0;">` + e(title) + `</h1>` +
		`</td></tr>` +
		`<tr><td style="padding:20px 44px 0;font-family:Segoe UI,Arial,sans-serif;">` +
		`<p style="font-size:15px;color:#1f2635;margin:0 0 12px;font-weight:600;">Dear ` + e(name) + `,</p>` +
		`<p style="font-size:14.5px;line-height:1.75;color:#414a5a;margin:0;">` + e(intro) + `</p>` +
		`</td></tr>` +
		headline +
		`<tr><td align="center" style="padding:28px 44px 8px;">` +
		`<table role="presentation" cellpadding="0" cellspacing="0"><tr><td align="center" style="border-radius:8px;background:#0E2841;">` +
		`<a href="` + url + `" target="_blank" style="display:inline-block;padding:15px 40px;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;letter-spacing:.5px;font-family:Segoe UI,Arial,sans-serif;">` + ctaLabel + `</a>` +
		`</td></tr></table></td></tr>` +
		`<tr><td align="center" style="padding:4px 44px 0;font-family:Segoe UI,Arial,sans-serif;"><div style="font-size:12px;color:#9aa3b2;">` + ctaCaption + `</div></td></tr>` +
		`<tr><td style="padding:20px 44px 0;font-family:Segoe UI,Arial,sans-serif;"><div style="font-size:12px;color:#9aa3b2;border-top:1px solid #eef0f5;padding-top:16px;">If the button doesn't work, paste this link into your browser:<br><a href="` + url + `" style="color:` + accent + `;word-break:break-all;">` + url + `</a></div></td></tr>` +
		sig +
		`<tr><td style="padding:22px 44px 34px;font-family:Segoe UI,Arial,sans-serif;">` +
		`<div style="font-size:13px;color:#0E2841;font-weight:700;">O3 Capital Nigeria Limited</div>` +
		`<div style="font-size:12px;color:#6e7889;line-height:1.6;margin-top:3px;">7th Floor, Churchgate Tower 1, Plot 30, Churchgate Street, Victoria Island, Lagos.<br>` +
		`<a href="https://www.o3cards.com" style="color:` + accent + `;text-decoration:none;">www.o3cards.com</a> &middot; <span style="font-family:Georgia,serif;font-style:italic;color:` + accent + `;">You deserve more.</span></div>` +
		`</td></tr>` +
		`<tr><td style="padding:16px 44px;background:#F1F3F7;color:#9aa3b2;font-size:11px;line-height:1.6;font-family:Segoe UI,Arial,sans-serif;">` +
		`This message was sent from an automated address (no-reply@o3cards.com); please do not reply. It is intended for the named recipient and may contain confidential information.` +
		`</td></tr>` +
		`</table></td></tr></table></body></html>`
}

// pickHeadlineQuestions chooses the one or two scale questions worth answering
// straight from the email: the overall-satisfaction rating (by label, else the
// first rating) and the recommend/NPS question. Returns them overall-first.
func pickHeadlineQuestions(qs []core.Row) []core.Row {
	var nps, overall, firstRating core.Row
	for _, q := range qs {
		switch str(q["qtype"]) {
		case "nps":
			if nps == nil {
				nps = q
			}
		case "rating":
			if firstRating == nil {
				firstRating = q
			}
			if overall == nil && strings.Contains(strings.ToLower(str(q["label"])), "overall") {
				overall = q
			}
		}
	}
	if overall == nil {
		overall = firstRating
	}
	var out []core.Row
	if overall != nil {
		out = append(out, overall)
	}
	if nps != nil {
		out = append(out, nps)
	}
	return out
}

// surveyEmailHeadlineHTML renders the headline scale question(s) as rows of
// tappable number "chips". Each chip links to the public page carrying the
// answer (?aq=<question>&av=<value>), which records it on arrival. Returns ""
// when the survey has no scale questions, so the email falls back to a plain CTA.
func surveyEmailHeadlineHTML(ctx context.Context, db *core.DB, base, token, accent string, surveyID int64) string {
	if base == "" || token == "" {
		return ""
	}
	qs, _ := db.PGQuery(ctx, `
		SELECT id, qtype, label, scale_min, scale_max, scale_min_label, scale_max_label
		FROM survey_questions WHERE survey_id=$1 AND qtype IN ('rating','nps')
		ORDER BY position, id`, surveyID)
	picks := pickHeadlineQuestions(qs)
	if len(picks) == 0 {
		return ""
	}
	e := escapeMailHTML
	var b strings.Builder
	b.WriteString(`<tr><td style="padding:26px 44px 0;font-family:Segoe UI,Arial,sans-serif;">`)
	b.WriteString(`<div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:700;color:` + accent + `;">Answer in one tap</div>`)
	b.WriteString(`<div style="font-size:13.5px;line-height:1.6;color:#6e7889;margin-top:6px;">Rate us right here — tap a number below and it's recorded straight away, then finish the rest on the next page.</div>`)
	b.WriteString(`</td></tr>`)
	for _, q := range picks {
		qid := toInt64(q["id"])
		mn, mx := int(toInt64(q["scale_min"])), int(toInt64(q["scale_max"]))
		minL, maxL := e(str(q["scale_min_label"])), e(str(q["scale_max_label"]))
		b.WriteString(`<tr><td style="padding:18px 44px 0;font-family:Segoe UI,Arial,sans-serif;">`)
		b.WriteString(`<div style="font-size:14.5px;color:#1f2635;font-weight:600;line-height:1.5;margin-bottom:11px;">` + e(str(q["label"])) + `</div>`)
		b.WriteString(`<div style="line-height:0;">`)
		for n := mn; n <= mx; n++ {
			link := base + "/s/" + token + "?aq=" + strconv.FormatInt(qid, 10) + "&av=" + strconv.Itoa(n)
			b.WriteString(`<a href="` + link + `" target="_blank" style="display:inline-block;width:34px;height:34px;line-height:34px;text-align:center;margin:0 6px 6px 0;border:1px solid #d7dce5;border-radius:8px;color:#0E2841;text-decoration:none;font-size:14px;font-weight:600;font-family:Segoe UI,Arial,sans-serif;">` + strconv.Itoa(n) + `</a>`)
		}
		b.WriteString(`</div>`)
		if minL != "" || maxL != "" {
			b.WriteString(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:390px;margin-top:2px;"><tr>`)
			b.WriteString(`<td style="font-size:11px;color:#9aa3b2;">` + minL + `</td>`)
			b.WriteString(`<td align="right" style="font-size:11px;color:#9aa3b2;">` + maxL + `</td>`)
			b.WriteString(`</tr></table>`)
		}
		b.WriteString(`</td></tr>`)
	}
	return b.String()
}

// ── Dispatch worker ─────────────────────────────────────────────────────────

// StartSurveyDispatchWorker mails 'queued' survey sends in small batches every
// 20 seconds. Nothing is sent until an admin dispatches a survey (draft→queued).
func StartSurveyDispatchWorker(db *core.DB) {
	run := func() {
		ctx := context.Background()
		WorkerBeat(ctx, db, "survey_dispatch", "running", "", "")
		base := surveyBaseURL(ctx, db)
		if base == "" {
			WorkerBeat(ctx, db, "survey_dispatch", "ok", "idle (no app_base_url)", "")
			return
		}
		rows, err := db.PGQuery(ctx, `
			WITH claimed AS (
			  UPDATE survey_sends SET status='sending'
			  WHERE id IN (SELECT id FROM survey_sends WHERE status='queued' ORDER BY created_at LIMIT 25 FOR UPDATE SKIP LOCKED)
			  RETURNING id, token, recipient_name, recipient_email, survey_id
			)
			SELECT c.id, c.token, c.recipient_name, c.recipient_email, c.survey_id,
			       s.title, s.intro, s.accent_color, s.department, s.signoff_name, s.signoff_title
			FROM claimed c JOIN surveys s ON s.id = c.survey_id`)
		if err != nil {
			WorkerBeat(ctx, db, "survey_dispatch", "error", err.Error(), err.Error())
			return
		}
		sent := 0
		for _, row := range rows {
			sendID := toInt64(row["id"])
			res := sendSurveyEmail(ctx, db, row, str(row["recipient_name"]), str(row["recipient_email"]), base, str(row["token"]), sendID)
			if res.OK {
				db.PGExec(ctx, `UPDATE survey_sends SET status='sent', sent_at=NOW(), mail_id=$2 WHERE id=$1`, sendID, res.MailID) //nolint:errcheck
				sent++
			} else {
				db.PGExec(ctx, `UPDATE survey_sends SET status='failed', error_text=$2 WHERE id=$1`, sendID, res.Error) //nolint:errcheck
			}
		}
		WorkerBeat(ctx, db, "survey_dispatch", "ok", fmt.Sprintf("%d sent", sent), "")
	}
	run()
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		run()
	}
}

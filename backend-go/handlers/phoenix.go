package handlers

// Phoenix — credit decisioning integration.
//
// Phoenix decides; the workspace originates, reviews and reports. An application can
// start in either system:
//
//	workspace ──submit──▶ Phoenix          (POST {PHOENIX_BASE_URL}/applications)
//	workspace ◀──event─── Phoenix          (POST /api/phoenix/webhook, HMAC-signed)
//
// Phoenix owns an application once it has been submitted, so after hand-off the
// workspace mirrors the decision and status rather than re-deciding locally. The
// decision lands in the columns the origination schema already had for it
// (eye_score, eye_rating, dti_pct, bureau_summary, eye_report_id) — App Review and
// the Eye Score page are the front-end for exactly this data.
//
// CONFIGURATION — the whole integration is inert until these are set, so this ships
// safely before Phoenix is deployed:
//
//	PHOENIX_BASE_URL        e.g. http://127.0.0.1:9200/api/v1   (outbound submit)
//	PHOENIX_API_KEY         sent as Authorization: Bearer …
//	PHOENIX_WEBHOOK_SECRET  HMAC-SHA256 key for inbound events
//
// OUTBOUND PAYLOAD SHAPE: Phoenix is not deployed yet, so its request/response field
// names are not fixed. Everything Phoenix-specific is confined to phoenixSubmit and
// the two structs above it — adapting to the real API is an edit in one place, not a
// change to the queue, the worker, the webhook or the schema.

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
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

const (
	phoenixMaxAttempts = 6
	phoenixMaxBody     = 2 << 20 // 2 MiB — a decision payload is small; cap it anyway
)

func phoenixBaseURL() string { return strings.TrimRight(os.Getenv("PHOENIX_BASE_URL"), "/") }
func phoenixAPIKey() string  { return os.Getenv("PHOENIX_API_KEY") }
func phoenixSecret() string  { return os.Getenv("PHOENIX_WEBHOOK_SECRET") }

// phoenixConfigured reports whether outbound submission can work at all. When false
// the queue still fills, so nothing is lost — it drains once Phoenix is reachable.
func phoenixConfigured() bool { return phoenixBaseURL() != "" && phoenixAPIKey() != "" }

// PhoenixWebhook is the inbound event endpoint. It authenticates by HMAC signature
// over the raw body, NOT by session — Phoenix is a server, not a logged-in user — so
// main.go mounts it in the public block, alongside the other machine-to-machine
// webhooks, and never behind the JWT middleware.
func PhoenixWebhook(db *core.DB) http.HandlerFunc { return phoenixWebhook(db) }

// RegisterPhoenix mounts the operator surface. These are ordinary authenticated
// routes and belong inside the JWT group.
func RegisterPhoenix(r chi.Router, db *core.DB) {
	admin := core.RequirePages("risk_all", "risk_head")
	read := core.RequirePages("risk_all", "risk_officer", "risk_head", "credit_portfolio")

	r.With(read).Get("/status", phoenixStatus(db))
	r.With(read).Post("/applications/{id}/submit", phoenixQueueSubmit(db))
	r.With(admin).Post("/retry", phoenixRetryFailed(db))
}

// ── Outbound ─────────────────────────────────────────────────────────────────

// phoenixSubmitRequest is what we send Phoenix to ask for a decision. Field names are
// provisional pending the real Phoenix API (see the file header).
type phoenixSubmitRequest struct {
	ExternalID      string  `json:"external_id"` // our loan_applications.id
	Reference       string  `json:"reference"`
	ApplicantName   string  `json:"applicant_name"`
	ApplicantCIF    string  `json:"applicant_cif,omitempty"`
	BVN             string  `json:"bvn,omitempty"`
	Phone           string  `json:"phone,omitempty"`
	Email           string  `json:"email,omitempty"`
	Employer        string  `json:"employer,omitempty"`
	ProductType     string  `json:"product_type,omitempty"`
	AmountKobo      int64   `json:"amount_requested_kobo"`
	TenorMonths     int64   `json:"tenor_months,omitempty"`
	MonthlyIncome   int64   `json:"monthly_income_kobo,omitempty"`
	MonthlyOblig    int64   `json:"monthly_obligation_kobo,omitempty"`
	InterestRateBps int64   `json:"interest_rate_bps,omitempty"`
	SectorCode      string  `json:"sector_code,omitempty"`
	Purpose         string  `json:"purpose,omitempty"`
	CallbackURL     string  `json:"callback_url,omitempty"`
	DTIPct          float64 `json:"dti_pct,omitempty"`
}

// phoenixDecision is the decision Phoenix returns — either synchronously from a
// submit, or later via a decision.completed webhook. Both paths converge on
// phoenixApplyDecision so the two can never drift.
type phoenixDecision struct {
	PhoenixID     string          `json:"phoenix_id"`
	Decision      string          `json:"decision"` // approve | decline | refer | pending
	Score         *int            `json:"score"`
	Rating        string          `json:"rating"` // Prime | Near-Prime | Sub-Prime | High-Risk
	DTIPct        *float64        `json:"dti_pct"`
	BureauSummary string          `json:"bureau_summary"`
	ReportID      string          `json:"report_id"`
	Reasons       json.RawMessage `json:"reasons"`
	DeclineReason string          `json:"decline_reason"`
	DecidedAt     string          `json:"decided_at"`
}

// phoenixSubmit performs the HTTP call. The ONLY place that knows Phoenix's wire
// format; everything else works in terms of application ids and phoenixDecision.
func phoenixSubmit(ctx context.Context, req phoenixSubmitRequest) (*phoenixDecision, error) {
	if !phoenixConfigured() {
		return nil, fmt.Errorf("phoenix not configured")
	}
	body, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, phoenixBaseURL()+"/applications", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+phoenixAPIKey())
	// Lets Phoenix collapse a retry of the same submission instead of creating a
	// second application for it.
	httpReq.Header.Set("Idempotency-Key", "wsapp-"+req.ExternalID)

	resp, err := http.DefaultClient.Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close() //nolint:errcheck

	raw, err := io.ReadAll(io.LimitReader(resp.Body, phoenixMaxBody))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// 4xx is our fault and will never succeed on retry; the caller uses the
		// status to decide between retrying and abandoning.
		return nil, phoenixHTTPError{Status: resp.StatusCode, Body: truncate(string(raw), 500)}
	}

	var dec phoenixDecision
	if err := json.Unmarshal(raw, &dec); err != nil {
		return nil, fmt.Errorf("bad response from phoenix: %w", err)
	}
	return &dec, nil
}

type phoenixHTTPError struct {
	Status int
	Body   string
}

func (e phoenixHTTPError) Error() string { return fmt.Sprintf("phoenix http %d: %s", e.Status, e.Body) }

// permanent reports whether retrying is pointless. 4xx other than 408/429 means the
// payload itself is wrong — retrying six times just delays the operator finding out.
func (e phoenixHTTPError) permanent() bool {
	return e.Status >= 400 && e.Status < 500 && e.Status != http.StatusRequestTimeout && e.Status != http.StatusTooManyRequests
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// ── Queueing ─────────────────────────────────────────────────────────────────

// phoenixEnqueue queues an application for submission. Safe to call repeatedly: the
// partial unique index on (application_id, operation) keeps one live job.
func phoenixEnqueue(ctx context.Context, db *core.DB, appID int64) error {
	if _, err := db.PGExec(ctx, `
		INSERT INTO app.phoenix_outbox (application_id, operation, state, next_attempt_at)
		VALUES ($1, 'submit', 'queued', NOW())
		ON CONFLICT (application_id, operation) WHERE state IN ('queued','failed')
		DO UPDATE SET state='queued', next_attempt_at=NOW(), updated_at=NOW()`, appID); err != nil {
		return err
	}
	_, err := db.PGExec(ctx, `
		UPDATE app.loan_applications
		SET phoenix_sync_state='pending', phoenix_error=NULL, updated_at=NOW()
		WHERE id=$1 AND source_system='workspace'`, appID)
	return err
}

func phoenixQueueSubmit(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid application ID")
			return
		}
		rows, err := db.PGQuery(r.Context(),
			`SELECT source_system, phoenix_sync_state FROM app.loan_applications WHERE id=$1`, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Application not found")
			return
		}
		// A Phoenix-originated application is already theirs — sending it back would
		// create a duplicate over there.
		if str(rows[0]["source_system"]) == "phoenix" {
			respondErr(w, 422, "This application originated in Phoenix — it is already decisioned there")
			return
		}
		if err := phoenixEnqueue(r.Context(), db, id); err != nil {
			respondErr(w, 500, "Failed to queue submission")
			return
		}
		respond(w, map[string]any{
			"application_id": id,
			"queued":         true,
			"configured":     phoenixConfigured(),
		}, "pg")
	}
}

func phoenixRetryFailed(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		res, err := db.PGExec(r.Context(), `
			UPDATE app.phoenix_outbox
			SET state='queued', attempts=0, next_attempt_at=NOW(), updated_at=NOW()
			WHERE state IN ('failed','abandoned')`)
		if err != nil {
			respondErr(w, 500, "Retry failed")
			return
		}
		n, _ := res.RowsAffected()
		respond(w, map[string]any{"requeued": n}, "pg")
	}
}

func phoenixStatus(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		out := map[string]any{
			"configured":  phoenixConfigured(),
			"webhook_set": phoenixSecret() != "",
			"base_url_set": phoenixBaseURL() != "", // never echo the URL or key itself
		}
		if rows, _ := db.PGQuery(r.Context(), `
			SELECT
				COUNT(*) FILTER (WHERE state='queued')    AS queued,
				COUNT(*) FILTER (WHERE state='failed')    AS failed,
				COUNT(*) FILTER (WHERE state='abandoned') AS abandoned,
				COUNT(*) FILTER (WHERE state='sent')      AS sent
			FROM app.phoenix_outbox`); len(rows) > 0 {
			out["outbox"] = rows[0]
		}
		if rows, _ := db.PGQuery(r.Context(), `
			SELECT
				COUNT(*) FILTER (WHERE source_system='phoenix')      AS from_phoenix,
				COUNT(*) FILTER (WHERE source_system='workspace')    AS from_workspace,
				COUNT(*) FILTER (WHERE phoenix_sync_state='decided') AS decided,
				COUNT(*) FILTER (WHERE phoenix_sync_state='pending') AS pending,
				COUNT(*) FILTER (WHERE phoenix_sync_state='failed')  AS failed
			FROM app.loan_applications`); len(rows) > 0 {
			out["applications"] = rows[0]
		}
		if rows, _ := db.PGQuery(r.Context(), `
			SELECT COUNT(*) AS unprocessed FROM app.phoenix_events WHERE processed_at IS NULL`); len(rows) > 0 {
			out["events_unprocessed"] = rows[0]["unprocessed"]
		}
		respond(w, out, "pg")
	}
}

// ── Worker ───────────────────────────────────────────────────────────────────

// StartPhoenixOutboxWorker drains queued submissions. Runs regardless of whether
// Phoenix is configured — when it is not, it simply idles, so enabling the
// integration needs no restart beyond picking up the env.
func StartPhoenixOutboxWorker(db *core.DB) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		if !phoenixConfigured() {
			continue
		}
		ctx := context.Background()
		WorkerBeat(ctx, db, "phoenix_outbox", "running", "", "")
		sent, failed, err := phoenixDrainOutbox(ctx, db)
		switch {
		case err != nil:
			WorkerBeat(ctx, db, "phoenix_outbox", "error", err.Error(), "")
		case sent > 0 || failed > 0:
			WorkerBeat(ctx, db, "phoenix_outbox", "ok", fmt.Sprintf("%d submitted, %d failed", sent, failed), "")
		default:
			WorkerBeat(ctx, db, "phoenix_outbox", "ok", "nothing due", "")
		}
	}
}

func phoenixDrainOutbox(ctx context.Context, db *core.DB) (sent, failed int, err error) {
	jobs, err := db.PGQuery(ctx, `
		SELECT id, application_id, attempts
		FROM app.phoenix_outbox
		WHERE state IN ('queued','failed') AND next_attempt_at <= NOW()
		ORDER BY next_attempt_at
		LIMIT 25`)
	if err != nil {
		return 0, 0, err
	}
	for _, job := range jobs {
		jobID := toInt64(job["id"])
		appID := toInt64(job["application_id"])
		attempts := toInt64(job["attempts"]) + 1

		if e := phoenixSubmitOne(ctx, db, appID); e != nil {
			failed++
			perm := false
			var he phoenixHTTPError
			if ok := asPhoenixHTTPError(e, &he); ok && he.permanent() {
				perm = true
			}
			// Give up on permanent errors immediately, and after the attempt cap
			// otherwise. Backoff is 2^n minutes, capped at an hour.
			if perm || attempts >= phoenixMaxAttempts {
				db.PGExec(ctx, `UPDATE app.phoenix_outbox SET state='abandoned', attempts=$2, last_error=$3, updated_at=NOW() WHERE id=$1`, jobID, attempts, e.Error()) //nolint:errcheck
				db.PGExec(ctx, `UPDATE app.loan_applications SET phoenix_sync_state='failed', phoenix_error=$2, updated_at=NOW() WHERE id=$1`, appID, e.Error())        //nolint:errcheck
				slog.Error("phoenix submit abandoned", "application_id", appID, "attempts", attempts, "err", e)
			} else {
				backoff := time.Duration(1<<uint(attempts)) * time.Minute
				if backoff > time.Hour {
					backoff = time.Hour
				}
				db.PGExec(ctx, `UPDATE app.phoenix_outbox SET state='failed', attempts=$2, last_error=$3, next_attempt_at=NOW()+$4::interval, updated_at=NOW() WHERE id=$1`, //nolint:errcheck
					jobID, attempts, e.Error(), fmt.Sprintf("%d seconds", int(backoff.Seconds())))
			}
			continue
		}
		sent++
		db.PGExec(ctx, `UPDATE app.phoenix_outbox SET state='sent', attempts=$2, last_error=NULL, updated_at=NOW() WHERE id=$1`, jobID, attempts) //nolint:errcheck
	}
	return sent, failed, nil
}

func asPhoenixHTTPError(err error, out *phoenixHTTPError) bool {
	he, ok := err.(phoenixHTTPError)
	if ok {
		*out = he
	}
	return ok
}

// phoenixSubmitOne builds the payload from the application row, calls Phoenix, and
// applies any decision returned synchronously. If Phoenix decides asynchronously it
// returns just an id, and the decision arrives later on the webhook.
func phoenixSubmitOne(ctx context.Context, db *core.DB, appID int64) error {
	rows, err := db.PGQuery(ctx, `
		SELECT id, COALESCE(reference,'') AS reference, COALESCE(applicant_name,'') AS applicant_name,
		       COALESCE(applicant_cif, cif, '') AS applicant_cif,
		       COALESCE(applicant_phone, phone, '') AS phone,
		       COALESCE(applicant_email, email, '') AS email,
		       COALESCE(employer,'') AS employer,
		       COALESCE(product_type, loan_type, '') AS product_type,
		       COALESCE(amount_requested_kobo, loan_amount_kobo, 0) AS amount_kobo,
		       COALESCE(tenor_months, 0) AS tenor_months,
		       COALESCE(monthly_income_kobo, 0) AS monthly_income_kobo,
		       COALESCE(monthly_obligation_kobo, 0) AS monthly_obligation_kobo,
		       COALESCE(interest_rate_bps, 0) AS interest_rate_bps,
		       COALESCE(sector_code,'') AS sector_code,
		       COALESCE(purpose,'') AS purpose
		FROM app.loan_applications WHERE id=$1`, appID)
	if err != nil {
		return err
	}
	if len(rows) == 0 {
		return fmt.Errorf("application %d not found", appID)
	}
	a := rows[0]

	req := phoenixSubmitRequest{
		ExternalID:      strconv.FormatInt(appID, 10),
		Reference:       str(a["reference"]),
		ApplicantName:   str(a["applicant_name"]),
		ApplicantCIF:    str(a["applicant_cif"]),
		Phone:           str(a["phone"]),
		Email:           str(a["email"]),
		Employer:        str(a["employer"]),
		ProductType:     str(a["product_type"]),
		AmountKobo:      toInt64(a["amount_kobo"]),
		TenorMonths:     toInt64(a["tenor_months"]),
		MonthlyIncome:   toInt64(a["monthly_income_kobo"]),
		MonthlyOblig:    toInt64(a["monthly_obligation_kobo"]),
		InterestRateBps: toInt64(a["interest_rate_bps"]),
		SectorCode:      str(a["sector_code"]),
		Purpose:         str(a["purpose"]),
		CallbackURL:     strings.TrimRight(os.Getenv("PUBLIC_BASE_URL"), "/") + "/api/phoenix/webhook",
	}

	dec, err := phoenixSubmit(ctx, req)
	if err != nil {
		return err
	}

	if _, err := db.PGExec(ctx, `
		UPDATE app.loan_applications
		SET phoenix_id = COALESCE(NULLIF($2,''), phoenix_id),
		    phoenix_sync_state = 'sent',
		    phoenix_submitted_at = NOW(),
		    phoenix_synced_at = NOW(),
		    phoenix_error = NULL,
		    updated_at = NOW()
		WHERE id = $1`, appID, dec.PhoenixID); err != nil {
		return err
	}

	// Synchronous decision — apply it now. Otherwise wait for the webhook.
	if dec.Decision != "" {
		return phoenixApplyDecision(ctx, db, appID, *dec)
	}
	return nil
}

// ── Decision application ─────────────────────────────────────────────────────

// phoenixApplyDecision writes a decision onto the application. The single place a
// decision is persisted, whether it came back from submit or arrived on the webhook.
//
// It deliberately does NOT advance the LOS stage. Stage transitions are gated by role
// in los.go, and a decisioning engine recommending "approve" is not the same as a risk
// head approving it — the decision informs the human review, it does not replace it.
func phoenixApplyDecision(ctx context.Context, db *core.DB, appID int64, dec phoenixDecision) error {
	var reasons any
	if len(dec.Reasons) > 0 {
		reasons = []byte(dec.Reasons)
	}

	decidedAt := "NOW()"
	if dec.DecidedAt != "" {
		if _, err := time.Parse(time.RFC3339, dec.DecidedAt); err == nil {
			decidedAt = "$8::timestamptz"
		}
	}

	q := `
		UPDATE app.loan_applications
		SET decision        = NULLIF($2,''),
		    decision_reasons = COALESCE($3::jsonb, decision_reasons),
		    eye_score       = COALESCE($4, eye_score),
		    eye_rating      = COALESCE(NULLIF($5,''), eye_rating),
		    dti_pct         = COALESCE($6, dti_pct),
		    bureau_summary  = COALESCE(NULLIF($7,''), bureau_summary),
		    eye_report_id   = COALESCE(NULLIF($9,''), eye_report_id),
		    decline_reason  = COALESCE(NULLIF($10,''), decline_reason),
		    phoenix_sync_state = 'decided',
		    phoenix_synced_at  = NOW(),
		    decision_at     = ` + decidedAt + `,
		    updated_at      = NOW()
		WHERE id = $1`

	args := []any{appID, dec.Decision, reasons, dec.Score, dec.Rating, dec.DTIPct, dec.BureauSummary}
	if decidedAt == "$8::timestamptz" {
		args = append(args, dec.DecidedAt)
	} else {
		args = append(args, nil)
	}
	args = append(args, dec.ReportID, dec.DeclineReason)

	if _, err := db.PGExec(ctx, q, args...); err != nil {
		return err
	}

	// Tell whoever is carrying the application that a decision landed. Without this
	// a decision sits silently in the queue until someone happens to refresh.
	go func() {
		nctx := context.WithoutCancel(ctx)
		rows, err := db.PGQuery(nctx, `
			SELECT COALESCE(reference,'') AS reference,
			       COALESCE(risk_officer_id, assigned_to_user_id, assigned_to, sales_officer_id) AS owner_id
			FROM app.loan_applications WHERE id=$1`, appID)
		if err != nil || len(rows) == 0 {
			return
		}
		ownerID := toInt64(rows[0]["owner_id"])
		if ownerID == 0 {
			return
		}
		verdict := strings.ToUpper(dec.Decision)
		priority := "normal"
		switch strings.ToLower(dec.Decision) {
		case "decline", "refer":
			priority = "high"
		}
		NotifyUsers(nctx, db, []int64{ownerID}, NotifPayload{
			EventType: "loan_decision_received",
			Title:     fmt.Sprintf("Decision: %s", verdict),
			Body:      fmt.Sprintf("Phoenix returned %s for application %s.", verdict, str(rows[0]["reference"])),
			ActionURL: fmt.Sprintf("/operations/risk/applications/%d", appID),
			EntityRef: fmt.Sprintf("loan_application:%d", appID),
			Priority:  priority,
		})
	}()
	return nil
}

// ── Inbound webhook ──────────────────────────────────────────────────────────

type phoenixEvent struct {
	EventID   string          `json:"event_id"`
	EventType string          `json:"event_type"` // application.created | application.updated | decision.completed
	PhoenixID string          `json:"phoenix_id"`
	Data      json.RawMessage `json:"data"`
}

// phoenixApplication is a Phoenix-originated application as pushed to us.
type phoenixApplication struct {
	PhoenixID     string   `json:"phoenix_id"`
	Reference     string   `json:"reference"`
	ApplicantName string   `json:"applicant_name"`
	ApplicantCIF  string   `json:"applicant_cif"`
	Phone         string   `json:"phone"`
	Email         string   `json:"email"`
	Employer      string   `json:"employer"`
	ProductType   string   `json:"product_type"`
	AmountKobo    int64    `json:"amount_requested_kobo"`
	TenorMonths   int64    `json:"tenor_months"`
	MonthlyIncome int64    `json:"monthly_income_kobo"`
	SectorCode    string   `json:"sector_code"`
	Purpose       string   `json:"purpose"`
	Status        string   `json:"status"`
	Stage         string   `json:"stage"`
	SubmittedAt   string   `json:"submitted_at"`
	Decision      *phoenixDecision `json:"decision"`
}

func phoenixWebhook(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		secret := phoenixSecret()
		if secret == "" {
			// Refuse rather than accept unauthenticated writes to the risk queue.
			respondErr(w, 503, "Phoenix webhook not configured")
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, phoenixMaxBody))
		if err != nil {
			respondErr(w, 400, "Unreadable body")
			return
		}
		if !phoenixVerifySignature(secret, r.Header.Get("X-Phoenix-Signature"), body) {
			respondErr(w, 401, "Bad signature")
			return
		}

		var ev phoenixEvent
		if err := json.Unmarshal(body, &ev); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if ev.EventID == "" || ev.EventType == "" {
			respondErr(w, 422, "event_id and event_type are required")
			return
		}

		ctx := r.Context()

		// Idempotency: claim the event id first. A redelivery finds the row already
		// present, inserts nothing, and is acknowledged without being reprocessed —
		// so a replayed decision cannot overwrite a newer one.
		res, err := db.PGExec(ctx, `
			INSERT INTO app.phoenix_events (event_id, event_type, phoenix_id, payload)
			VALUES ($1,$2,NULLIF($3,''),$4::jsonb)
			ON CONFLICT (event_id) DO NOTHING`, ev.EventID, ev.EventType, ev.PhoenixID, string(body))
		if err != nil {
			respondErr(w, 500, "Failed to record event")
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			respond(w, map[string]any{"ok": true, "duplicate": true}, "phoenix")
			return
		}

		appID, procErr := phoenixProcessEvent(ctx, db, ev)
		if procErr != nil {
			db.PGExec(ctx, `UPDATE app.phoenix_events SET error=$2 WHERE event_id=$1`, ev.EventID, procErr.Error()) //nolint:errcheck
			slog.Error("phoenix event failed", "event_id", ev.EventID, "type", ev.EventType, "err", procErr)
			// 500 so Phoenix retries; the ledger row keeps the error for diagnosis and
			// is cleared by the retry that succeeds.
			db.PGExec(ctx, `DELETE FROM app.phoenix_events WHERE event_id=$1 AND processed_at IS NULL`, ev.EventID) //nolint:errcheck
			respondErr(w, 500, "Failed to process event")
			return
		}
		db.PGExec(ctx, `UPDATE app.phoenix_events SET processed_at=NOW(), application_id=$2, error=NULL WHERE event_id=$1`, ev.EventID, appID) //nolint:errcheck
		respond(w, map[string]any{"ok": true, "application_id": appID}, "phoenix")
	}
}

func phoenixProcessEvent(ctx context.Context, db *core.DB, ev phoenixEvent) (int64, error) {
	switch ev.EventType {
	case "application.created", "application.updated":
		var pa phoenixApplication
		if err := json.Unmarshal(ev.Data, &pa); err != nil {
			return 0, fmt.Errorf("bad application payload: %w", err)
		}
		if pa.PhoenixID == "" {
			pa.PhoenixID = ev.PhoenixID
		}
		if pa.PhoenixID == "" {
			return 0, fmt.Errorf("phoenix_id is required")
		}
		appID, err := phoenixUpsertApplication(ctx, db, pa)
		if err != nil {
			return 0, err
		}
		if pa.Decision != nil && pa.Decision.Decision != "" {
			if err := phoenixApplyDecision(ctx, db, appID, *pa.Decision); err != nil {
				return appID, err
			}
		}
		return appID, nil

	case "decision.completed":
		var dec phoenixDecision
		if err := json.Unmarshal(ev.Data, &dec); err != nil {
			return 0, fmt.Errorf("bad decision payload: %w", err)
		}
		if dec.PhoenixID == "" {
			dec.PhoenixID = ev.PhoenixID
		}
		rows, err := db.PGQuery(ctx,
			`SELECT id FROM app.loan_applications WHERE phoenix_id=$1`, dec.PhoenixID)
		if err != nil {
			return 0, err
		}
		if len(rows) == 0 {
			// A decision for an application we have never seen. Phoenix should have
			// sent application.created first; report it rather than silently dropping
			// a decision on the floor.
			return 0, fmt.Errorf("no application for phoenix_id %s", dec.PhoenixID)
		}
		appID := toInt64(rows[0]["id"])
		return appID, phoenixApplyDecision(ctx, db, appID, dec)
	}
	return 0, fmt.Errorf("unknown event_type %q", ev.EventType)
}

// phoenixUpsertApplication mirrors a Phoenix-originated application into the risk
// queue. Keyed on phoenix_id so repeated updates converge on one row.
//
// COALESCE on every field: an "updated" event may carry only what changed, and a
// partial payload must not blank out data we already hold.
func phoenixUpsertApplication(ctx context.Context, db *core.DB, pa phoenixApplication) (int64, error) {
	ref := pa.Reference
	if ref == "" {
		ref = "PHX-" + pa.PhoenixID
	}
	status := strings.ToLower(pa.Status)
	if status == "" {
		status = "submitted"
	}
	stage := pa.Stage
	if stage == "" {
		stage = "risk_review"
	}

	rows, err := db.PGQuery(ctx, `
		INSERT INTO app.loan_applications (
			source_system, phoenix_id, reference, applicant_name, applicant_cif,
			applicant_phone, applicant_email, employer, product_type,
			amount_requested_kobo, tenor_months, monthly_income_kobo,
			sector_code, purpose, status, stage,
			submitted_at, phoenix_sync_state, phoenix_synced_at, created_at, updated_at
		) VALUES (
			'phoenix', $1, $2, $3, NULLIF($4,''),
			NULLIF($5,''), NULLIF($6,''), NULLIF($7,''),
			-- product_type, amount_requested_kobo and tenor_months are NOT NULL on this
			-- table with no default, so an insert MUST supply them. A Phoenix payload
			-- that omits product_type would otherwise blow up on the constraint.
			COALESCE(NULLIF($8,''), 'Unspecified'),
			COALESCE($9, 0), COALESCE($10, 0), NULLIF($11,0),
			NULLIF($12,''), NULLIF($13,''), $14, $15,
			COALESCE($16::timestamptz, NOW()), 'not_required', NOW(), NOW(), NOW()
		)
		-- The predicate is REQUIRED: idx_loan_applications_phoenix_id is a PARTIAL
		-- unique index (WHERE phoenix_id IS NOT NULL), and Postgres will not infer a
		-- partial index unless the ON CONFLICT clause repeats its predicate. Without
		-- it this fails at runtime with "no unique or exclusion constraint matching
		-- the ON CONFLICT specification".
		--
		-- The update clause reads the PARAMETERS ($n) rather than EXCLUDED for the
		-- NOT-NULL columns. EXCLUDED already carries the insert-time fallbacks above,
		-- so using it here would let a partial "updated" event overwrite a real
		-- product type with 'Unspecified', or a real tenor with 0.
		ON CONFLICT (phoenix_id) WHERE phoenix_id IS NOT NULL DO UPDATE SET
			reference             = COALESCE(NULLIF($2,''),  app.loan_applications.reference),
			applicant_name        = COALESCE(NULLIF($3,''),  app.loan_applications.applicant_name),
			applicant_cif         = COALESCE(NULLIF($4,''),  app.loan_applications.applicant_cif),
			applicant_phone       = COALESCE(NULLIF($5,''),  app.loan_applications.applicant_phone),
			applicant_email       = COALESCE(NULLIF($6,''),  app.loan_applications.applicant_email),
			employer              = COALESCE(NULLIF($7,''),  app.loan_applications.employer),
			product_type          = COALESCE(NULLIF($8,''),  app.loan_applications.product_type),
			amount_requested_kobo = COALESCE(NULLIF($9,0),   app.loan_applications.amount_requested_kobo),
			tenor_months          = COALESCE(NULLIF($10,0),  app.loan_applications.tenor_months),
			monthly_income_kobo   = COALESCE(NULLIF($11,0),  app.loan_applications.monthly_income_kobo),
			sector_code           = COALESCE(NULLIF($12,''), app.loan_applications.sector_code),
			purpose               = COALESCE(NULLIF($13,''), app.loan_applications.purpose),
			status                = COALESCE(NULLIF($14,''), app.loan_applications.status),
			stage                 = COALESCE(NULLIF($15,''), app.loan_applications.stage),
			phoenix_synced_at     = NOW(),
			updated_at            = NOW()
		RETURNING id, (xmax = 0) AS inserted`,
		pa.PhoenixID, ref, pa.ApplicantName, pa.ApplicantCIF,
		pa.Phone, pa.Email, pa.Employer, pa.ProductType,
		pa.AmountKobo, pa.TenorMonths, pa.MonthlyIncome,
		pa.SectorCode, pa.Purpose, status, stage,
		nullIfEmpty(pa.SubmittedAt))
	if err != nil {
		return 0, err
	}
	if len(rows) == 0 {
		return 0, fmt.Errorf("upsert returned no row")
	}
	appID := toInt64(rows[0]["id"])

	// Announce genuinely new applications only — an "updated" event for a row we
	// already hold must not re-alert the risk desk.
	if inserted, _ := rows[0]["inserted"].(bool); inserted {
		go func() {
			nctx := context.WithoutCancel(ctx)
			NotifyRoles(nctx, db, []string{"risk_officer", "risk_head"}, NotifPayload{
				EventType: "loan_application_received",
				Title:     "New application from Phoenix",
				Body:      fmt.Sprintf("%s — %s", ref, pa.ApplicantName),
				ActionURL: fmt.Sprintf("/operations/risk/applications/%d", appID),
				EntityRef: fmt.Sprintf("loan_application:%d", appID),
				// Grouped: a Phoenix batch push must not fire one bell per application.
				GroupKey: "phoenix_new_applications",
			})
		}()
	}
	return appID, nil
}

// phoenixVerifySignature checks the HMAC-SHA256 of the raw body. Hex or base64-less
// hex with an optional "sha256=" prefix, compared in constant time.
func phoenixVerifySignature(secret, header string, body []byte) bool {
	if header == "" {
		return false
	}
	sig := strings.TrimPrefix(strings.TrimSpace(header), "sha256=")
	want := hmac.New(sha256.New, []byte(secret))
	want.Write(body)
	expected := hex.EncodeToString(want.Sum(nil))
	return subtle.ConstantTimeCompare([]byte(strings.ToLower(sig)), []byte(expected)) == 1
}

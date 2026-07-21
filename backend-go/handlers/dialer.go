package handlers

// Native predictive dialer — campaign management, agent sessions, and auto-dial engine.
//
// The engine goroutine runs every 5 seconds per active campaign:
//   - counts ready agents in dialer_sessions
//   - counts in-flight calls (dialing/ringing, started < 2 min ago)
//   - fires ceil(available_agents × dial_ratio) - in_flight new calls via Zoho Voice
//   - throttles automatically when abandonment rate approaches the CBN 3% cap
//
// Call state is updated by:
//   - POST /api/dialer/webhook  — Zoho Voice webhook (call answered, ended, etc.)
//   - Stale-call cleanup (every 60s): marks "dialing" calls older than 90s as abandoned
//
// All amounts are in kobo; no float money here.

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// dialerEngine is the singleton engine — one instance per process.
var dialerEngine struct {
	once sync.Once
}

// RegisterDialerWebhookOnly returns the unauthenticated Zoho Voice webhook handler.
// Registered separately in main.go before the auth middleware group.
func RegisterDialerWebhookOnly(db *core.DB) http.HandlerFunc {
	ensureDialerSchema(context.Background(), db)
	return dlZohoWebhook(db)
}

// RegisterDialer wires all authenticated dialer routes and starts the engine goroutine once.
func RegisterDialer(r chi.Router, db *core.DB) {
	ensureDialerSchema(context.Background(), db)

	// Campaign CRUD
	r.Get("/campaigns", dlListCampaigns(db))
	r.Post("/campaigns", dlCreateCampaign(db))
	r.Get("/campaigns/{id}", dlGetCampaign(db))
	r.Put("/campaigns/{id}", dlUpdateCampaign(db))
	r.Delete("/campaigns/{id}", dlDeleteCampaign(db))

	// Campaign lifecycle
	r.Post("/campaigns/{id}/start", dlStartCampaign(db))
	r.Post("/campaigns/{id}/pause", dlPauseCampaign(db))
	r.Post("/campaigns/{id}/stop", dlStopCampaign(db))

	// Contact upload (CSV body or JSON array)
	r.Post("/campaigns/{id}/contacts", dlUploadContacts(db))

	// Live stats (polled by supervisor page)
	r.Get("/campaigns/{id}/stats", dlCampaignStats(db))
	r.Get("/campaigns/{id}/queue", dlCampaignQueue(db))
	r.Get("/live", dlLiveStats(db))

	// Agent session
	r.Post("/sessions", dlJoinSession(db))
	r.Delete("/sessions", dlLeaveSession(db))
	r.Put("/sessions/status", dlSetSessionStatus(db))
	r.Get("/sessions/me", dlMySession(db))
	r.Get("/sessions/me/next-contact", dlNextContact(db))

	// Agent-triggered call (preview/progressive mode)
	r.Post("/calls/manual", dlManualCall(db))

	// Call disposition (agent sets after call ends)
	r.Post("/calls/{id}/disposition", dlSetDisposition(db))

	// Start engine
	dialerEngine.once.Do(func() {
		go runDialerEngine(db)
	})
}

// ── Schema ────────────────────────────────────────────────────────────────────

func ensureDialerSchema(ctx context.Context, db *core.DB) {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS dialer_campaigns (
			id                  BIGSERIAL PRIMARY KEY,
			name                TEXT NOT NULL,
			description         TEXT,
			status              TEXT NOT NULL DEFAULT 'draft',
			dial_ratio          NUMERIC(3,1) NOT NULL DEFAULT 1.5,
			max_abandonment_pct NUMERIC(4,1) NOT NULL DEFAULT 3.0,
			caller_id           TEXT,
			max_attempts        INT NOT NULL DEFAULT 3,
			retry_delay_minutes INT NOT NULL DEFAULT 60,
			schedule_start      TIME,
			schedule_end        TIME,
			created_by          BIGINT,
			created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS dialer_queue (
			id              BIGSERIAL PRIMARY KEY,
			campaign_id     BIGINT NOT NULL REFERENCES dialer_campaigns(id) ON DELETE CASCADE,
			phone           TEXT NOT NULL,
			customer_name   TEXT,
			cif             TEXT,
			metadata        JSONB NOT NULL DEFAULT '{}',
			priority        INT NOT NULL DEFAULT 5,
			attempts        INT NOT NULL DEFAULT 0,
			status          TEXT NOT NULL DEFAULT 'pending',
			last_attempt_at TIMESTAMPTZ,
			next_attempt_at TIMESTAMPTZ,
			created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_dialer_queue_campaign ON dialer_queue(campaign_id, status, priority, next_attempt_at)`,
		`CREATE TABLE IF NOT EXISTS dialer_sessions (
			id             BIGSERIAL PRIMARY KEY,
			campaign_id    BIGINT REFERENCES dialer_campaigns(id) ON DELETE SET NULL,
			agent_user_id  BIGINT NOT NULL,
			agent_name     TEXT,
			status         TEXT NOT NULL DEFAULT 'ready',
			calls_made     INT NOT NULL DEFAULT 0,
			calls_answered INT NOT NULL DEFAULT 0,
			joined_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_dialer_sessions_agent ON dialer_sessions(agent_user_id, status)`,
		`CREATE TABLE IF NOT EXISTS dialer_call_logs (
			id             BIGSERIAL PRIMARY KEY,
			campaign_id    BIGINT NOT NULL REFERENCES dialer_campaigns(id),
			queue_entry_id BIGINT REFERENCES dialer_queue(id) ON DELETE SET NULL,
			agent_user_id  BIGINT,
			agent_name     TEXT,
			phone          TEXT NOT NULL,
			call_state     TEXT NOT NULL DEFAULT 'dialing',
			zoho_call_id   TEXT,
			started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			answered_at    TIMESTAMPTZ,
			ended_at       TIMESTAMPTZ,
			duration_sec   INT NOT NULL DEFAULT 0,
			disposition    TEXT,
			notes          TEXT,
			is_abandoned   BOOL NOT NULL DEFAULT false,
			created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_dialer_call_logs_campaign ON dialer_call_logs(campaign_id, created_at DESC)`,
	}
	for _, s := range stmts {
		db.PGExec(ctx, s) //nolint:errcheck
	}
}

// ── Campaign CRUD ─────────────────────────────────────────────────────────────

func dlListCampaigns(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		from := r.URL.Query().Get("from")
		to   := r.URL.Query().Get("to")

		q := `SELECT id, name, description, status, dial_ratio, max_abandonment_pct,
			        caller_id, max_attempts, retry_delay_minutes,
			        schedule_start, schedule_end, created_by, created_at, updated_at
			 FROM dialer_campaigns WHERE 1=1`
		var args []any
		if from != "" {
			args = append(args, from)
			q += " AND created_at::date >= $" + itoa(len(args)) + "::date"
		}
		if to != "" {
			args = append(args, to)
			q += " AND created_at::date <= $" + itoa(len(args)) + "::date"
		}
		q += " ORDER BY created_at DESC"
		rows, err := db.PGQuery(r.Context(), q, args...)
		if err != nil {
			respondErr(w, 500, err.Error())
			return
		}
		respond(w, rows, "campaigns")
	}
}

func dlGetCampaign(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		rows, err := db.PGQuery(r.Context(),
			`SELECT id, name, description, status, dial_ratio, max_abandonment_pct,
			        caller_id, max_attempts, retry_delay_minutes,
			        schedule_start, schedule_end, created_by, created_at, updated_at
			 FROM dialer_campaigns WHERE id=$1`, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "campaign not found")
			return
		}
		respond(w, rows[0], "campaign")
	}
}

func dlCreateCampaign(db *core.DB) http.HandlerFunc {
	type body struct {
		Name               string  `json:"name"`
		Description        string  `json:"description"`
		DialRatio          float64 `json:"dial_ratio"`
		MaxAbandonmentPct  float64 `json:"max_abandonment_pct"`
		CallerID           string  `json:"caller_id"`
		MaxAttempts        int     `json:"max_attempts"`
		RetryDelayMinutes  int     `json:"retry_delay_minutes"`
		ScheduleStart      string  `json:"schedule_start"`
		ScheduleEnd        string  `json:"schedule_end"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "invalid JSON")
			return
		}
		if strings.TrimSpace(b.Name) == "" {
			respondErr(w, 422, "name is required")
			return
		}
		if b.DialRatio <= 0 {
			b.DialRatio = 1.5
		}
		if b.MaxAbandonmentPct <= 0 {
			b.MaxAbandonmentPct = 3.0
		}
		if b.MaxAttempts <= 0 {
			b.MaxAttempts = 3
		}
		if b.RetryDelayMinutes <= 0 {
			b.RetryDelayMinutes = 60
		}

		user := core.UserFromCtx(r.Context())
		var createdBy *int64
		if user != nil {
			createdBy = &user.ID
		}

		rows, err := db.PGQuery(r.Context(),
			`INSERT INTO dialer_campaigns
				(name, description, dial_ratio, max_abandonment_pct, caller_id,
				 max_attempts, retry_delay_minutes, schedule_start, schedule_end, created_by)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,
			         NULLIF($8,'')::TIME, NULLIF($9,'')::TIME, $10)
			 RETURNING id, name, status, created_at`,
			b.Name, b.Description, b.DialRatio, b.MaxAbandonmentPct, b.CallerID,
			b.MaxAttempts, b.RetryDelayMinutes, b.ScheduleStart, b.ScheduleEnd, createdBy)
		if err != nil {
			respondErr(w, 500, err.Error())
			return
		}
		w.WriteHeader(201)
		respond(w, rows[0], "campaign")
	}
}

func dlUpdateCampaign(db *core.DB) http.HandlerFunc {
	type body struct {
		Name               string  `json:"name"`
		Description        string  `json:"description"`
		DialRatio          float64 `json:"dial_ratio"`
		MaxAbandonmentPct  float64 `json:"max_abandonment_pct"`
		CallerID           string  `json:"caller_id"`
		MaxAttempts        int     `json:"max_attempts"`
		RetryDelayMinutes  int     `json:"retry_delay_minutes"`
		ScheduleStart      string  `json:"schedule_start"`
		ScheduleEnd        string  `json:"schedule_end"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "invalid JSON")
			return
		}
		_, err := db.PGExec(r.Context(),
			`UPDATE dialer_campaigns
			 SET name=$1, description=$2, dial_ratio=$3, max_abandonment_pct=$4,
			     caller_id=$5, max_attempts=$6, retry_delay_minutes=$7,
			     schedule_start=NULLIF($8,'')::TIME, schedule_end=NULLIF($9,'')::TIME,
			     updated_at=NOW()
			 WHERE id=$10`,
			b.Name, b.Description, b.DialRatio, b.MaxAbandonmentPct, b.CallerID,
			b.MaxAttempts, b.RetryDelayMinutes, b.ScheduleStart, b.ScheduleEnd, id)
		if err != nil {
			respondErr(w, 500, err.Error())
			return
		}
		w.WriteHeader(204)
	}
}

func dlDeleteCampaign(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		db.PGExec(r.Context(), `DELETE FROM dialer_campaigns WHERE id=$1`, id) //nolint:errcheck
		w.WriteHeader(204)
	}
}

// ── Campaign lifecycle ────────────────────────────────────────────────────────

func dlStartCampaign(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		_, err := db.PGExec(r.Context(),
			`UPDATE dialer_campaigns SET status='active', updated_at=NOW() WHERE id=$1 AND status IN ('draft','paused')`, id)
		if err != nil {
			respondErr(w, 500, err.Error())
			return
		}
		w.WriteHeader(204)
	}
}

func dlPauseCampaign(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		db.PGExec(r.Context(), `UPDATE dialer_campaigns SET status='paused', updated_at=NOW() WHERE id=$1`, id) //nolint:errcheck
		w.WriteHeader(204)
	}
}

func dlStopCampaign(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		db.PGExec(r.Context(), `UPDATE dialer_campaigns SET status='completed', updated_at=NOW() WHERE id=$1`, id) //nolint:errcheck
		w.WriteHeader(204)
	}
}

// ── Contact upload ────────────────────────────────────────────────────────────

// dlUploadContacts accepts either a JSON array [{phone,customer_name,cif,priority}]
// or a CSV file (Content-Type: text/csv) with headers phone,customer_name,cif,priority.
func dlUploadContacts(db *core.DB) http.HandlerFunc {
	type contact struct {
		Phone        string `json:"phone"`
		CustomerName string `json:"customer_name"`
		CIF          string `json:"cif"`
		Priority     int    `json:"priority"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		ct := r.Header.Get("Content-Type")

		var contacts []contact

		if strings.HasPrefix(ct, "text/csv") || strings.HasPrefix(ct, "multipart/form-data") {
			var csvReader *csv.Reader
			if strings.HasPrefix(ct, "multipart/form-data") {
				r.ParseMultipartForm(10 << 20) //nolint:errcheck
				f, _, err := r.FormFile("file")
				if err != nil {
					respondErr(w, 400, "expected file field 'file'")
					return
				}
				defer f.Close()
				csvReader = csv.NewReader(f)
			} else {
				csvReader = csv.NewReader(r.Body)
			}
			records, err := csvReader.ReadAll()
			if err != nil || len(records) < 2 {
				respondErr(w, 400, "invalid CSV")
				return
			}
			hdr := records[0]
			colIdx := map[string]int{}
			for i, h := range hdr {
				colIdx[strings.TrimSpace(strings.ToLower(h))] = i
			}
			phoneCol, ok := colIdx["phone"]
			if !ok {
				respondErr(w, 400, "CSV must have a 'phone' column")
				return
			}
			for _, rec := range records[1:] {
				if len(rec) <= phoneCol {
					continue
				}
				c := contact{Phone: strings.TrimSpace(rec[phoneCol]), Priority: 5}
				if i, ok := colIdx["customer_name"]; ok && i < len(rec) {
					c.CustomerName = strings.TrimSpace(rec[i])
				}
				if i, ok := colIdx["cif"]; ok && i < len(rec) {
					c.CIF = strings.TrimSpace(rec[i])
				}
				if c.Phone != "" {
					contacts = append(contacts, c)
				}
			}
		} else {
			if err := json.NewDecoder(r.Body).Decode(&contacts); err != nil {
				respondErr(w, 400, "invalid JSON array")
				return
			}
		}

		if len(contacts) == 0 {
			respondErr(w, 422, "no contacts provided")
			return
		}

		inserted := 0
		for _, c := range contacts {
			if c.Phone == "" {
				continue
			}
			if c.Priority <= 0 {
				c.Priority = 5
			}
			_, err := db.PGExec(r.Context(),
				`INSERT INTO dialer_queue (campaign_id, phone, customer_name, cif, priority)
				 VALUES ($1,$2,$3,$4,$5)
				 ON CONFLICT DO NOTHING`,
				id, c.Phone, c.CustomerName, c.CIF, c.Priority)
			if err == nil {
				inserted++
			}
		}
		respond(w, map[string]any{"inserted": inserted, "total": len(contacts)}, "upload")
	}
}

// ── Stats ─────────────────────────────────────────────────────────────────────

func dlCampaignStats(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		ctx := r.Context()

		queueStats, _ := db.PGQuery(ctx,
			`SELECT status, COUNT(*) AS cnt FROM dialer_queue
			 WHERE campaign_id=$1 GROUP BY status`, id)

		callStats, _ := db.PGQuery(ctx,
			`SELECT
			   COUNT(*) FILTER (WHERE call_state = 'answered') AS answered,
			   COUNT(*) FILTER (WHERE is_abandoned) AS abandoned,
			   COUNT(*) AS total,
			   COALESCE(AVG(duration_sec) FILTER (WHERE call_state='answered'),0) AS avg_duration_sec
			 FROM dialer_call_logs WHERE campaign_id=$1`, id)

		sessionStats, _ := db.PGQuery(ctx,
			`SELECT status, COUNT(*) AS cnt FROM dialer_sessions
			 WHERE campaign_id=$1 GROUP BY status`, id)

		var abandonPct float64
		if len(callStats) > 0 {
			total := numVal(callStats[0]["total"])
			abandoned := numVal(callStats[0]["abandoned"])
			if total > 0 {
				abandonPct = math.Round((abandoned/total)*1000) / 10
			}
		}

		respond(w, map[string]any{
			"queue":        queueStats,
			"calls":        callStats,
			"sessions":     sessionStats,
			"abandon_pct":  abandonPct,
			"cbn_limit_pct": 3.0,
		}, "stats")
	}
}

func numVal(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case int64:
		return float64(x)
	case int:
		return float64(x)
	}
	return 0
}

func dlCampaignQueue(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		page := 1
		if p := r.URL.Query().Get("page"); p != "" {
			fmt.Sscanf(p, "%d", &page)
		}
		if page < 1 {
			page = 1
		}
		offset := (page - 1) * 50
		rows, err := db.PGQuery(r.Context(),
			`SELECT id, phone, customer_name, cif, priority, status, attempts, last_attempt_at, created_at
			 FROM dialer_queue WHERE campaign_id=$1
			 ORDER BY priority ASC, created_at ASC LIMIT 50 OFFSET $2`, id, offset)
		if err != nil {
			respondErr(w, 500, err.Error())
			return
		}
		respond(w, rows, "queue")
	}
}

func dlLiveStats(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		campaigns, _ := db.PGQuery(ctx,
			`SELECT c.id, c.name, c.status, c.dial_ratio,
			   (SELECT COUNT(*) FROM dialer_sessions s WHERE s.campaign_id=c.id AND s.status='ready') AS agents_ready,
			   (SELECT COUNT(*) FROM dialer_sessions s WHERE s.campaign_id=c.id AND s.status='on_call') AS agents_on_call,
			   (SELECT COUNT(*) FROM dialer_call_logs l WHERE l.campaign_id=c.id AND l.call_state IN ('dialing','ringing')
			     AND l.started_at > NOW()-INTERVAL '2 minutes') AS calls_in_flight,
			   (SELECT COUNT(*) FROM dialer_queue q WHERE q.campaign_id=c.id AND q.status='pending') AS queue_pending
			 FROM dialer_campaigns c WHERE c.status='active'`)

		respond(w, campaigns, "live")
	}
}

// ── Agent session ─────────────────────────────────────────────────────────────

func dlJoinSession(db *core.DB) http.HandlerFunc {
	type body struct {
		CampaignID int64 `json:"campaign_id"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, 401, "unauthorized")
			return
		}
		var b body
		json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck

		// End any existing live session for this agent
		db.PGExec(r.Context(), `UPDATE dialer_sessions SET status='offline' WHERE agent_user_id=$1 AND status!='offline'`, user.ID) //nolint:errcheck

		rows, err := db.PGQuery(r.Context(),
			`INSERT INTO dialer_sessions (campaign_id, agent_user_id, agent_name, status)
			 VALUES (NULLIF($1,0),$2,$3,'ready')
			 RETURNING id, campaign_id, status, joined_at`,
			b.CampaignID, user.ID, user.FullName)
		if err != nil {
			respondErr(w, 500, err.Error())
			return
		}
		w.WriteHeader(201)
		respond(w, rows[0], "session")
	}
}

func dlLeaveSession(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, 401, "unauthorized")
			return
		}
		db.PGExec(r.Context(), `UPDATE dialer_sessions SET status='offline', last_active_at=NOW() WHERE agent_user_id=$1 AND status!='offline'`, user.ID) //nolint:errcheck
		w.WriteHeader(204)
	}
}

func dlSetSessionStatus(db *core.DB) http.HandlerFunc {
	type body struct {
		Status string `json:"status"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, 401, "unauthorized")
			return
		}
		var b body
		json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck
		allowed := map[string]bool{"ready": true, "on_call": true, "paused": true, "offline": true}
		if !allowed[b.Status] {
			respondErr(w, 400, "invalid status")
			return
		}
		db.PGExec(r.Context(),
			`UPDATE dialer_sessions SET status=$1, last_active_at=NOW()
			 WHERE agent_user_id=$2 AND status!='offline'`, b.Status, user.ID) //nolint:errcheck
		w.WriteHeader(204)
	}
}

func dlMySession(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, 401, "unauthorized")
			return
		}
		rows, err := db.PGQuery(r.Context(),
			`SELECT s.id, s.campaign_id, s.status, s.calls_made, s.calls_answered, s.joined_at,
			        c.name AS campaign_name,
			        (SELECT l.id FROM dialer_call_logs l
			         WHERE l.agent_user_id=$1 AND l.call_state IN ('dialing','ringing','answered')
			         ORDER BY l.started_at DESC LIMIT 1) AS active_call_id,
			        (SELECT l.phone FROM dialer_call_logs l
			         WHERE l.agent_user_id=$1 AND l.call_state IN ('dialing','ringing','answered')
			         ORDER BY l.started_at DESC LIMIT 1) AS active_call_phone
			 FROM dialer_sessions s
			 LEFT JOIN dialer_campaigns c ON c.id = s.campaign_id
			 WHERE s.agent_user_id=$1 AND s.status != 'offline'
			 ORDER BY s.joined_at DESC LIMIT 1`, user.ID)
		if err != nil || len(rows) == 0 {
			respond(w, nil, "session")
			return
		}
		respond(w, rows[0], "session")
	}
}

// ── Disposition ───────────────────────────────────────────────────────────────

func dlSetDisposition(db *core.DB) http.HandlerFunc {
	type body struct {
		Disposition string `json:"disposition"`
		Notes       string `json:"notes"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "invalid JSON")
			return
		}
		validDisp := map[string]bool{
			"interested": true, "callback": true, "not_interested": true,
			"wrong_number": true, "busy_callback": true, "dnc": true, "voicemail": true,
		}
		if b.Disposition != "" && !validDisp[b.Disposition] {
			respondErr(w, 400, "invalid disposition")
			return
		}
		_, err := db.PGExec(r.Context(),
			`UPDATE dialer_call_logs SET disposition=$1, notes=$2, updated_at=NOW() WHERE id=$3`,
			b.Disposition, b.Notes, id)
		if err != nil {
			respondErr(w, 500, err.Error())
			return
		}

		// Mark queue entry done / schedule retry if "callback"
		if b.Disposition == "dnc" {
			db.PGExec(r.Context(), `UPDATE dialer_queue SET status='dnc' WHERE id=(SELECT queue_entry_id FROM dialer_call_logs WHERE id=$1)`, id) //nolint:errcheck
		} else if b.Disposition != "" {
			db.PGExec(r.Context(), `UPDATE dialer_queue SET status='completed' WHERE id=(SELECT queue_entry_id FROM dialer_call_logs WHERE id=$1)`, id) //nolint:errcheck
		}

		// Free up agent session
		user := core.UserFromCtx(r.Context())
		if user != nil {
			db.PGExec(r.Context(),
				`UPDATE dialer_sessions SET status='ready', last_active_at=NOW(), calls_made=calls_made+1
				 WHERE agent_user_id=$1 AND status='on_call'`, user.ID) //nolint:errcheck
		}

		w.WriteHeader(204)
	}
}

// ── Preview / progressive dialing ─────────────────────────────────────────────

// dlNextContact returns the next pending contact in the agent's campaign queue
// so the agent can preview the contact before the call fires.
func dlNextContact(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, 401, "unauthorized")
			return
		}
		ctx := r.Context()

		// Find agent's active session and campaign
		sessRows, err := db.PGQuery(ctx,
			`SELECT campaign_id FROM dialer_sessions
			 WHERE agent_user_id=$1 AND status IN ('ready','on_call','paused')
			 ORDER BY joined_at DESC LIMIT 1`, user.ID)
		if err != nil || len(sessRows) == 0 {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]any{"contact": nil}) //nolint:errcheck
			return
		}
		campaignID := int64(numVal(sessRows[0]["campaign_id"]))

		var contacts []core.Row
		var qErr error
		if campaignID > 0 {
			contacts, qErr = db.PGQuery(ctx,
				`SELECT id, phone, customer_name, cif, metadata, priority, attempts
				 FROM dialer_queue
				 WHERE campaign_id=$1
				   AND status='pending'
				   AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
				 ORDER BY priority ASC, created_at ASC LIMIT 1`, campaignID)
		} else {
			// Agent joined with "any campaign" — search across all active campaigns
			contacts, qErr = db.PGQuery(ctx,
				`SELECT q.id, q.phone, q.customer_name, q.cif, q.metadata, q.priority, q.attempts
				 FROM dialer_queue q
				 JOIN dialer_campaigns c ON c.id = q.campaign_id
				 WHERE c.status = 'active'
				   AND q.status = 'pending'
				   AND (q.next_attempt_at IS NULL OR q.next_attempt_at <= NOW())
				 ORDER BY q.priority ASC, q.created_at ASC LIMIT 1`)
		}
		if qErr != nil || len(contacts) == 0 {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]any{"contact": nil}) //nolint:errcheck
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"contact": contacts[0]}) //nolint:errcheck
	}
}

// dlManualCall lets an agent in preview/progressive mode trigger the next call
// themselves, rather than waiting for the auto-dialer engine to fire it.
func dlManualCall(db *core.DB) http.HandlerFunc {
	type body struct {
		QueueEntryID int64  `json:"queue_entry_id"`
		Phone        string `json:"phone"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, 401, "unauthorized")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "invalid JSON")
			return
		}
		ctx := r.Context()

		// Agent must have a ready session
		sessRows, err := db.PGQuery(ctx,
			`SELECT id, campaign_id FROM dialer_sessions
			 WHERE agent_user_id=$1 AND status='ready'
			 ORDER BY joined_at DESC LIMIT 1`, user.ID)
		if err != nil || len(sessRows) == 0 {
			respondErr(w, 400, "no ready session — join a campaign first")
			return
		}
		campaignID := int64(numVal(sessRows[0]["campaign_id"]))

		phone := strings.TrimSpace(b.Phone)
		queueID := b.QueueEntryID

		// If queue entry ID given, resolve phone and campaign from it
		if queueID > 0 {
			qRows, _ := db.PGQuery(ctx,
				`SELECT phone, campaign_id FROM dialer_queue WHERE id=$1`, queueID)
			if len(qRows) > 0 {
				if phone == "" {
					phone = str(qRows[0]["phone"])
				}
				if campaignID == 0 {
					campaignID = int64(numVal(qRows[0]["campaign_id"]))
				}
			}
		}
		// Fallback: if still no campaign, pick the first active one
		if campaignID == 0 {
			cRows, _ := db.PGQuery(ctx,
				`SELECT id FROM dialer_campaigns WHERE status='active' ORDER BY created_at LIMIT 1`)
			if len(cRows) > 0 {
				campaignID = int64(numVal(cRows[0]["id"]))
			}
		}
		if phone == "" {
			respondErr(w, 422, "phone or queue_entry_id is required")
			return
		}
		if campaignID == 0 {
			respondErr(w, 400, "no active campaign found")
			return
		}

		// Mark agent as on_call immediately so the engine doesn't double-fire
		db.PGExec(ctx, //nolint:errcheck
			`UPDATE dialer_sessions SET status='on_call', last_active_at=NOW()
			 WHERE agent_user_id=$1 AND status='ready'`, user.ID)

		// Mark queue entry as dialing
		if queueID > 0 {
			db.PGExec(ctx, //nolint:errcheck
				`UPDATE dialer_queue
				 SET status='dialing', last_attempt_at=NOW(), attempts=attempts+1
				 WHERE id=$1`, queueID)
		}

		// Fetch agent's per-user Zoho Voice access token.
		// The Zoho Desk REST API can only log calls, not initiate them.
		// Real outbound calls require the Zoho Voice click-to-call API with a per-user token.
		agentRows, _ := db.PGQuery(ctx,
			`SELECT zoho_voice_access_token, zoho_voice_token_expiry, zoho_voice_refresh_token
			 FROM o3c_users WHERE id=$1`, user.ID)
		if len(agentRows) == 0 {
			respondErr(w, 403, "Zoho Voice not connected — go to Settings → Voice & Calling")
			return
		}
		encAccess, _ := agentRows[0]["zoho_voice_access_token"].(string)
		expiry, _    := agentRows[0]["zoho_voice_token_expiry"].(time.Time)
		encRefresh, _ := agentRows[0]["zoho_voice_refresh_token"].(string)

		var voiceToken string
		if encAccess != "" && time.Now().Add(60*time.Second).Before(expiry) {
			voiceToken, _ = decryptValue(encAccess)
		} else if encRefresh != "" {
			if rt, _ := decryptValue(encRefresh); rt != "" {
				newAccess, newExpiry, err := voiceRefreshUserToken(ctx, rt)
				if err == nil {
					voiceToken = newAccess
					if enc, err := encryptValue(newAccess); err == nil {
						db.PGExec(ctx, //nolint:errcheck
							`UPDATE o3c_users SET zoho_voice_access_token=$1, zoho_voice_token_expiry=$2 WHERE id=$3`,
							enc, newExpiry, user.ID)
					}
				}
			}
		}
		if voiceToken == "" {
			respondErr(w, 403, "Zoho Voice token expired or missing — reconnect in Settings → Voice & Calling")
			return
		}

		// Create call log before firing so we have a record even if Zoho fails.
		var queueIDArg any
		if queueID > 0 {
			queueIDArg = queueID
		}
		callRows, insErr := db.PGQuery(ctx,
			`INSERT INTO dialer_call_logs
			   (campaign_id, queue_entry_id, agent_user_id, agent_name, phone, call_state)
			 VALUES ($1,$2,$3,$4,$5,'dialing')
			 RETURNING id`, campaignID, queueIDArg, user.ID, user.FullName, phone)
		if insErr != nil {
			slog.Error("dlManualCall: insert log", "err", insErr)
			respondErr(w, 500, "failed to create call log")
			return
		}
		callLogID := int64(numVal(callRows[0]["id"]))

		// Fire via Zoho Voice click-to-call API.
		// This rings the agent's registered Zoho phone first; when they answer,
		// Zoho dials the customer and bridges the two parties.
		voiceBase := "https://voice.zoho." + zohoDC + "/rest/json/zv"
		c2cURL := voiceBase + "/calls/click2call?toNumber=" + url.QueryEscape(phone)
		c2cReq, _ := http.NewRequestWithContext(ctx, "POST", c2cURL, nil)
		c2cReq.Header.Set("Authorization", "Zoho-oauthtoken "+voiceToken)
		c2cReq.Header.Set("Accept", "application/json")
		c2cResp, voiceErr := zohoHTTP.Do(c2cReq)
		if voiceErr != nil {
			slog.Error("dlManualCall: zoho voice click2call", "phone", phone, "err", voiceErr)
			db.PGExec(ctx, `UPDATE dialer_call_logs SET call_state='failed' WHERE id=$1`, callLogID)     //nolint:errcheck
			db.PGExec(ctx, `UPDATE dialer_sessions SET status='ready' WHERE agent_user_id=$1`, user.ID) //nolint:errcheck
			if queueID > 0 {
				db.PGExec(ctx, `UPDATE dialer_queue SET status='pending' WHERE id=$1`, queueID) //nolint:errcheck
			}
			respondErr(w, 502, "Zoho Voice click-to-call failed: "+voiceErr.Error())
			return
		}
		defer c2cResp.Body.Close()
		var c2cResult map[string]any
		json.NewDecoder(c2cResp.Body).Decode(&c2cResult) //nolint:errcheck
		if zohoCallID := str(c2cResult["call_id"]); zohoCallID != "" {
			db.PGExec(ctx, `UPDATE dialer_call_logs SET zoho_call_id=$1 WHERE id=$2`, zohoCallID, callLogID) //nolint:errcheck
		}

		slog.Info("dlManualCall: click2call fired", "phone", phone, "agent", user.FullName, "log_id", callLogID)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"call_log_id": callLogID}) //nolint:errcheck
	}
}

// ── Zoho Voice webhook ────────────────────────────────────────────────────────

func dlZohoWebhook(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(io.LimitReader(r.Body, 64*1024))
		if err != nil {
			w.WriteHeader(400)
			return
		}
		var payload map[string]any
		if err := json.Unmarshal(body, &payload); err != nil {
			w.WriteHeader(400)
			return
		}

		event := str(payload["event"])
		callID := str(payload["call_id"])
		if callID == "" {
			callID = str(payload["callId"])
		}

		ctx := r.Context()
		switch event {
		case "call_answered":
			db.PGExec(ctx,
				`UPDATE dialer_call_logs SET call_state='answered', answered_at=NOW()
				 WHERE zoho_call_id=$1 AND call_state IN ('dialing','ringing')`, callID) //nolint:errcheck
			// Mark the assigned agent as on_call
			db.PGExec(ctx,
				`UPDATE dialer_sessions s SET status='on_call', calls_answered=calls_answered+1
				 WHERE s.agent_user_id=(
				   SELECT agent_user_id FROM dialer_call_logs WHERE zoho_call_id=$1 LIMIT 1
				 ) AND s.status!='offline'`, callID) //nolint:errcheck

		case "call_ended", "call_completed":
			dur := int(numVal(payload["duration"]))
			db.PGExec(ctx,
				`UPDATE dialer_call_logs
				 SET call_state='ended', ended_at=NOW(), duration_sec=$1
				 WHERE zoho_call_id=$2`, dur, callID) //nolint:errcheck

		case "call_missed", "call_no_answer":
			db.PGExec(ctx,
				`UPDATE dialer_call_logs
				 SET call_state='no_answer', ended_at=NOW()
				 WHERE zoho_call_id=$1 AND call_state IN ('dialing','ringing')`, callID) //nolint:errcheck
			scheduleQueueRetry(ctx, db, callID)

		case "call_abandoned":
			db.PGExec(ctx,
				`UPDATE dialer_call_logs
				 SET call_state='abandoned', is_abandoned=true, ended_at=NOW()
				 WHERE zoho_call_id=$1 AND call_state IN ('dialing','ringing')`, callID) //nolint:errcheck
			scheduleQueueRetry(ctx, db, callID)

		default:
			slog.Info("dialer: unknown webhook event", "event", event, "call_id", callID)
		}

		w.WriteHeader(200)
	}
}

func scheduleQueueRetry(ctx context.Context, db *core.DB, zohoCallID string) {
	db.PGExec(ctx,
		`UPDATE dialer_queue q
		 SET attempts = attempts+1,
		     last_attempt_at = NOW(),
		     next_attempt_at = NOW() + (
		       SELECT (retry_delay_minutes || ' minutes')::INTERVAL
		       FROM dialer_campaigns c WHERE c.id = q.campaign_id LIMIT 1
		     ),
		     status = CASE
		       WHEN attempts+1 >= (SELECT max_attempts FROM dialer_campaigns c WHERE c.id=q.campaign_id LIMIT 1)
		         THEN 'failed'
		       ELSE 'pending'
		     END
		 WHERE id = (
		   SELECT queue_entry_id FROM dialer_call_logs WHERE zoho_call_id=$1 LIMIT 1
		 )`, zohoCallID) //nolint:errcheck
}

// ── Dialer Engine ─────────────────────────────────────────────────────────────

// runDialerEngine fires outbound calls for all active campaigns.
// It runs in a background goroutine for the lifetime of the process.
func runDialerEngine(db *core.DB) {
	ticker := time.NewTicker(5 * time.Second)
	staleClean := time.NewTicker(60 * time.Second)
	defer ticker.Stop()
	defer staleClean.Stop()

	for {
		select {
		case <-ticker.C:
			runDialerTick(db)
		case <-staleClean.C:
			markStaleCalls(db)
		}
	}
}

// runDialerTick processes one 5-second cycle for all active campaigns.
func runDialerTick(db *core.DB) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	campaigns, err := db.PGQuery(ctx,
		`SELECT id, dial_ratio, max_abandonment_pct, max_attempts, retry_delay_minutes
		 FROM dialer_campaigns
		 WHERE status='active'`)
	if err != nil {
		slog.Error("dialer engine: list campaigns", "err", err)
		return
	}

	for _, c := range campaigns {
		campaignID := int64(numVal(c["id"]))
		dialRatio := numVal(c["dial_ratio"])
		maxAbandonPct := numVal(c["max_abandonment_pct"])

		processDialerCampaign(ctx, db, campaignID, dialRatio, maxAbandonPct)
	}
}

func processDialerCampaign(ctx context.Context, db *core.DB, campaignID int64, dialRatio, maxAbandonPct float64) {
	// Count ready agents
	agentRows, err := db.PGQuery(ctx,
		`SELECT COUNT(*) AS cnt FROM dialer_sessions
		 WHERE campaign_id=$1 AND status='ready'`, campaignID)
	if err != nil || len(agentRows) == 0 {
		return
	}
	readyAgents := int(numVal(agentRows[0]["cnt"]))
	if readyAgents == 0 {
		return
	}

	// Count in-flight calls
	inFlightRows, err := db.PGQuery(ctx,
		`SELECT COUNT(*) AS cnt FROM dialer_call_logs
		 WHERE campaign_id=$1
		   AND call_state IN ('dialing','ringing')
		   AND started_at > NOW() - INTERVAL '2 minutes'`, campaignID)
	if err != nil || len(inFlightRows) == 0 {
		return
	}
	inFlight := int(numVal(inFlightRows[0]["cnt"]))

	// Check abandonment rate (last 200 calls)
	abanRows, _ := db.PGQuery(ctx,
		`SELECT
		   COUNT(*) AS total,
		   COUNT(*) FILTER (WHERE is_abandoned) AS abandoned
		 FROM (
		   SELECT is_abandoned FROM dialer_call_logs
		   WHERE campaign_id=$1 ORDER BY created_at DESC LIMIT 200
		 ) t`, campaignID)
	if len(abanRows) > 0 {
		total := numVal(abanRows[0]["total"])
		abandoned := numVal(abanRows[0]["abandoned"])
		if total >= 20 {
			abanPct := (abandoned / total) * 100
			if abanPct >= maxAbandonPct {
				slog.Warn("dialer: abandonment cap reached — throttling", "campaign_id", campaignID, "pct", abanPct)
				return
			}
		}
	}

	// Calculate how many calls to fire
	target := int(math.Ceil(float64(readyAgents) * dialRatio))
	toFire := target - inFlight
	if toFire <= 0 {
		return
	}

	// Pop contacts from queue
	contacts, err := db.PGQuery(ctx,
		`UPDATE dialer_queue SET status='dialing', last_attempt_at=NOW(), attempts=attempts+1
		 WHERE id IN (
		   SELECT id FROM dialer_queue
		   WHERE campaign_id=$1
		     AND status='pending'
		     AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
		   ORDER BY priority ASC, created_at ASC
		   LIMIT $2
		   FOR UPDATE SKIP LOCKED
		 )
		 RETURNING id, phone, customer_name, cif`, campaignID, toFire)
	if err != nil {
		slog.Error("dialer: pop queue", "campaign_id", campaignID, "err", err)
		return
	}

	for _, contact := range contacts {
		phone := str(contact["phone"])
		queueID := int64(numVal(contact["id"]))
		fireDialerCall(ctx, db, campaignID, queueID, phone)
	}
}

// fireDialerCall initiates a single outbound call via Zoho Voice.
func fireDialerCall(ctx context.Context, db *core.DB, campaignID, queueID int64, phone string) {
	payload := map[string]any{
		"callType": "OUTBOUND",
		"toNumber": phone,
	}
	payloadBytes, _ := json.Marshal(payload)

	// Insert call log before firing so we have a record even if Zoho fails
	callRows, err := db.PGQuery(ctx,
		`INSERT INTO dialer_call_logs (campaign_id, queue_entry_id, phone, call_state)
		 VALUES ($1,$2,$3,'dialing') RETURNING id`, campaignID, queueID, phone)
	if err != nil {
		slog.Error("dialer: insert call log", "err", err)
		// Roll back queue entry
		db.PGExec(ctx, `UPDATE dialer_queue SET status='pending', last_attempt_at=NULL WHERE id=$1`, queueID) //nolint:errcheck
		return
	}
	callLogID := int64(numVal(callRows[0]["id"]))

	resp, err := zohoWrite(ctx, "POST", "calls", strings.NewReader(string(payloadBytes)))
	if err != nil {
		slog.Error("dialer: zoho call failed", "phone", phone, "err", err)
		db.PGExec(ctx, `UPDATE dialer_call_logs SET call_state='failed' WHERE id=$1`, callLogID) //nolint:errcheck
		db.PGExec(ctx, `UPDATE dialer_queue SET status='pending' WHERE id=$1`, queueID) //nolint:errcheck
		return
	}
	defer resp.Body.Close()

	var result map[string]any
	json.NewDecoder(resp.Body).Decode(&result) //nolint:errcheck

	// Extract zoho call ID from response
	zohoCallID := str(result["id"])
	if zohoCallID == "" {
		zohoCallID = str(result["callId"])
	}
	if zohoCallID != "" {
		db.PGExec(ctx, `UPDATE dialer_call_logs SET zoho_call_id=$1 WHERE id=$2`, zohoCallID, callLogID) //nolint:errcheck
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		slog.Warn("dialer: zoho returned non-2xx", "status", resp.StatusCode, "phone", phone)
		db.PGExec(ctx, `UPDATE dialer_call_logs SET call_state='failed' WHERE id=$1`, callLogID) //nolint:errcheck
		db.PGExec(ctx, `UPDATE dialer_queue SET status='pending' WHERE id=$1`, queueID) //nolint:errcheck
	} else {
		slog.Info("dialer: call fired", "phone", phone, "campaign_id", campaignID, "call_log_id", callLogID)
	}
}

// markStaleCalls marks calls that have been "dialing" for > 90s as abandoned.
// This handles the case where Zoho Voice webhook didn't fire.
func markStaleCalls(db *core.DB) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	rows, err := db.PGQuery(ctx,
		`UPDATE dialer_call_logs
		 SET call_state='abandoned', is_abandoned=true, ended_at=NOW()
		 WHERE call_state IN ('dialing','ringing')
		   AND started_at < NOW() - INTERVAL '90 seconds'
		 RETURNING id, queue_entry_id, campaign_id`)
	if err != nil {
		slog.Error("dialer: mark stale calls", "err", err)
		return
	}

	for _, row := range rows {
		queueID := int64(numVal(row["queue_entry_id"]))
		if queueID == 0 {
			continue
		}
		// Schedule retry for stale calls
		db.PGExec(ctx,
			`UPDATE dialer_queue
			 SET attempts=attempts+1,
			     last_attempt_at=NOW(),
			     next_attempt_at=NOW() + (
			       SELECT (retry_delay_minutes || ' minutes')::INTERVAL
			       FROM dialer_campaigns c WHERE c.id=dialer_queue.campaign_id LIMIT 1
			     ),
			     status=CASE
			       WHEN attempts+1 >= (SELECT max_attempts FROM dialer_campaigns c WHERE c.id=dialer_queue.campaign_id LIMIT 1)
			         THEN 'failed' ELSE 'pending' END
			 WHERE id=$1 AND status='dialing'`, queueID) //nolint:errcheck
	}
}

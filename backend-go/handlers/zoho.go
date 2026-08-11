package handlers

// Zoho integration — Desk ticket/call/contact sync + Voice call initiation.
//
// This file is the live Zoho ingestion surface. Despite older comments, Desk
// sync is NOT removed: RegisterZoho wires Desk ticket/thread/call/contact import
// jobs, and the hourly auto-sync (runZohoVoiceSyncCycle) pulls Desk /calls via
// runZohoDeskCallsHeadless — NOT Voice. The Zoho Voice /logs importer
// (runZohoVoiceImport) only runs on the manual POST /voice/import-logs route.
// Voice OAuth (per-user) lives in voice.go.
//
// Credentials (set as Railway env vars or in Admin → API Keys):
//   ZOHO_CLIENT_ID      – OAuth app client ID
//   ZOHO_CLIENT_SECRET  – OAuth app client secret
//   ZOHO_REFRESH_TOKEN  – long-lived refresh token
//   ZOHO_ORG_ID         – Zoho Desk organization ID (still used for call initiation)
//   ZOHO_DC             – data-center suffix: com (default) | eu | in | com.au | jp

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// voiceRefreshUserToken exchanges a Zoho Voice refresh token for a new access token.
// Used only by zohoInitiateCall to refresh per-user tokens for call initiation.
func voiceRefreshUserToken(ctx context.Context, refreshToken string) (string, time.Time, error) {
	tokenURL := "https://accounts.zoho." + zohoDC + "/oauth/v2/token"
	body := url.Values{
		"grant_type":    {"refresh_token"},
		"client_id":     {zohoClientID},
		"client_secret": {zohoClientSecret},
		"refresh_token": {refreshToken},
	}.Encode()
	resp, err := httpPost(tokenURL, "application/x-www-form-urlencoded", "", []byte(body), 15*time.Second)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("voice token request: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var tok struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
		Error       string `json:"error"`
		ErrorDesc   string `json:"error_description"`
	}
	if err := json.Unmarshal(raw, &tok); err != nil {
		return "", time.Time{}, fmt.Errorf("voice token decode: %w", err)
	}
	if tok.Error != "" {
		return "", time.Time{}, fmt.Errorf("zoho voice oauth error: %s — %s", tok.Error, tok.ErrorDesc)
	}
	secs := tok.ExpiresIn
	if secs == 0 {
		secs = 3600
	}
	return tok.AccessToken, time.Now().Add(time.Duration(secs) * time.Second), nil
}

// ── Route registration ────────────────────────────────────────────────────────

func RegisterZoho(r chi.Router, db *core.DB) {
	r.Get("/sync-status", zohoSyncStatus(db))
	r.Get("/import-status", zohoImportStatus())
	r.Post("/import-tickets", zohoImportTickets(db))
	r.Post("/import-threads", zohoImportThreads(db))
	r.Post("/import-calls", zohoImportDeskCalls(db))
	r.Post("/import-contacts", zohoImportContacts(db))
	r.Post("/backfill-assignees", zohoBackfillAssignees(db))
	r.Post("/relink-assignees", zohoRelinkAssignees(db))
	r.Post("/onboard-agents", zohoOnboardAgents(db))

	// Voice routes require call_center page permission — these initiate or import live calls.
	cc := core.RequirePages("call_center")
	r.With(cc).Post("/voice/import-logs", zohoImportVoiceLogs(db))
	r.With(cc).Post("/voice/call", zohoInitiateCall(db))
}

// RegisterZohoAdmin mounts the import endpoints outside the JWT auth group,
// protected by X-Admin-Secret header (same secret as RESET_ADMIN_SECRET).
func RegisterZohoAdmin(r chi.Router, db *core.DB, adminSecret string) {
	guard := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if adminSecret == "" || subtle.ConstantTimeCompare(
				[]byte(r.Header.Get("X-Admin-Secret")), []byte(adminSecret)) != 1 {
				http.Error(w, `{"detail":"Forbidden"}`, http.StatusForbidden)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
	r.With(guard).Get("/admin/import-status", zohoImportStatus())
	r.With(guard).Post("/admin/import-tickets", zohoImportTickets(db))
	r.With(guard).Post("/admin/import-threads", zohoImportThreads(db))
	r.With(guard).Post("/admin/import-calls", zohoImportDeskCalls(db))
	r.With(guard).Post("/admin/import-contacts", zohoImportContacts(db))
	r.With(guard).Post("/admin/backfill-assignees", zohoBackfillAssignees(db))
	r.With(guard).Post("/admin/relink-assignees", zohoRelinkAssignees(db))
	r.With(guard).Post("/admin/onboard-agents", zohoOnboardAgents(db))
}

// ── Credential helpers ────────────────────────────────────────────────────────

// zohoCred returns the value for key: env var first, then DB.
func zohoCred(ctx context.Context, db *core.DB, key string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return resolveCredKey(ctx, db, key)
}

// updateLiveVars re-hydrates the package-level vars in call_center.go from
// env / DB, so the running token manager picks up changes without a restart.
func updateLiveVars(ctx context.Context, db *core.DB) {
	if v := zohoCred(ctx, db, "ZOHO_CLIENT_ID"); v != "" {
		zohoClientID = v
	}
	if v := zohoCred(ctx, db, "ZOHO_CLIENT_SECRET"); v != "" {
		zohoClientSecret = v
	}
	if v := zohoCred(ctx, db, "ZOHO_REFRESH_TOKEN"); v != "" {
		zohoRefreshTok = v
	}
	if v := zohoCred(ctx, db, "ZOHO_ORG_ID"); v != "" {
		zohoOrgID = v
	}
	zohoTok.Lock()
	zohoTok.access = ""
	zohoTok.expires = time.Time{}
	zohoTok.Unlock()
}

func zohoEnsureConfigured(ctx context.Context, db *core.DB) bool {
	if zohoConfigured() {
		return true
	}
	updateLiveVars(ctx, db)
	return zohoConfigured()
}

// zohoWrite sends an authenticated request to the Zoho Desk API (used for
// outbound call initiation via the /calls endpoint).
func zohoWrite(ctx context.Context, method, path string, body io.Reader) (*http.Response, error) {
	token, err := zohoAccessToken(ctx)
	if err != nil {
		return nil, err
	}
	reqURL := "https://desk.zoho." + zohoDC + "/api/v1/" + strings.TrimPrefix(path, "/")
	req, err := http.NewRequestWithContext(ctx, method, reqURL, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Zoho-oauthtoken "+token)
	req.Header.Set("orgId", zohoOrgID)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return zohoHTTP.Do(req)
}

// ── Zoho Voice — import call logs ─────────────────────────────────────────────

// runZohoVoiceImport fetches call logs from Zoho Voice and inserts them into
// helpdesk_calls. Called by the HTTP handler and the hourly auto-sync goroutine.
func runZohoVoiceImport(ctx context.Context, db *core.DB, fromDate, toDate string) (imported, skipped, failed int, err error) {
	token, err := zohoAccessToken(ctx)
	if err != nil {
		return 0, 0, 0, fmt.Errorf("token error: %w", err)
	}

	voiceBase := "https://voice.zoho.com/rest/json/zv"
	pageFrom := 0
	pageSize := 100

	for {
		reqURL := fmt.Sprintf("%s/logs?from=%d&size=%d&fromDate=%s&toDate=%s",
			voiceBase, pageFrom, pageSize, url.QueryEscape(fromDate), url.QueryEscape(toDate))
		req, reqErr := http.NewRequestWithContext(ctx, "GET", reqURL, nil)
		if reqErr != nil {
			break
		}
		req.Header.Set("Authorization", "Zoho-oauthtoken "+token)
		req.Header.Set("Accept", "application/json")

		resp, doErr := zohoHTTP.Do(req)
		if doErr != nil {
			slog.Error("runZohoVoiceImport: request", "err", doErr)
			break
		}

		bodyBytes, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		var result map[string]any
		json.Unmarshal(bodyBytes, &result) //nolint:errcheck

		if resp.StatusCode != 200 {
			slog.Warn("runZohoVoiceImport: non-200", "status", resp.StatusCode, "body", string(bodyBytes[:min(len(bodyBytes), 400)]))
			return imported, skipped, failed, fmt.Errorf("Zoho Voice API error (HTTP %d): %s",
				resp.StatusCode, strings.TrimSpace(string(bodyBytes[:min(len(bodyBytes), 400)])))
		}

		var logs []map[string]any
		if arr, ok := result["logs"].([]any); ok {
			for _, item := range arr {
				if m, ok := item.(map[string]any); ok {
					logs = append(logs, m)
				}
			}
		} else if arr, ok := result["data"].([]any); ok {
			for _, item := range arr {
				if m, ok := item.(map[string]any); ok {
					logs = append(logs, m)
				}
			}
		} else if resp2, ok := result["response"].(map[string]any); ok {
			if arr2, ok := resp2["result"].([]any); ok {
				for _, item := range arr2 {
					if m, ok := item.(map[string]any); ok {
						logs = append(logs, m)
					}
				}
			}
		}
		if len(logs) == 0 {
			break
		}

		for _, c := range logs {
			voiceID := zohoStr(c["logid"])
			if voiceID == "" {
				voiceID = zohoStr(c["id"])
				if voiceID == "" {
					voiceID = zohoStr(c["call_id"])
				}
			}
			if voiceID == "" {
				skipped++
				continue
			}

			callType := zohoStr(c["call_type"])
			direction := "inbound"
			if strings.Contains(strings.ToLower(callType), "outgoing") ||
				strings.Contains(strings.ToLower(callType), "outbound") {
				direction = "outbound"
			}

			outcome := "missed"
			hangup := zohoStr(c["hangup_cause_displayname"])
			if strings.Contains(strings.ToLower(hangup), "normal") ||
				zohoStr(c["answer_time"]) != "" {
				outcome = "resolved"
			}

			durSec := zohoParseDurationSec(c["duration"])

			agentName := zohoStr(c["destination_name"])
			if agentName == "" {
				agentName = zohoStr(c["agent_number"])
			}
			customerPhone := zohoStr(c["caller_id_number"])
			callTo := zohoStr(c["destination_number"])
			if callTo == "" {
				callTo = zohoStr(c["did_number"])
			}

			startedAt := time.Now()
			if ts := zohoParseMillisTime(c["start_time"]); !ts.IsZero() {
				startedAt = ts
			} else if st := zohoStr(c["start_time"]); st != "" {
				if ts, err2 := time.Parse("2006-01-02 15:04:05", st); err2 == nil {
					startedAt = ts
				} else if ts, err2 := time.Parse(time.RFC3339, st); err2 == nil {
					startedAt = ts
				}
			}

			res, insErr := db.PGExec(ctx, `
				INSERT INTO helpdesk_calls
				    (agent_name, customer_phone, call_to, direction, duration_sec,
				     outcome, started_at, zoho_voice_id, source_system)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'zoho_voice')
				ON CONFLICT DO NOTHING`,
				ptrOrNilStr(agentName), ptrOrNilStr(customerPhone),
				ptrOrNilStr(callTo), direction, durSec, outcome, startedAt, voiceID)
			if insErr != nil {
				slog.Warn("runZohoVoiceImport: insert", "voice_id", voiceID, "err", insErr)
				failed++
			} else {
				if n, _ := res.RowsAffected(); n > 0 {
					imported++
				} else {
					skipped++
				}
			}
		}

		if len(logs) < pageSize {
			break
		}
		pageFrom += pageSize
		if pageFrom > 5000 {
			break
		}
	}

	slog.Info("runZohoVoiceImport done", "imported", imported, "skipped", skipped, "failed", failed)
	return imported, skipped, failed, nil
}

func zohoImportVoiceLogs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		if !zohoEnsureConfigured(ctx, db) {
			respondErr(w, 503, "Zoho credentials not configured")
			return
		}
		if err := ensureCallLogSchema(ctx, db); err != nil {
			respondErr(w, 500, "Call log schema error")
			return
		}

		fromDate := time.Now().AddDate(0, 0, -30).Format("2006-01-02")
		toDate := time.Now().Format("2006-01-02")
		if v := r.URL.Query().Get("from_date"); v != "" {
			fromDate = v
		}
		if v := r.URL.Query().Get("to_date"); v != "" {
			toDate = v
		}

		imported, skipped, failed, err := runZohoVoiceImport(ctx, db, fromDate, toDate)
		if err != nil {
			respondErr(w, 502, err.Error())
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"imported": imported, "skipped": skipped, "failed": failed,
		})
	}
}

// zohoSyncStatus returns Zoho configuration state and the last call import stats.
func zohoSyncStatus(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		configured := zohoEnsureConfigured(ctx, db)

		// Ensure the zoho_voice_id / zoho_call_id columns exist before querying them.
		ensureCallLogSchema(ctx, db) //nolint:errcheck

		var lastSyncAt *string
		var totalImported int64

		rows, _ := db.PGQuery(ctx, `
			SELECT MAX(started_at), COUNT(*)
			FROM helpdesk_calls
			WHERE zoho_voice_id IS NOT NULL OR zoho_call_id IS NOT NULL`)
		if len(rows) > 0 {
			if v, ok := rows[0]["max"].(time.Time); ok && !v.IsZero() {
				s := v.UTC().Format(time.RFC3339)
				lastSyncAt = &s
			}
			if v, ok := rows[0]["count"].(int64); ok {
				totalImported = v
			}
		}

		// Real sync-run state (attempt/success/error), separate from newest-call time.
		ensureZohoSyncState(ctx, db)
		var lastAttemptAt, lastSuccessAt, lastError *string
		var lastImported int64
		if srows, _ := db.PGQuery(ctx,
			`SELECT last_attempt_at, last_success_at, last_error, last_imported
			 FROM zoho_sync_state WHERE job='calls'`); len(srows) > 0 {
			fmtTime := func(v any) *string {
				if t, ok := v.(time.Time); ok && !t.IsZero() {
					s := t.UTC().Format(time.RFC3339)
					return &s
				}
				return nil
			}
			lastAttemptAt = fmtTime(srows[0]["last_attempt_at"])
			lastSuccessAt = fmtTime(srows[0]["last_success_at"])
			if e, ok := srows[0]["last_error"].(string); ok && e != "" {
				lastError = &e
			}
			lastImported = toInt64(srows[0]["last_imported"])
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"configured":      configured,
			"last_sync_at":    lastSyncAt, // newest imported call
			"total_imported":  totalImported,
			"last_attempt_at": lastAttemptAt,
			"last_success_at": lastSuccessAt,
			"last_error":      lastError,
			"last_imported":   lastImported,
		})
	}
}

// ── Sync-state tracking ───────────────────────────────────────────────────────
// The Zoho path is intermittent; without a recorded attempt/success/error the sync
// can silently drift for days. This makes staleness queryable + surfaces "Sync now".

func ensureZohoSyncState(ctx context.Context, db *core.DB) {
	db.PGExec(ctx, `CREATE TABLE IF NOT EXISTS zoho_sync_state (
		job             TEXT PRIMARY KEY,
		last_attempt_at TIMESTAMPTZ,
		last_success_at TIMESTAMPTZ,
		last_error      TEXT,
		last_imported   INT DEFAULT 0
	)`) //nolint:errcheck
}

func recordZohoSyncResult(ctx context.Context, db *core.DB, job string, imported int, syncErr error) {
	ensureZohoSyncState(ctx, db)
	if syncErr != nil {
		msg := syncErr.Error()
		if len(msg) > 500 {
			msg = msg[:500]
		}
		db.PGExec(ctx, `INSERT INTO zoho_sync_state (job, last_attempt_at, last_error)
			VALUES ($1, NOW(), $2)
			ON CONFLICT (job) DO UPDATE SET last_attempt_at = NOW(), last_error = $2`, job, msg) //nolint:errcheck
		return
	}
	db.PGExec(ctx, `INSERT INTO zoho_sync_state (job, last_attempt_at, last_success_at, last_error, last_imported)
		VALUES ($1, NOW(), NOW(), NULL, $2)
		ON CONFLICT (job) DO UPDATE SET last_attempt_at = NOW(), last_success_at = NOW(), last_error = NULL, last_imported = $2`, job, imported) //nolint:errcheck
}

// runZohoVoiceSyncCycle imports the recent call window with a few backoff retries,
// so a transient DNS/connection blip doesn't skip the whole hour. Records the
// outcome either way.
func runZohoVoiceSyncCycle(db *core.DB) {
	ctx := context.Background()
	if !zohoEnsureConfigured(ctx, db) {
		return
	}
	if err := ensureCallLogSchema(ctx, db); err != nil {
		slog.Error("zoho auto-sync: schema error", "err", err)
		recordZohoSyncResult(ctx, db, "calls", 0, err)
		return
	}
	from := time.Now().AddDate(0, 0, -3).Format("2006-01-02")
	to := time.Now().Format("2006-01-02")

	backoffs := []time.Duration{0, 30 * time.Second, 2 * time.Minute}
	var imported int
	var err error
	for i, wait := range backoffs {
		if wait > 0 {
			time.Sleep(wait)
		}
		imported, err = runZohoDeskCallsHeadless(ctx, db, from, to)
		if err == nil {
			slog.Info("zoho auto-sync: done", "imported", imported, "attempt", i+1)
			recordZohoSyncResult(ctx, db, "calls", imported, nil)
			return
		}
		slog.Warn("zoho auto-sync: attempt failed", "attempt", i+1, "err", err)
	}
	slog.Error("zoho auto-sync: giving up this cycle (will retry next hour)", "err", err)
	recordZohoSyncResult(ctx, db, "calls", 0, err)
}

// runZohoDeskCallsHeadless runs the Zoho Desk call import for a date window without
// an HTTP response, reusing the shared "calls" job so it never collides with a
// manual import. Returns the count imported and any error the job recorded.
func runZohoDeskCallsHeadless(ctx context.Context, db *core.DB, from, to string) (int, error) {
	j := zohoJobs["calls"]
	j.Lock()
	if j.running {
		j.Unlock()
		return 0, nil // a manual or prior auto import is already running; skip quietly
	}
	j.running, j.done = true, false
	j.imported, j.skipped, j.failed, j.pages = 0, 0, 0, 0
	j.startedAt, j.endedAt, j.lastErr = time.Now(), time.Time{}, ""
	j.Unlock()

	// Bounded sweep: newest-first, so the top ~1000 calls always contain everything
	// new since the last hourly run. A light 10-page pass keeps it fast + reliable on
	// the flaky path (the 3-day `from` is just a safety filter, not a scan target).
	runZohoDeskCallImportJob(ctx, db, j, from, to, 1000)

	j.Lock()
	imported, lastErr := j.imported, j.lastErr
	j.running, j.done, j.endedAt = false, true, time.Now()
	j.Unlock()
	if lastErr != "" {
		return imported, fmt.Errorf("%s", lastErr)
	}
	return imported, nil
}

// StartZohoAutoSync imports Zoho Desk call logs shortly after startup and then
// every hour. Desk is where this org's calls live (not Voice), so this keeps the
// Call Center pages current. Running at startup means a redeploy doesn't delay the
// next sync by a full hour; the in-cycle retries ride out the flaky network path.
//
// The goroutine starts unconditionally: the config check must NOT be here, because
// the Zoho creds are loaded from .env lazily (zohoEnsureConfigured) after package
// init — checking zohoConfigured() at startup sees empty vars and would silently
// disable the sync forever. runZohoVoiceSyncCycle gates on zohoEnsureConfigured
// each run, so it's a cheap no-op if Zoho is genuinely unconfigured.
func StartZohoAutoSync(db *core.DB) {
	go func() {
		ensureZohoSyncState(context.Background(), db)
		time.Sleep(30 * time.Second) // let startup settle
		runZohoVoiceSyncCycle(db)
		ticker := time.NewTicker(1 * time.Hour)
		defer ticker.Stop()
		for range ticker.C {
			runZohoVoiceSyncCycle(db)
		}
	}()
}

// StartZohoDeskAutoSync keeps the helpdesk queue current by importing the newest
// Zoho Desk tickets every hour (a bounded, newest-first sweep). Idempotent upserts
// mean re-sweeping the recent window is cheap; new tickets are caught at the top.
func StartZohoDeskAutoSync(db *core.DB) {
	// Start unconditionally — see StartZohoAutoSync: zohoConfigured() is empty at
	// package-init before .env loads, so the inner runOnce gates on zohoEnsureConfigured.
	go func() {
		time.Sleep(2 * time.Minute) // let startup settle before the first sweep
		ticker := time.NewTicker(1 * time.Hour)
		defer ticker.Stop()

		runOnce := func() {
			ctx := context.Background()
			if !zohoEnsureConfigured(ctx, db) {
				return
			}
			j := zohoJobs["tickets"]
			j.Lock()
			if j.running { // a manual import is already in flight — skip this tick
				j.Unlock()
				return
			}
			j.running, j.done = true, false
			j.imported, j.skipped, j.failed, j.pages = 0, 0, 0, 0
			j.startedAt, j.endedAt, j.lastErr = time.Now(), time.Time{}, ""
			j.Unlock()
			WorkerBeat(ctx, db, "zoho_desk", "running", "", "")

			// Newest-first, capped so each hourly sweep only touches the recent window.
			runZohoTicketImportJob(ctx, db, j, 2000, true)

			j.Lock()
			j.running, j.done, j.endedAt = false, true, time.Now()
			imported := j.imported
			lastErr := j.lastErr
			j.Unlock()
			slog.Info("zoho desk auto-sync: tickets done", "imported", imported)
			if lastErr != "" {
				WorkerBeat(ctx, db, "zoho_desk", "error", lastErr, "")
			} else {
				WorkerBeat(ctx, db, "zoho_desk", "ok", fmt.Sprintf("%d tickets imported", imported), "")
			}
		}

		runOnce()
		for range ticker.C {
			runOnce()
		}
	}()
}

// ── Background import jobs ────────────────────────────────────────────────────
//
// The Desk migration imports (tickets, threads, calls) can each touch tens of
// thousands of records and make hundreds of Zoho calls. Running them inside the
// HTTP request is unsafe: the client times out, and a disconnect cancels the
// request context mid-run. Instead each import runs as a named background job on
// context.Background(), pages through Zoho inserting as it goes (bounded memory),
// and is polled via GET .../import-status?job=<name>.

type zohoJob struct {
	sync.Mutex
	running   bool
	done      bool
	imported  int
	skipped   int
	failed    int
	pages     int
	processed int // secondary counter (e.g. tickets processed by the thread job)
	startedAt time.Time
	endedAt   time.Time
	lastErr   string
}

// zohoJobs is fixed-key and pre-initialised, so concurrent reads need no map lock.
var zohoJobs = map[string]*zohoJob{
	"tickets": {}, "threads": {}, "calls": {}, "contacts": {},
}

// startZohoJob launches fn as the named background job unless one is already
// running, and writes the HTTP response (202 started / 409 already-running).
func startZohoJob(name string, w http.ResponseWriter, fn func(ctx context.Context, j *zohoJob)) {
	j := zohoJobs[name]
	j.Lock()
	if j.running {
		resp := map[string]any{"status": "already_running", "job": name,
			"imported": j.imported, "skipped": j.skipped, "failed": j.failed, "pages": j.pages}
		j.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(409)
		json.NewEncoder(w).Encode(resp) //nolint:errcheck
		return
	}
	j.running, j.done = true, false
	j.imported, j.skipped, j.failed, j.pages, j.processed = 0, 0, 0, 0, 0
	j.startedAt, j.endedAt, j.lastErr = time.Now(), time.Time{}, ""
	j.Unlock()

	go func() {
		defer func() {
			j.Lock()
			j.running, j.done, j.endedAt = false, true, time.Now()
			slog.Info("zoho import job done", "job", name,
				"imported", j.imported, "skipped", j.skipped, "failed", j.failed, "pages", j.pages)
			j.Unlock()
		}()
		fn(context.Background(), j)
	}()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(202)
	json.NewEncoder(w).Encode(map[string]any{"status": "started", "job": name}) //nolint:errcheck
}

// zohoImportStatus reports progress of a background import job (?job=tickets|threads|calls).
func zohoImportStatus() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		name := r.URL.Query().Get("job")
		if name == "" {
			name = "tickets"
		}
		j, ok := zohoJobs[name]
		if !ok {
			respondErr(w, 400, "unknown job: "+name)
			return
		}
		j.Lock()
		resp := map[string]any{
			"job": name, "running": j.running, "done": j.done,
			"imported": j.imported, "skipped": j.skipped, "failed": j.failed,
			"pages": j.pages, "processed": j.processed, "last_error": j.lastErr,
		}
		if !j.startedAt.IsZero() {
			resp["started_at"] = j.startedAt.UTC().Format(time.RFC3339)
		}
		if !j.endedAt.IsZero() {
			resp["ended_at"] = j.endedAt.UTC().Format(time.RFC3339)
		}
		j.Unlock()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp) //nolint:errcheck
	}
}

// ── Zoho Desk — import tickets (background job) ───────────────────────────────

func zohoImportTickets(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !zohoEnsureConfigured(r.Context(), db) {
			respondErr(w, 503, "Zoho credentials not configured")
			return
		}
		maxTickets := 100000
		if v := r.URL.Query().Get("max"); v != "" {
			if n, perr := strconv.Atoi(v); perr == nil && n > 0 {
				maxTickets = n
			}
		}
		// Zoho's list API caps from/limit pagination at ~31,300 rows. order=desc
		// sweeps newest-first so asc+desc together cover the full ticket set.
		desc := r.URL.Query().Get("order") == "desc"
		startZohoJob("tickets", w, func(ctx context.Context, j *zohoJob) {
			runZohoTicketImportJob(ctx, db, j, maxTickets, desc)
		})
	}
}

// runZohoTicketImportJob pages through Zoho tickets (oldest first), inserting
// each page as it arrives so memory stays bounded regardless of total volume.
func runZohoTicketImportJob(ctx context.Context, db *core.DB, j *zohoJob, maxTickets int, desc bool) {
	ensureHelpdeskColumns(ctx, db)

	statusMap := map[string]string{
		"open": "open", "on hold": "pending", "escalated": "open",
		"resolved": "resolved", "closed": "closed",
	}
	priorityMap := map[string]string{
		"low": "low", "medium": "normal", "high": "high", "urgent": "urgent",
	}

	sortBy := "createdTime"
	if desc {
		sortBy = "-createdTime"
	}

	// Resume (ascending only): tickets import oldest-first monotonically, so the DB
	// count is the high-water mark — skip whole pages already done. The descending
	// pass (to reach the newest ~10k beyond Zoho's ~31,300 offset cap) can't resume
	// by count, so it starts at 0 and relies on idempotent upserts.
	offset := 0
	if !desc {
		if rows, err := db.PGQuery(ctx, `SELECT COUNT(*) AS c FROM helpdesk_tickets WHERE source_system='zoho_desk'`); err == nil && len(rows) > 0 {
			existing := int(toInt64(rows[0]["c"]))
			offset = (existing / 100) * 100
			if offset > 0 {
				slog.Info("zohoImportTickets job: resuming", "existing", existing, "from_offset", offset)
			}
		}
	}
	for {
		params := url.Values{
			"from":    {strconv.Itoa(offset)},
			"limit":   {"100"},
			"sortBy":  {sortBy},
			"include": {"contacts,assignee"},
		}
		result, err := zohoFetch(ctx, "tickets", params)
		if err != nil {
			j.Lock()
			j.lastErr = err.Error()
			j.Unlock()
			slog.Error("zohoImportTickets job: fetch", "offset", offset, "err", err)
			return
		}
		batch := zohoItems(result)
		if len(batch) == 0 {
			return
		}

		for _, t := range batch {
			imp, skip, fail := upsertZohoTicket(ctx, db, t, statusMap, priorityMap)
			j.Lock()
			j.imported += imp
			j.skipped += skip
			j.failed += fail
			j.Unlock()
		}

		j.Lock()
		j.pages++
		processed := j.imported + j.skipped + j.failed
		j.Unlock()

		if len(batch) < 100 || processed >= maxTickets {
			return
		}
		offset += 100
	}
}

// upsertZohoTicket maps one Zoho ticket into helpdesk_tickets (tagged
// source_system='zoho_desk') and upserts on ticket_ref. Returns 0/1 counters.
func upsertZohoTicket(ctx context.Context, db *core.DB, t map[string]any, statusMap, priorityMap map[string]string) (imported, skipped, failed int) {
	zohoID := zohoStr(t["id"])
	if zohoID == "" {
		return 0, 1, 0
	}
	ref := "ZOHO-" + zohoID

	subject := zohoStr(t["subject"])
	if subject == "" {
		subject = "(no subject)"
	}
	body := zohoStr(t["description"])

	status := statusMap[strings.ToLower(zohoStr(t["status"]))]
	if status == "" {
		status = "open"
	}
	priority := priorityMap[strings.ToLower(zohoStr(t["priority"]))]
	if priority == "" {
		priority = "normal"
	}
	channel := channelFromZoho(zohoStr(t["channel"]))
	if channel == "" {
		channel = "web"
	}

	dept := zohoStr(t["departmentName"])
	createdAt := zohoParseTime(t["createdTime"])
	if createdAt.IsZero() {
		createdAt = time.Now()
	}
	var resolvedAt, closedAt *time.Time
	if ra := zohoParseTime(t["resolvedTime"]); !ra.IsZero() {
		resolvedAt = &ra
	}
	if ca := zohoParseTime(t["closedTime"]); !ca.IsZero() {
		closedAt = &ca
	}

	// SLA + type — Zoho carries these on the ticket (dueDate / category), but they
	// were never mapped, which is why sla_due_at and ticket_type were 100% NULL and
	// the SLA badges/overdue feed had nothing to show. Map the resolution SLA due
	// date and the Zoho category (+ sub-category) into our fields.
	var slaDue *time.Time
	if dd := zohoParseTime(t["dueDate"]); !dd.IsZero() {
		slaDue = &dd
	}
	ticketType := strings.TrimSpace(zohoStr(t["category"]))
	if sc := strings.TrimSpace(zohoStr(t["subCategory"])); sc != "" {
		if ticketType != "" {
			ticketType = ticketType + " / " + sc
		} else {
			ticketType = sc
		}
	}

	var custName, custEmail, custPhone string
	if contact, ok := t["contact"].(map[string]any); ok {
		custName = strings.TrimSpace(zohoStr(contact["firstName"]) + " " + zohoStr(contact["lastName"]))
		custEmail = zohoStr(contact["email"])
		custPhone = zohoStr(contact["phone"])
	}

	// Ticket owner (assignee) — captured from Zoho and, where the agent has a
	// matching workspace account, linked to assigned_to so the ticket shows as owned.
	asgID, asgName, asgEmail := zohoAssignee(t)
	assignedTo := lookupUserIDByEmail(ctx, db, asgEmail)

	res, err := db.PGExec(ctx, `
		INSERT INTO helpdesk_tickets
		  (subject, description, channel, status, priority, department,
		   customer_name, customer_email, customer_phone,
		   ticket_ref, resolved_at, closed_at, created_at, updated_at, source_system,
		   zoho_assignee_id, zoho_assignee_name, zoho_assignee_email, assigned_to,
		   sla_due_at, ticket_type)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,'zoho_desk',
		   NULLIF($14,''),NULLIF($15,''),NULLIF($16,''),$17,
		   $18, NULLIF($19,''))
		ON CONFLICT (ticket_ref) DO UPDATE SET
		  status              = EXCLUDED.status,
		  priority            = EXCLUDED.priority,
		  channel             = EXCLUDED.channel,
		  resolved_at         = EXCLUDED.resolved_at,
		  closed_at           = EXCLUDED.closed_at,
		  updated_at          = EXCLUDED.updated_at,
		  zoho_assignee_id    = EXCLUDED.zoho_assignee_id,
		  zoho_assignee_name  = EXCLUDED.zoho_assignee_name,
		  zoho_assignee_email = EXCLUDED.zoho_assignee_email,
		  assigned_to         = COALESCE(EXCLUDED.assigned_to, helpdesk_tickets.assigned_to),
		  sla_due_at          = COALESCE(EXCLUDED.sla_due_at, helpdesk_tickets.sla_due_at),
		  ticket_type         = COALESCE(EXCLUDED.ticket_type, helpdesk_tickets.ticket_type)`,
		subject, body, channel, status, priority, dept,
		custName, custEmail, custPhone,
		ref, resolvedAt, closedAt, createdAt,
		asgID, asgName, asgEmail, assignedTo,
		slaDue, ticketType)
	if err != nil {
		slog.Warn("upsertZohoTicket: insert", "ref", ref, "err", err)
		return 0, 0, 1
	}
	if n, _ := res.RowsAffected(); n > 0 {
		return 1, 0, 0
	}
	return 0, 1, 0
}

// channelFromZoho maps a Zoho channel label to O3's widened channel vocabulary
// (migration 110). Returns "" for unknown labels so callers can pick a fallback.
func channelFromZoho(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "email":
		return "email"
	case "phone":
		return "call" // telephony is O3C's dominant channel
	case "sms":
		return "sms"
	case "whatsapp":
		return "whatsapp"
	case "chat":
		return "chat"
	case "web", "web form", "webform", "forums", "help center", "helpcenter":
		return "web"
	case "twitter", "x", "facebook", "instagram":
		return "social"
	default:
		return ""
	}
}

// zohoAssignee extracts the ticket owner from a Zoho ticket payload (requires
// the list/get call to include=assignee). Returns empty strings when unassigned.
func zohoAssignee(t map[string]any) (id, name, email string) {
	a, ok := t["assignee"].(map[string]any)
	if !ok {
		return "", "", ""
	}
	id = zohoStr(a["id"])
	name = strings.TrimSpace(zohoStr(a["firstName"]) + " " + zohoStr(a["lastName"]))
	if name == "" {
		name = strings.TrimSpace(zohoStr(a["name"]))
	}
	email = strings.TrimSpace(zohoStr(a["email"]))
	return id, name, email
}

// lookupUserIDByEmail returns the workspace user id for an email, or nil if no
// active account matches. Used to link a Zoho assignee to a real workspace user.
func lookupUserIDByEmail(ctx context.Context, db *core.DB, email string) *int64 {
	if strings.TrimSpace(email) == "" {
		return nil
	}
	rows, err := db.PGQuery(ctx,
		`SELECT id FROM o3c_users WHERE lower(email)=lower($1) LIMIT 1`, strings.TrimSpace(email))
	if err != nil || len(rows) == 0 {
		return nil
	}
	uid := toInt64(rows[0]["id"])
	if uid == 0 {
		return nil
	}
	return &uid
}

// zohoBackfillAssignees pages Zoho tickets (include=assignee), reports who each
// ticket is owned by in Zoho, and — with ?apply=true — backfills the local
// zoho_assignee_* columns and links assigned_to for agents with a workspace
// account. ?apply is omitted → read-only dry run (answers "who owns what").
// Params: order=asc|desc (default desc/newest-first), max=N (default 1000).
func zohoBackfillAssignees(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		if !zohoEnsureConfigured(ctx, db) {
			respondErr(w, 503, "Zoho is not configured")
			return
		}
		ensureHelpdeskColumns(ctx, db)

		apply := r.URL.Query().Get("apply") == "true"
		desc := r.URL.Query().Get("order") != "asc" // default: newest-first
		maxTickets := 1000
		if v := r.URL.Query().Get("max"); v != "" {
			if n, err := strconv.Atoi(v); err == nil && n > 0 {
				maxTickets = n
			}
		}
		sortBy := "-createdTime"
		if !desc {
			sortBy = "createdTime"
		}

		type agentAgg struct {
			Name   string `json:"name"`
			Email  string `json:"email"`
			Count  int    `json:"count"`
			Linked bool   `json:"linked_to_workspace_user"`
		}
		counts := map[string]int{}
		emails := map[string]string{}
		var scanned, assigned, unassigned, updated, linked int

		offset := 0
		for scanned < maxTickets {
			params := url.Values{
				"from":    {strconv.Itoa(offset)},
				"limit":   {"100"},
				"sortBy":  {sortBy},
				"include": {"assignee"},
			}
			result, err := zohoFetch(ctx, "tickets", params)
			if err != nil {
				respondErr(w, 502, "Zoho fetch failed: "+err.Error())
				return
			}
			batch := zohoItems(result)
			if len(batch) == 0 {
				break
			}
			for _, t := range batch {
				scanned++
				zohoID := zohoStr(t["id"])
				id, name, email := zohoAssignee(t)
				if name == "" {
					unassigned++
				} else {
					assigned++
					counts[name]++
					if email != "" {
						emails[name] = email
					}
				}
				if apply && zohoID != "" {
					uid := lookupUserIDByEmail(ctx, db, email)
					res, uerr := db.PGExec(ctx, `
						UPDATE helpdesk_tickets
						SET zoho_assignee_id=NULLIF($2,''),
						    zoho_assignee_name=NULLIF($3,''),
						    zoho_assignee_email=NULLIF($4,''),
						    assigned_to=COALESCE($5, assigned_to),
						    updated_at=NOW()
						WHERE ticket_ref=$1`,
						"ZOHO-"+zohoID, id, name, email, uid)
					if uerr == nil {
						if n, _ := res.RowsAffected(); n > 0 {
							updated++
							if uid != nil {
								linked++
							}
						}
					}
				}
				if scanned >= maxTickets {
					break
				}
			}
			if len(batch) < 100 {
				break
			}
			offset += 100
		}

		byAgent := make([]agentAgg, 0, len(counts))
		for n, c := range counts {
			em := emails[n]
			byAgent = append(byAgent, agentAgg{
				Name: n, Email: em, Count: c,
				Linked: lookupUserIDByEmail(ctx, db, em) != nil,
			})
		}
		sort.Slice(byAgent, func(i, j int) bool { return byAgent[i].Count > byAgent[j].Count })

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"applied":            apply,
			"scanned":            scanned,
			"assigned_in_zoho":   assigned,
			"unassigned_in_zoho": unassigned,
			"distinct_agents":    len(byAgent),
			"by_agent":           byAgent,
			"rows_updated":       updated,
			"linked_to_users":    linked,
		})
	}
}

// zohoRelinkAssignees links helpdesk_tickets.assigned_to to the workspace user
// whose email matches the captured zoho_assignee_email. Pure set-based UPDATE —
// no Zoho paging — so it completes in one shot over every already-captured
// ticket. Idempotent; only fills unlinked rows. ?dry_run=true reports the count
// that would link without writing.
func zohoRelinkAssignees(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		dryRun := r.URL.Query().Get("dry_run") == "true"

		if dryRun {
			var n int64
			rows, _ := db.PGQuery(ctx, `
				SELECT COUNT(*) AS n
				FROM helpdesk_tickets t
				JOIN o3c_users u ON lower(t.zoho_assignee_email) = lower(u.email)
				WHERE u.deleted_at IS NULL AND u.is_active = TRUE
				  AND t.assigned_to IS NULL
				  AND t.zoho_assignee_email IS NOT NULL`)
			if len(rows) > 0 {
				n = toInt64(rows[0]["n"])
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]any{"dry_run": true, "would_link": n}) //nolint:errcheck
			return
		}

		res, err := db.PGExec(ctx, `
			UPDATE helpdesk_tickets t
			SET assigned_to = u.id, updated_at = NOW()
			FROM o3c_users u
			WHERE lower(t.zoho_assignee_email) = lower(u.email)
			  AND u.deleted_at IS NULL AND u.is_active = TRUE
			  AND t.assigned_to IS NULL
			  AND t.zoho_assignee_email IS NOT NULL`)
		if err != nil {
			respondErr(w, 500, "relink failed: "+err.Error())
			return
		}
		linked, _ := res.RowsAffected()
		var totalLinked int64
		if rows, _ := db.PGQuery(ctx, `SELECT COUNT(*) AS n FROM helpdesk_tickets WHERE assigned_to IS NOT NULL`); len(rows) > 0 {
			totalLinked = toInt64(rows[0]["n"])
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"linked_now":         linked,
			"total_linked_after": totalLinked,
		})
	}
}

// ── Zoho Desk — onboard agents as workspace users ────────────────────────────

type provisionResult struct {
	Email     string `json:"email"`
	Name      string `json:"name"`
	Status    string `json:"status"` // created | exists | would_create | error
	EmailSent bool   `json:"email_sent"`
	Detail    string `json:"detail,omitempty"`
}

// provisionWorkspaceUser creates one workspace user and sends the temp-password
// login email — the same flow as the admin "create user" endpoint. Idempotent:
// an existing email is left untouched (status "exists").
func provisionWorkspaceUser(ctx context.Context, db *core.DB, first, last, email, role, dept string) provisionResult {
	email = strings.TrimSpace(strings.ToLower(email))
	name := strings.TrimSpace(first + " " + last)
	pr := provisionResult{Email: email, Name: name}
	if email == "" || strings.TrimSpace(first) == "" {
		pr.Status = "error"
		pr.Detail = "missing email or first name"
		return pr
	}
	if ex, _ := db.PGQuery(ctx, `SELECT id FROM o3c_users WHERE lower(email)=lower($1) AND deleted_at IS NULL`, email); len(ex) > 0 {
		pr.Status = "exists"
		return pr
	}
	tempPW := genPassword()
	hash, err := core.HashPassword(tempPW)
	if err != nil {
		pr.Status = "error"
		pr.Detail = "password hash failed"
		return pr
	}
	rows, err := db.PGQuery(ctx, `
		INSERT INTO o3c_users (email, password_hash, full_name, first_name, last_name, role, department, must_change_password)
		VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE)
		RETURNING id`, email, hash, name, first, last, role, dept)
	if err != nil || len(rows) == 0 {
		pr.Status = "error"
		if err != nil {
			pr.Detail = err.Error()
		}
		return pr
	}
	uid := toInt64(rows[0]["id"])
	mailRes := SendTemporaryPasswordEmail(ctx, db, email, name, tempPW, uid)
	pr.Status = "created"
	pr.EmailSent = mailRes.OK
	if !mailRes.OK {
		pr.Detail = mailRes.Error
	}
	return pr
}

// zohoOnboardAgents pulls the Zoho Desk agent roster and provisions a workspace
// account + login email for each ACTIVE agent that doesn't already have one.
// Dry-run by default; ?apply=true performs the creation and sends emails.
// ?role= overrides the role (default call_center_agent); ?include_disabled=true
// also onboards non-active agents.
func zohoOnboardAgents(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		if !zohoEnsureConfigured(ctx, db) {
			respondErr(w, 503, "Zoho is not configured")
			return
		}
		apply := r.URL.Query().Get("apply") == "true"
		includeDisabled := r.URL.Query().Get("include_disabled") == "true"
		role := r.URL.Query().Get("role")
		if role == "" {
			role = "call_center_agent"
		}

		result, err := zohoFetch(ctx, "agents", url.Values{"limit": {"200"}})
		if err != nil {
			respondErr(w, 502, "Zoho agents fetch failed: "+err.Error())
			return
		}
		agents := zohoItems(result)

		out := make([]provisionResult, 0, len(agents))
		var considered, created, skipped, failed int
		for _, a := range agents {
			status := strings.ToUpper(strings.TrimSpace(zohoStr(a["status"])))
			if !includeDisabled && status != "" && status != "ACTIVE" {
				continue
			}
			considered++
			first := zohoStr(a["firstName"])
			last := zohoStr(a["lastName"])
			email := zohoStr(a["emailId"])
			if email == "" {
				email = zohoStr(a["email"])
			}
			name := strings.TrimSpace(first + " " + last)

			if !apply {
				st := "would_create"
				if strings.TrimSpace(email) == "" || strings.TrimSpace(first) == "" {
					st = "error"
				} else if ex, _ := db.PGQuery(ctx, `SELECT id FROM o3c_users WHERE lower(email)=lower($1) AND deleted_at IS NULL`, strings.ToLower(strings.TrimSpace(email))); len(ex) > 0 {
					st = "exists"
				}
				out = append(out, provisionResult{Email: strings.ToLower(strings.TrimSpace(email)), Name: name, Status: st})
				continue
			}

			pr := provisionWorkspaceUser(ctx, db, first, last, email, role, "Call Centre")
			switch pr.Status {
			case "created":
				created++
			case "exists":
				skipped++
			default:
				failed++
			}
			out = append(out, pr)
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"applied":         apply,
			"role":            role,
			"agents_in_zoho":  len(agents),
			"considered":      considered,
			"created":         created,
			"skipped_exists":  skipped,
			"failed":          failed,
			"results":         out,
		})
	}
}

// ── Zoho Desk — import conversation threads ──────────────────────────────────

// zohoFetchConversations returns the combined thread/comment timeline for a ticket.
func zohoFetchConversations(ctx context.Context, ticketZohoID string) ([]map[string]any, error) {
	result, err := zohoFetch(ctx, "tickets/"+ticketZohoID+"/conversations", url.Values{"limit": {"100"}})
	if err != nil {
		return nil, err
	}
	raw, _ := result["data"].([]any)
	out := make([]map[string]any, 0, len(raw))
	for _, it := range raw {
		if m, ok := it.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out, nil
}

// zohoImportThreads backfills helpdesk_messages from Zoho ticket conversations
// for tickets already imported (source_system='zoho_desk'). Call-channel tickets
// are skipped by default — their content is the call log — so we don't spend an
// API call per phone ticket; pass ?include_calls=true to fetch every ticket.
// ?max= caps how many tickets are processed in one run.
func zohoImportThreads(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !zohoEnsureConfigured(r.Context(), db) {
			respondErr(w, 503, "Zoho credentials not configured")
			return
		}
		includeCalls := r.URL.Query().Get("include_calls") == "true"
		maxTickets := 100000
		if v := r.URL.Query().Get("max"); v != "" {
			if n, perr := strconv.Atoi(v); perr == nil && n > 0 {
				maxTickets = n
			}
		}
		startZohoJob("threads", w, func(ctx context.Context, j *zohoJob) {
			runZohoThreadImportJob(ctx, db, j, includeCalls, maxTickets)
		})
	}
}

// runZohoThreadImportJob backfills helpdesk_messages from Zoho ticket
// conversations, one API call per candidate ticket, on a background context.
func runZohoThreadImportJob(ctx context.Context, db *core.DB, j *zohoJob, includeCalls bool, maxTickets int) {
	ensureHelpdeskColumns(ctx, db)

	q := `SELECT id, ticket_ref, channel FROM helpdesk_tickets
	       WHERE source_system='zoho_desk' AND ticket_ref LIKE 'ZOHO-%'`
	if !includeCalls {
		q += ` AND channel <> 'call'`
	}
	// Resume: skip tickets that already have an imported message, so a re-trigger
	// after a restart only processes the ones still missing conversations.
	q += ` AND NOT EXISTS (
	         SELECT 1 FROM helpdesk_messages m
	         WHERE m.ticket_id = helpdesk_tickets.id AND m.source_system='zoho_desk')`
	q += ` ORDER BY id DESC LIMIT $1`
	rows, err := db.PGQuery(ctx, q, maxTickets)
	if err != nil {
		j.Lock()
		j.lastErr = "query tickets: " + err.Error()
		j.Unlock()
		return
	}

	for _, row := range rows {
		localID := toInt64(row["id"])
		ref := str(row["ticket_ref"])
		ticketChannel := str(row["channel"])
		zohoID := strings.TrimPrefix(ref, "ZOHO-")
		if zohoID == "" {
			continue
		}

		convs, cerr := zohoFetchConversations(ctx, zohoID)
		if cerr != nil {
			slog.Warn("zohoImportThreads: conversations", "ref", ref, "err", cerr)
			j.Lock()
			j.failed++
			j.lastErr = cerr.Error()
			j.Unlock()
			continue
		}
		j.Lock()
		j.processed++
		j.Unlock()

		for _, c := range convs {
			extID := zohoStr(c["id"])
			if extID == "" {
				j.Lock()
				j.skipped++
				j.Unlock()
				continue
			}

			isNote := strings.EqualFold(zohoStr(c["type"]), "comment") ||
				strings.EqualFold(zohoStr(c["visibility"]), "private")
			direction := "inbound"
			if isNote || strings.EqualFold(zohoStr(c["direction"]), "out") {
				direction = "outbound"
			}

			ch := channelFromZoho(zohoStr(c["channel"]))
			if ch == "" {
				ch = ticketChannel
			}

			var author string
			if a, ok := c["author"].(map[string]any); ok {
				author = zohoStr(a["name"])
			}
			body := zohoStr(c["summary"])
			createdAt := zohoParseTime(c["createdTime"])
			if createdAt.IsZero() {
				createdAt = time.Now()
			}

			res, ierr := db.PGExec(ctx, `
				INSERT INTO helpdesk_messages
				  (ticket_id, direction, channel, author_name, body_text,
				   is_internal_note, external_id, source_system, created_at)
				VALUES ($1,$2,$3,$4,$5,$6,$7,'zoho_desk',$8)
				ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO NOTHING`,
				localID, direction, ch, author, body, isNote, extID, createdAt)
			j.Lock()
			if ierr != nil {
				slog.Warn("zohoImportThreads: insert", "ext", extID, "err", ierr)
				j.failed++
			} else if n, _ := res.RowsAffected(); n > 0 {
				j.imported++
			} else {
				j.skipped++
			}
			j.Unlock()
		}
	}
}

// ── Zoho Desk — import call logs ─────────────────────────────────────────────

func zohoImportDeskCalls(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !zohoEnsureConfigured(r.Context(), db) {
			respondErr(w, 503, "Zoho credentials not configured")
			return
		}
		if err := ensureCallLogSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "Call log schema error")
			return
		}
		// Full migration by default; from_date/to_date narrow the window.
		from := r.URL.Query().Get("from_date")
		to := r.URL.Query().Get("to_date")
		if from == "" {
			from = "2000-01-01"
		}
		if to == "" {
			to = time.Now().Format("2006-01-02")
		}
		maxOffset := 1000000
		if v := r.URL.Query().Get("max_offset"); v != "" {
			if n, perr := strconv.Atoi(v); perr == nil && n > 0 {
				maxOffset = n
			}
		}
		startZohoJob("calls", w, func(ctx context.Context, j *zohoJob) {
			runZohoDeskCallImportJob(ctx, db, j, from, to, maxOffset)
			// Record the outcome so a manual "Sync now" also advances the sync state.
			if j.lastErr != "" {
				recordZohoSyncResult(ctx, db, "calls", j.imported, fmt.Errorf("%s", j.lastErr))
			} else {
				recordZohoSyncResult(ctx, db, "calls", j.imported, nil)
			}
		})
	}
}

// runZohoDeskCallImportJob pages through Zoho Desk call logs (background context)
// and upserts them into helpdesk_calls tagged source_system='zoho_desk'.
func runZohoDeskCallImportJob(ctx context.Context, db *core.DB, j *zohoJob, from, to string, maxOffset int) {
	offset := 0
	pageSize := 100

	// The Zoho Desk call record identifies the customer only by contactId and
	// embeds the phone number in the subject. Resolve contactId -> our crm_contacts
	// (imported with external_id = the Zoho contact id) to recover name/phone/CIF.
	phoneRe := regexp.MustCompile(`\+?\d[\d ]{6,}\d`)
	contactCache := map[string][3]string{}
	resolveContact := func(cid string) (name, phone, cif string) {
		if v, ok := contactCache[cid]; ok {
			return v[0], v[1], v[2]
		}
		if rows, _ := db.PGQuery(ctx, `
			SELECT trim(concat(coalesce(first_name,''),' ',coalesce(last_name,''))) AS name,
			       coalesce(phone,'') AS phone, coalesce(cif_number,'') AS cif
			FROM crm_contacts WHERE source='zoho_desk' AND external_id=$1 LIMIT 1`, cid); len(rows) > 0 {
			name = strings.TrimSpace(str(rows[0]["name"]))
			phone = str(rows[0]["phone"])
			cif = str(rows[0]["cif"])
		}
		contactCache[cid] = [3]string{name, phone, cif}
		return name, phone, cif
	}

	// Zoho agent map: agent id -> (name, email). Calls carry ownerId (the true call
	// owner); the agents endpoint gives id -> name/email, letting us attribute each
	// call to the right agent and link it to a workspace user by email.
	type zAgent struct{ name, email string }
	agentMap := map[string]zAgent{}
	if ares, aerr := zohoFetch(ctx, "agents", url.Values{"limit": {"200"}}); aerr == nil {
		for _, a := range zohoItems(ares) {
			id := zohoStr(a["id"])
			if id == "" {
				continue
			}
			name := strings.TrimSpace(zohoStr(a["name"]))
			if name == "" {
				name = strings.TrimSpace(zohoStr(a["firstName"]) + " " + zohoStr(a["lastName"]))
			}
			agentMap[id] = zAgent{name: name, email: strings.ToLower(strings.TrimSpace(zohoStr(a["emailId"])))}
		}
	}
	userByEmail := map[string]int64{}
	resolveAgentUser := func(email string) *int64 {
		if email == "" {
			return nil
		}
		if v, ok := userByEmail[email]; ok {
			if v == 0 {
				return nil
			}
			return &v
		}
		var id int64
		if rows, _ := db.PGQuery(ctx, `SELECT id FROM o3c_users WHERE lower(email)=$1 AND deleted_at IS NULL LIMIT 1`, email); len(rows) > 0 {
			id = toInt64(rows[0]["id"])
		}
		userByEmail[email] = id
		if id == 0 {
			return nil
		}
		return &id
	}

	for {
		params := url.Values{
			"from":   {fmt.Sprintf("%d", offset)},
			"limit":  {fmt.Sprintf("%d", pageSize)},
			"sortBy": {"-createdTime"}, // newest first, so a bounded sweep covers the recent window
		}
		result, err := zohoFetch(ctx, "calls", params)
		if err != nil {
			j.Lock()
			j.lastErr = err.Error()
			j.Unlock()
			slog.Error("zohoImportDeskCalls job: fetch", "offset", offset, "err", err)
			return
		}
		batch := zohoItems(result)
		if len(batch) == 0 {
			return
		}

		for _, c := range batch {
			imp, skip, fail := 0, 0, 0
			func() {
				zohoID := zohoStr(c["id"])
				if zohoID == "" {
					skip = 1
					return
				}

				// Zoho Desk call API uses createdTime; callStartTime may also appear.
				// Try multiple fields and both RFC3339 and millisecond formats.
				startedAt := zohoParseTime(c["createdTime"])
				if startedAt.IsZero() {
					startedAt = zohoParseTime(c["callStartTime"])
				}
				if startedAt.IsZero() {
					startedAt = zohoParseMillisTime(c["callStartTime"])
				}
				if startedAt.IsZero() {
					startedAt = zohoParseTime(c["startTime"])
				}
				if startedAt.IsZero() {
					// skip rather than store a wrong date
					skip = 1
					return
				}
				dateStr := startedAt.Format("2006-01-02")
				if dateStr < from || dateStr > to {
					skip = 1
					return
				}

				// Direction — Zoho's field is clean ("inbound"/"outbound"). When absent,
				// infer from the subject ("Outgoing call to …" / "Incoming call …") so
				// outbound calls are never silently mislabeled inbound; last-resort
				// default is outbound (this is an outbound-dominant call center).
				direction := strings.ToLower(strings.TrimSpace(zohoStr(c["direction"])))
				if direction != "inbound" && direction != "outbound" {
					subj := strings.ToLower(zohoStr(c["subject"]))
					switch {
					case strings.Contains(subj, "outgoing"), strings.Contains(subj, "outbound"):
						direction = "outbound"
					case strings.Contains(subj, "incoming"), strings.Contains(subj, "inbound"):
						direction = "inbound"
					default:
						// Don't silently label ambiguous calls "outbound" — mark unknown.
						direction = "unknown"
					}
				}

				// Outcome from status ("Missed", "Answered", etc).
				st := strings.ToLower(zohoStr(c["status"]))
				outcome := "completed"
				if strings.Contains(st, "miss") || strings.Contains(st, "unanswer") ||
					strings.Contains(st, "no answer") || strings.Contains(st, "abandon") ||
					strings.Contains(st, "declin") {
					outcome = "missed"
				}
				
				// Duration = completedTime - startTime (no explicit duration field).
				// Cap at 4h: some Zoho records carry a bogus completedTime (call left
				// open and closed days later), yielding absurd multi-day durations that
				// would poison talk-time averages. Above the cap → leave duration unknown.
				var durSec *int
				if comp := zohoParseTime(c["completedTime"]); !comp.IsZero() && comp.After(startedAt) {
					d := int(comp.Sub(startedAt).Seconds())
					if d >= 0 && d <= 14400 {
						durSec = &d
					}
				}
				
				// Agent — prefer the call owner (ownerId) resolved via the Zoho agent
				// map; fall back to modifiedBy. Link to a workspace user by email so
				// per-agent stats can join on agent_id, not just a free-text name.
				agentName, agentEmail := "", ""
				if ownerID := zohoStr(c["ownerId"]); ownerID != "" {
					if a, ok := agentMap[ownerID]; ok {
						agentName, agentEmail = a.name, a.email
					}
				}
				if mb, ok := c["modifiedBy"].(map[string]any); ok {
					if agentName == "" {
						agentName = strings.TrimSpace(zohoStr(mb["firstName"]) + " " + zohoStr(mb["lastName"]))
					}
					if agentEmail == "" {
						agentEmail = strings.ToLower(strings.TrimSpace(zohoStr(mb["emailId"])))
					}
				}
				agentID := resolveAgentUser(agentEmail)

				// Customer via the Zoho contact id -> crm_contacts; phone falls back to subject.
				var custName, custPhone, custCIF string
				if cid := zohoStr(c["contactId"]); cid != "" {
					custName, custPhone, custCIF = resolveContact(cid)
				}
				if !isNameLike(custName) {
					custName = ""
				}
				if custPhone == "" {
					if m := phoneRe.FindString(zohoStr(c["subject"])); m != "" {
						custPhone = strings.ReplaceAll(m, " ", "")
					}
				}
				
				// Purpose is derived in-SQL (indexed norm_phone lookups): inbound -> support;
				// a known customer (cif/phone) -> collections; a known lead phone -> marketing;
				// otherwise outbound telesales -> marketing. Retention is set explicitly by
				// agents/campaigns, never inferred here.
				res, err := db.PGExec(ctx, `
					INSERT INTO helpdesk_calls
					  (agent_name, agent_id, customer_name, customer_phone, customer_cif, direction,
					   duration_sec, outcome, started_at, zoho_call_id, purpose, source_system)
					  VALUES ($1,$2,$3,$4,
					    -- resolve CIF by phone against the customer master when Zoho gave none
					    COALESCE(NULLIF($5,''), (SELECT c.cif FROM app.customers c
					       WHERE app.norm_phone($4) <> '' AND app.norm_phone(c.phone) = app.norm_phone($4)
					       LIMIT 1)),
					    $6,$7,$8,$9,$10,
					    CASE
					      WHEN $6 = 'inbound' THEN 'support'
					      WHEN ($5 <> '' AND EXISTS (SELECT 1 FROM app.customers c WHERE c.cif = $5))
					        OR (app.norm_phone($4) <> '' AND EXISTS (
					              SELECT 1 FROM app.customers c WHERE app.norm_phone(c.phone) = app.norm_phone($4)))
					        THEN 'collections'
					      WHEN app.norm_phone($4) <> '' AND EXISTS (
					              SELECT 1 FROM app.crm_contacts l WHERE app.norm_phone(l.phone) = app.norm_phone($4))
					        THEN 'marketing'
					      ELSE 'marketing'
					    END,
					    'zoho_desk')
					ON CONFLICT (zoho_call_id) WHERE zoho_call_id IS NOT NULL DO UPDATE SET
					  agent_name     = EXCLUDED.agent_name,
					  agent_id       = COALESCE(EXCLUDED.agent_id, helpdesk_calls.agent_id),
					  customer_name  = EXCLUDED.customer_name,
					  customer_phone = EXCLUDED.customer_phone,
					  customer_cif   = EXCLUDED.customer_cif,
					  direction      = EXCLUDED.direction,
					  duration_sec   = EXCLUDED.duration_sec,
					  outcome        = EXCLUDED.outcome,
					  started_at     = EXCLUDED.started_at,
					  purpose        = COALESCE(helpdesk_calls.purpose, EXCLUDED.purpose)`,
					agentName, agentID, custName, custPhone, custCIF, direction,
					durSec, outcome, startedAt, zohoID)
				if err != nil {
					slog.Warn("zohoImportDeskCalls: insert", "zoho_id", zohoID, "err", err)
					fail = 1
				} else if n, _ := res.RowsAffected(); n > 0 {
					imp = 1
				} else {
					skip = 1
				}
			}()

			j.Lock()
			j.imported += imp
			j.skipped += skip
			j.failed += fail
			j.Unlock()
		}

		j.Lock()
		j.pages++
		j.Unlock()

		if len(batch) < pageSize {
			return
		}
		offset += pageSize
		if offset > maxOffset {
			return
		}
	}
}

// ── Zoho Desk — import contacts ──────────────────────────────────────────────

// zohoImportContacts starts a background import of Zoho Desk contacts into
// crm_contacts, tagged source='zoho_desk' with the Zoho id as external_id. All
// contacts land as status='lead' (prospect); a later match pass promotes those
// found in the customer master to status='customer'. ?max= caps the count.
func zohoImportContacts(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !zohoEnsureConfigured(r.Context(), db) {
			respondErr(w, 503, "Zoho credentials not configured")
			return
		}
		maxContacts := 1000000
		if v := r.URL.Query().Get("max"); v != "" {
			if n, perr := strconv.Atoi(v); perr == nil && n > 0 {
				maxContacts = n
			}
		}
		startZohoJob("contacts", w, func(ctx context.Context, j *zohoJob) {
			runZohoContactImportJob(ctx, db, j, maxContacts)
		})
	}
}

// runZohoContactImportJob pages through Zoho contacts (background context) and
// upserts them into crm_contacts as prospects, keeping status untouched on
// re-import so a later customer-promotion isn't undone.
func runZohoContactImportJob(ctx context.Context, db *core.DB, j *zohoJob, maxContacts int) {
	pageSize := 100
	// Resume from the DB high-water mark (contacts import oldest-first, monotonic).
	offset := 0
	if rows, err := db.PGQuery(ctx, `SELECT COUNT(*) AS c FROM crm_contacts WHERE source='zoho_desk'`); err == nil && len(rows) > 0 {
		offset = (int(toInt64(rows[0]["c"])) / pageSize) * pageSize
	}

	for {
		params := url.Values{
			"from":    {strconv.Itoa(offset)},
			"limit":   {strconv.Itoa(pageSize)},
			"include": {"accounts"},
		}
		result, err := zohoFetch(ctx, "contacts", params)
		if err != nil {
			j.Lock()
			j.lastErr = err.Error()
			j.Unlock()
			slog.Error("zohoImportContacts job: fetch", "offset", offset, "err", err)
			return
		}
		batch := zohoItems(result)
		if len(batch) == 0 {
			return
		}

		for _, c := range batch {
			imp, skip, fail := upsertZohoContact(ctx, db, c)
			j.Lock()
			j.imported += imp
			j.skipped += skip
			j.failed += fail
			j.Unlock()
		}

		j.Lock()
		j.pages++
		processed := j.imported + j.skipped + j.failed
		j.Unlock()

		if len(batch) < pageSize || processed >= maxContacts {
			return
		}
		offset += pageSize
	}
}

// upsertZohoContact maps one Zoho contact into crm_contacts. It never changes an
// existing row's status (so a promoted 'customer' stays a customer on re-import).
func upsertZohoContact(ctx context.Context, db *core.DB, c map[string]any) (imported, skipped, failed int) {
	zohoID := zohoStr(c["id"])
	if zohoID == "" {
		return 0, 1, 0
	}

	fn := strings.TrimSpace(zohoStr(c["firstName"]))
	ln := strings.TrimSpace(zohoStr(c["lastName"]))
	if fn == "" && ln == "" {
		ln = "(no name)"
	}

	phone := zohoStr(c["phone"])
	if phone == "" {
		phone = zohoStr(c["mobile"])
	}
	email := zohoStr(c["email"])

	var notes *string
	if acc, ok := c["account"].(map[string]any); ok {
		if name := zohoStr(acc["accountName"]); name != "" {
			n := "Zoho account: " + name
			notes = &n
		}
	}

	createdAt := zohoParseTime(c["createdTime"])
	if createdAt.IsZero() {
		createdAt = time.Now()
	}

	res, err := db.PGExec(ctx, `
		INSERT INTO crm_contacts
		  (first_name, last_name, phone, email, source, external_id, status, notes, created_at, updated_at)
		VALUES ($1,$2,NULLIF($3,''),NULLIF($4,''),'zoho_desk',$5,'lead',$6,$7,$7)
		ON CONFLICT (source, external_id) WHERE external_id IS NOT NULL DO UPDATE SET
		  first_name = EXCLUDED.first_name,
		  last_name  = EXCLUDED.last_name,
		  phone      = COALESCE(EXCLUDED.phone, crm_contacts.phone),
		  email      = COALESCE(EXCLUDED.email, crm_contacts.email),
		  updated_at = EXCLUDED.updated_at`,
		fn, ln, phone, email, zohoID, notes, createdAt)
	if err != nil {
		slog.Warn("upsertZohoContact: insert", "zoho_id", zohoID, "err", err)
		return 0, 0, 1
	}
	if n, _ := res.RowsAffected(); n > 0 {
		return 1, 0, 0
	}
	return 0, 1, 0
}

// ── Zoho Voice — initiate outbound call ──────────────────────────────────────

// zohoInitiateCall fetches a fresh per-user Zoho Voice access token and returns
// it to the frontend alongside the Zoho data-centre region.  The actual call is
// placed browser-side by the Zoho Voice WebSDK — the Desk REST API is a call-log
// endpoint only and cannot initiate a dial.
func zohoInitiateCall(db *core.DB) http.HandlerFunc {
	type reqBody struct {
		PhoneNumber string `json:"phone_number"`
		TicketID    *int64 `json:"ticket_id"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b reqBody
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.PhoneNumber == "" {
			respondErr(w, 422, "phone_number is required")
			return
		}
		if err := ensureCallLogSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "Call log setup failed")
			return
		}

		ctx := r.Context()
		user := core.UserFromCtx(ctx)

		// Fetch / refresh the agent's personal Zoho Voice token + agent ID.
		callToken := ""
		agentVoiceID := ""
		if user != nil {
			rows, _ := db.PGQuery(ctx,
				`SELECT zoho_voice_access_token, zoho_voice_token_expiry, zoho_voice_refresh_token, zoho_voice_agent_id
				 FROM o3c_users WHERE id=$1`, user.ID)
			if len(rows) > 0 {
				encAccess, _ := rows[0]["zoho_voice_access_token"].(string)
				expiry, _ := rows[0]["zoho_voice_token_expiry"].(time.Time)
				encRefresh, _ := rows[0]["zoho_voice_refresh_token"].(string)
				agentVoiceID, _ = rows[0]["zoho_voice_agent_id"].(string)
				if encAccess != "" && time.Now().Add(60*time.Second).Before(expiry) {
					callToken, _ = decryptValue(encAccess)
				} else if encRefresh != "" {
					if rt, _ := decryptValue(encRefresh); rt != "" {
						if newAccess, newExpiry, err := voiceRefreshUserToken(ctx, rt); err == nil {
							callToken = newAccess
							if enc, err := encryptValue(newAccess); err == nil {
								db.PGExec(ctx, //nolint:errcheck
									`UPDATE o3c_users SET zoho_voice_access_token=$1, zoho_voice_token_expiry=$2 WHERE id=$3`,
									enc, newExpiry, user.ID)
							}
						}
					}
				}
			}
		}

		if callToken == "" {
			respondErr(w, 403, "Zoho Voice not connected — go to Settings and connect your account")
			return
		}

		// Log the outbound call attempt.
		agentName := ""
		if user != nil {
			agentName = user.FullName
		}
		db.PGExec(ctx, `
			INSERT INTO helpdesk_calls (agent_name, customer_phone, direction, outcome, ticket_id)
			VALUES ($1,$2,'outbound','in_progress',$3)`,
			agentName, b.PhoneNumber, b.TicketID) //nolint:errcheck

		// Return token + agent ID to the frontend — the Zoho Voice WebSDK handles the actual dial.
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{ //nolint:errcheck
			"access_token": callToken,
			"agent_id":     agentVoiceID,
			"dc":           zohoDC,
			"phone_number": b.PhoneNumber,
		})
	}
}

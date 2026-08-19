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

	// Agent crosswalk — unmatched Zoho agents + one-click mapping to workspace users.
	r.Get("/unmatched-agents", zohoUnmatchedAgents(db))
	r.Post("/map-agent", zohoMapAgent(db))

	// Voice routes require call_center page permission — these initiate or import live calls.
	cc := core.RequirePages("call_center")
	r.With(cc).Post("/voice/import-logs", zohoImportVoiceLogs(db))
	r.With(cc).Post("/voice/call", zohoInitiateCall(db))
	r.With(cc).Get("/voice/token", voiceTokenHandler(db))
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
	token, err := zohoVoiceAccessToken(ctx, db)
	if err != nil {
		return 0, 0, 0, fmt.Errorf("voice token error: %w", err)
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
			// This importer's job is recordings, not another copy of the call log.
			// The Desk /calls sync already owns the call ledger (~110k rows); Zoho
			// Voice is where the AUDIO lives. So we only care about logs that carry a
			// recording, and we ATTACH that recording onto the matching Desk row
			// rather than insert a duplicate.
			cr, _ := c["call_recording"].(map[string]any)
			recFile := ""
			if cr != nil {
				recFile = strings.TrimSpace(zohoStr(cr["recording_filename"]))
			}
			if recFile == "" {
				skipped++ // unanswered / no recording — nothing to attach
				continue
			}

			voiceID := zohoStr(c["logid"])
			direction := "inbound"
			if strings.Contains(strings.ToLower(zohoStr(c["call_type"])), "out") {
				direction = "outbound"
			}
			// The customer is the far end of the call: the destination on an outbound
			// call, the caller on an inbound one.
			custPhone := zohoStr(c["destination_number"])
			if direction == "inbound" {
				custPhone = zohoStr(c["caller_id_number"])
			}
			last10 := normalizePhone(custPhone)
			didNum := zohoStr(c["did_number"])
			startedAt := zohoParseMillisTime(c["start_time"])
			if startedAt.IsZero() || last10 == "" {
				// Without a usable phone + timestamp there is no safe way to match a
				// recording to the right call — skip rather than mis-attach.
				skipped++
				continue
			}
			// Voice knows how long the conversation actually lasted. Desk does not:
			// its duration is completedTime − startTime on the RECORD, a proxy. So
			// this value is used twice — to pick the right row, and to correct it.
			voiceDur := zohoCallDuration(c)

			// Attach to the RIGHT Desk call: same direction, same customer number
			// (last 10 digits — the app's canonical phone key), within a 3-minute
			// window. Purely additive: only fills a row whose recording_filename is
			// still NULL, so re-running never disturbs an existing attachment.
			//
			// Ordering by time alone put recordings on the wrong row. Agents redial,
			// so one conversation leaves several Desk rows seconds apart — this
			// sequence on a single number today:
			//
			//     10:48:08   34s   recorded
			//     10:48:46    1s   recorded
			//     10:49:10  548s   NOT recorded   ← the actual 9-minute call
			//
			// A 1-second blip sat closer in time to some recording than the real
			// conversation did, took the slot, and the 548-second call was left with
			// nothing. Duration is the far stronger signal: match on how long the
			// call lasted first, and fall back to time only when a duration cannot be
			// compared (uncomparable rows sort last via the large sentinel).
			//
			// Voice duration also CORRECTS the row. Desk's duration is
			// completedTime − startTime on the record; Voice measured the
			// conversation. Where they disagree, Voice is right.
			res, upErr := db.PGExec(ctx, `
				UPDATE helpdesk_calls h
				   SET recording_filename = $1,
				       zoho_voice_id      = COALESCE(h.zoho_voice_id, NULLIF($2,'')),
				       call_to            = COALESCE(NULLIF(h.call_to,''), NULLIF($3,'')),
				       duration_sec       = COALESCE(NULLIF($7, 0), h.duration_sec)
				 WHERE h.id = (
				   SELECT id FROM helpdesk_calls
				    WHERE recording_filename IS NULL
				      AND direction = $4
				      AND `+normalizedPhoneExpr("customer_phone")+` = $5
				      AND started_at BETWEEN $6::timestamptz - interval '180 seconds'
				                         AND $6::timestamptz + interval '180 seconds'
				      -- Already attached elsewhere? Then this recording is placed; skip
				      -- it so the hourly re-sync is a true no-op instead of matching a
				      -- different row and colliding on the unique zoho_voice_id.
				      AND NOT EXISTS (SELECT 1 FROM helpdesk_calls z WHERE z.zoho_voice_id = $2)
				    ORDER BY
				      CASE WHEN $7 > 0 AND duration_sec IS NOT NULL
				           THEN abs(duration_sec - $7) ELSE 999999 END ASC,
				      abs(extract(epoch FROM (started_at - $6::timestamptz))) ASC
				    LIMIT 1
				 )`,
				recFile, voiceID, didNum, direction, last10, startedAt, voiceDur)
			if upErr != nil {
				slog.Warn("runZohoVoiceImport: attach", "voice_id", voiceID, "err", upErr)
				failed++
				continue
			}
			if n, _ := res.RowsAffected(); n > 0 {
				imported++ // recording attached to a Desk call
			} else {
				skipped++ // has audio, but no Desk row matched (blank-phone rows, etc.)
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
			// This org's OAuth grant is Zoho Desk + PhoneBridge (Desk.calls.ALL,
			// PhoneBridge.call.log) — NOT the standalone Zoho Voice product. The Voice
			// API therefore rejects the token with ZVT022 "Invalid OAuth scope". Calls
			// aren't missing: PhoneBridge telephony logs land in Zoho Desk and are
			// imported via the Desk /calls sync. Return that instead of a raw error.
			if strings.Contains(err.Error(), "ZVT022") || strings.Contains(strings.ToLower(err.Error()), "invalid oauth scope") {
				respondErr(w, 409, "Zoho Voice is not part of this Zoho plan (the token is scoped to Zoho Desk + PhoneBridge). Calls are logged in Zoho Desk and imported by the Desk call sync — no separate Voice import is needed.")
				return
			}
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
func runZohoVoiceSyncCycle(db *core.DB, cap int) {
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
	var imported, failed int
	var err error
	for i, wait := range backoffs {
		if wait > 0 {
			time.Sleep(wait)
		}
		imported, failed, err = runZohoDeskCallsHeadless(ctx, db, from, to, cap)
		if err == nil {
			// Fetch succeeded — but a high insert-failure rate is a silent-failure
			// alarm (see the customer_cif incident), so surface it as an error, not green.
			if spike, msg := zohoFailedSpike(imported, failed); spike {
				slog.Error("zoho auto-sync: HIGH INSERT-FAILURE RATE", "imported", imported, "failed", failed, "detail", msg)
				recordZohoSyncResult(ctx, db, "calls", imported, fmt.Errorf("%s", msg))
				WorkerBeat(ctx, db, "zoho_calls", "error", msg, msg)
			} else {
				slog.Info("zoho auto-sync: done", "imported", imported, "attempt", i+1)
				recordZohoSyncResult(ctx, db, "calls", imported, nil)
				WorkerBeat(ctx, db, "zoho_calls", "ok", fmt.Sprintf("%d imported", imported), "")
			}
			// Attach new Zoho Voice call recordings onto the Desk rows just synced.
			// Deep cycle only (hourly): recordings tolerate up to an hour of latency
			// and paging the Voice logs is comparatively expensive. Isolated from the
			// Desk result — a Voice failure is logged, never fails the call sync.
			if cap >= 1000 && zohoVoiceConfigured(ctx, db) {
				if att, skip, vfail, verr := runZohoVoiceImport(ctx, db, from, to); verr != nil {
					slog.Warn("zoho auto-sync: voice recordings", "err", verr)
				} else {
					slog.Info("zoho auto-sync: voice recordings", "attached", att, "skipped", skip, "failed", vfail)
				}
			}
			return
		}
		slog.Warn("zoho auto-sync: attempt failed", "attempt", i+1, "err", err)
	}
	slog.Error("zoho auto-sync: giving up this cycle (will retry next hour)", "err", err)
	recordZohoSyncResult(ctx, db, "calls", 0, err)
	WorkerBeat(ctx, db, "zoho_calls", "error", err.Error(), err.Error())
}

// runZohoDeskCallsHeadless runs the Zoho Desk call import for a date window without
// an HTTP response, reusing the shared "calls" job so it never collides with a
// manual import. Returns the count imported and any error the job recorded.
func runZohoDeskCallsHeadless(ctx context.Context, db *core.DB, from, to string, cap int) (imported, failed int, err error) {
	j := zohoJobs["calls"]
	j.Lock()
	if j.running {
		j.Unlock()
		return 0, 0, nil // a manual or prior auto import is already running; skip quietly
	}
	j.running, j.done = true, false
	j.imported, j.skipped, j.failed, j.pages = 0, 0, 0, 0
	j.startedAt, j.endedAt, j.lastErr = time.Now(), time.Time{}, ""
	j.Unlock()

	// Bounded sweep: newest-first, so the top `cap` calls always contain everything
	// new since the last run. The fast poll uses a small cap (recent minute); the
	// hourly reconcile uses a larger one. The 3-day `from` is a safety filter, not a
	// scan target.
	runZohoDeskCallImportJob(ctx, db, j, from, to, cap)

	j.Lock()
	imp, fail, lastErr := j.imported, j.failed, j.lastErr
	j.running, j.done, j.endedAt = false, true, time.Now()
	j.Unlock()
	if lastErr != "" {
		return imp, fail, fmt.Errorf("%s", lastErr)
	}
	return imp, fail, nil
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
		runZohoVoiceSyncCycle(db, 1000)
		// Fast incremental poll (small cap, near-real-time) + hourly deep reconcile
		// (large cap, catches anything the fast poll missed / late-arriving records).
		fast := time.NewTicker(zohoPollInterval())
		deep := time.NewTicker(1 * time.Hour)
		defer fast.Stop()
		defer deep.Stop()
		for {
			select {
			case <-fast.C:
				runZohoVoiceSyncCycle(db, 200)
			case <-deep.C:
				runZohoVoiceSyncCycle(db, 1000)
			}
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

		runZohoTicketSync(db, 2000)
		zohoSweepConversations(db, 300) // seed message bodies for the newest tickets
		// One-time backfill: drain message-less + summary-only tickets to full thread
		// content in gentle batches until caught up, then stop. Runs alongside (the
		// hourly deep sweep maintains it afterwards). Bounded so a bug can't loop forever.
		go func() {
			for i := 0; i < 80; i++ {
				if zohoSweepConversations(db, 100) < 100 {
					break // fewer than a full batch remained — backlog drained
				}
				time.Sleep(60 * time.Second)
			}
		}()
		// Fast incremental poll (recent tickets) + hourly deep reconcile.
		fast := time.NewTicker(zohoPollInterval())
		deep := time.NewTicker(1 * time.Hour)
		defer fast.Stop()
		defer deep.Stop()
		for {
			select {
			case <-fast.C:
				runZohoTicketSync(db, 100)
			case <-deep.C:
				runZohoTicketSync(db, 2000)
				zohoSweepConversations(db, 150)
			}
		}
	}()
}

// zohoSweepConversations backfills helpdesk_messages for the newest email/web/social
// tickets that still have no messages, so mail bodies and inbox previews populate
// automatically instead of only when an agent opens each mail. Bounded by cap and
// gated on Zoho being configured. (The ticket sync imports tickets but not threads.)
func zohoSweepConversations(db *core.DB, cap int) int {
	ctx := context.Background()
	if !zohoEnsureConfigured(ctx, db) {
		return 0
	}
	j := &zohoJob{}
	runZohoThreadImportJob(ctx, db, j, false, cap)
	j.Lock()
	n := j.processed
	j.Unlock()
	return n
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

	// Zoho's statuses mapped onto ours. helpdesk_tickets_status_check allows
	// open | pending | in_progress | resolved | closed, and nothing else.
	//
	// "escalated" is the trap: Zoho treats escalation as a STATUS, this workspace
	// treats it as a FLAG (escalated_at / escalated_by, set by our own escalation
	// flow). Mapping it through as "escalated" produced a constraint violation on
	// every such ticket, so they were dropped on import — silently, because the
	// importer logs a warning and moves on. 22 in the current log alone, and the
	// same ticket retried on every cycle.
	//
	// It maps to in_progress: a Zoho-escalated ticket is one somebody is actively
	// working. The escalation FLAG is deliberately not set from here — Zoho gives
	// no escalation timestamp in this payload, and inventing one would put a
	// fabricated time on a compliance-visible field.
	statusMap := map[string]string{
		"open": "open", "on hold": "pending", "escalated": "in_progress",
		"in progress": "in_progress", "on-hold": "pending",
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

	// Every value below is validated against what the table will actually accept,
	// not merely mapped. A mapping that produces something the constraint rejects
	// drops the ticket on import and only ever shows up as a warning in a log
	// nobody is reading — which is how 22 escalated tickets went missing. A wrong
	// but valid status is recoverable; a ticket that never arrived is not.
	status := coerceToAllowed(statusMap[strings.ToLower(zohoStr(t["status"]))],
		ticketStatuses, "open", "status", zohoStr(t["status"]))
	priority := coerceToAllowed(priorityMap[strings.ToLower(zohoStr(t["priority"]))],
		ticketPriorities, "normal", "priority", zohoStr(t["priority"]))
	channel := coerceToAllowed(channelFromZoho(zohoStr(t["channel"])),
		ticketChannels, "web", "channel", zohoStr(t["channel"]))

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

	// SLA + CSAT — Zoho carries no SLA/priority/category data for this org (dueDate,
	// category and priority are all null on every ticket), so compute our own SLA
	// deadlines from the ticket's created time + the active policy for its priority,
	// and mint a CSAT token so resolving the ticket can actually send a survey.
	slaDue, frtDue := hdSLATimesFrom(ctx, db, priority, createdAt)
	csatToken := hdNewUUID()
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
	// Resolve the assignee through the durable crosswalk (manual → email → name),
	// unifying ticket + call attribution and honouring manual mappings. Records the
	// agent in zoho_agent_map so ticket-only agents also surface in Agent Matching.
	assignedTo := zohoResolveAgent(ctx, db, asgID, asgEmail, asgName)

	rows, err := db.PGQuery(ctx, `
		INSERT INTO helpdesk_tickets
		  (subject, description, channel, status, priority, department,
		   customer_name, customer_email, customer_phone,
		   ticket_ref, resolved_at, closed_at, created_at, updated_at, source_system,
		   zoho_assignee_id, zoho_assignee_name, zoho_assignee_email, assigned_to,
		   sla_due_at, ticket_type, first_response_due, csat_token)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,'zoho_desk',
		   NULLIF($14,''),NULLIF($15,''),NULLIF($16,''),$17,
		   $18, NULLIF($19,''), $20, NULLIF($21,''))
		ON CONFLICT (ticket_ref) DO UPDATE SET
		  status              = EXCLUDED.status,
		  priority            = EXCLUDED.priority,
		  channel             = EXCLUDED.channel,
		  -- COALESCE, not a bare overwrite: Zoho does not return a resolve/close
		  -- time on every payload, and the unconditional assignment was NULLing
		  -- timestamps we already knew. It ate ~1,900 resolution times out of the
		  -- backfill within minutes of it being written. Zoho still wins when it
		  -- HAS a value; it just can no longer erase one.
		  resolved_at         = COALESCE(EXCLUDED.resolved_at, helpdesk_tickets.resolved_at),
		  closed_at           = COALESCE(EXCLUDED.closed_at, helpdesk_tickets.closed_at),
		  updated_at          = EXCLUDED.updated_at,
		  zoho_assignee_id    = EXCLUDED.zoho_assignee_id,
		  zoho_assignee_name  = EXCLUDED.zoho_assignee_name,
		  zoho_assignee_email = EXCLUDED.zoho_assignee_email,
		  assigned_to         = COALESCE(EXCLUDED.assigned_to, helpdesk_tickets.assigned_to),
		  sla_due_at          = COALESCE(EXCLUDED.sla_due_at, helpdesk_tickets.sla_due_at),
		  ticket_type         = COALESCE(EXCLUDED.ticket_type, helpdesk_tickets.ticket_type),
		  first_response_due  = COALESCE(EXCLUDED.first_response_due, helpdesk_tickets.first_response_due),
		  csat_token          = COALESCE(helpdesk_tickets.csat_token, EXCLUDED.csat_token)
		RETURNING id, (xmax = 0) AS inserted`,
		subject, body, channel, status, priority, dept,
		custName, custEmail, custPhone,
		ref, resolvedAt, closedAt, createdAt,
		asgID, asgName, asgEmail, assignedTo,
		slaDue, ticketType, frtDue, csatToken)
	if err != nil {
		slog.Warn("upsertZohoTicket: insert", "ref", ref, "err", err)
		return 0, 0, 1
	}
	if len(rows) == 0 {
		return 0, 1, 0
	}
	// Auto-assign only brand-new, open, still-unowned tickets (load-balanced) so
	// incoming email/social tickets get an owner instead of ageing in an unowned
	// pile. Re-imports (xmax<>0) and tickets Zoho already assigned are left alone.
	if ins, _ := rows[0]["inserted"].(bool); ins && assignedTo == nil && (status == "open" || status == "pending") {
		hdAutoAssignTicket(ctx, db, toInt64(rows[0]["id"]), 0)
	}
	// A ticket that arrives from Zoho ALREADY assigned reached its agent through
	// no path at all — this importer held zero Notify calls while being the source
	// of every one of the 35,035 tickets in the system. Tell the owner now.
	if assignedTo != nil && (status == "open" || status == "pending") {
		zohoNotifyAssignee(ctx, db, toInt64(rows[0]["id"]), *assignedTo, ref, subject)
	}
	return 1, 0, 0
}

// zohoNotifyAssignee tells an agent that Zoho has put a ticket in their name.
//
// assign_notified_at is claimed with a conditional UPDATE, so the notification is
// sent by whichever caller wins and never re-sent on the next sync cycle — the
// importer re-upserts every ticket it sees, so an unguarded notify here would
// re-announce the same ticket every hour, forever.
func zohoNotifyAssignee(ctx context.Context, db *core.DB, ticketID, userID int64, ref, subject string) {
	if ticketID == 0 || userID == 0 {
		return
	}
	res, err := db.PGExec(ctx, `
		UPDATE helpdesk_tickets SET assign_notified_at = NOW()
		 WHERE id = $1 AND assigned_to = $2 AND assign_notified_at IS NULL`, ticketID, userID)
	if err != nil {
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return // already announced, or reassigned under us
	}
	go Notify(context.WithoutCancel(ctx), db, NotifPayload{
		EventType: EvtTicketAssigned,
		UserID:    userID,
		Title:     fmt.Sprintf("Ticket assigned to you: %s", ref),
		Body:      subject,
		ActionURL: fmt.Sprintf("/helpdesk/%d", ticketID),
		EntityRef: ref,
	})
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
			"applied":        apply,
			"role":           role,
			"agents_in_zoho": len(agents),
			"considered":     considered,
			"created":        created,
			"skipped_exists": skipped,
			"failed":         failed,
			"results":        out,
		})
	}
}

// ── Zoho Desk — import conversation threads ──────────────────────────────────

// zohoFetchThreadContent returns the full HTML body of one ticket thread. The
// /conversations list returns only a truncated summary, so the complete message
// body must be read from the individual thread endpoint.
func zohoFetchThreadContent(ctx context.Context, ticketZohoID, threadID string) (string, error) {
	result, err := zohoFetch(ctx, "tickets/"+ticketZohoID+"/threads/"+threadID, nil)
	if err != nil {
		return "", err
	}
	return zohoStr(result["content"]), nil
}

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
	// Target tickets that don't yet have a FULL-content message (body_html): both
	// message-less tickets and ones that only have the old truncated summary. This
	// makes the sweep both import missing conversations AND backfill/upgrade summaries
	// to the complete thread body. Newest first so recent mail fills in first; a
	// ticket drops out once it has a full-content message (idempotent resume).
	q += ` AND NOT EXISTS (
	         SELECT 1 FROM helpdesk_messages m
	         WHERE m.ticket_id = helpdesk_tickets.id AND COALESCE(m.body_html,'') <> '')`
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

		imp, cerr := zohoImportTicketConversations(ctx, db, localID, zohoID, ticketChannel)
		j.Lock()
		j.processed++
		if cerr != nil {
			j.failed++
			j.lastErr = cerr.Error()
		} else {
			j.imported += imp
		}
		j.Unlock()
	}
}

// zohoImportTicketConversations fetches a single Zoho ticket's conversation timeline
// and inserts any missing helpdesk_messages rows (idempotent on external_id). Returns
// how many were inserted. Zoho imports the ticket but NOT its threads, so a freshly
// synced email ticket has its body only in the conversation — this is what fills it,
// used both by the bulk backfill job and lazily when an agent opens a message-less
// ticket.
func zohoImportTicketConversations(ctx context.Context, db *core.DB, localID int64, zohoID, ticketChannel string) (int, error) {
	if zohoID == "" {
		return 0, nil
	}
	convs, err := zohoFetchConversations(ctx, zohoID)
	if err != nil {
		return 0, err
	}
	imported := 0
	for _, c := range convs {
		extID := zohoStr(c["id"])
		if extID == "" {
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
		// The /conversations list only carries a ~200-char summary preview, which is
		// why messages showed up cut off. The full email body lives on the individual
		// thread, so fetch it for threads and store the complete text (+ HTML). Notes/
		// comments are short — their summary is the whole thing.
		body := zohoStr(c["summary"])
		var bodyHTML string
		if strings.EqualFold(zohoStr(c["type"]), "thread") {
			if html, ferr := zohoFetchThreadContent(ctx, zohoID, extID); ferr == nil && html != "" {
				bodyHTML = html
				if txt := strings.TrimSpace(htmlToText(html)); txt != "" {
					body = txt
				}
			}
		}
		createdAt := zohoParseTime(c["createdTime"])
		if createdAt.IsZero() {
			createdAt = time.Now()
		}
		// Upgrade-safe upsert: refresh to the fuller body when we now have more content
		// (so a re-sync/on-open replaces an old truncated summary), never shorten it.
		res, ierr := db.PGExec(ctx, `
			INSERT INTO helpdesk_messages
			  (ticket_id, direction, channel, author_name, body_text, body_html,
			   is_internal_note, external_id, source_system, created_at)
			VALUES ($1,$2,$3,$4,$5,NULLIF($6,''),$7,$8,'zoho_desk',$9)
			ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO UPDATE SET
			  body_text = CASE WHEN length(EXCLUDED.body_text) > length(COALESCE(helpdesk_messages.body_text,''))
			                   THEN EXCLUDED.body_text ELSE helpdesk_messages.body_text END,
			  body_html = COALESCE(EXCLUDED.body_html, helpdesk_messages.body_html)`,
			localID, direction, ch, author, body, bodyHTML, isNote, extID, createdAt)
		if ierr != nil {
			slog.Warn("zohoImportTicketConversations: insert", "ext", extID, "err", ierr)
			continue
		}
		if n, _ := res.RowsAffected(); n > 0 {
			imported++
		}
	}
	return imported, nil
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
			// Record the outcome so a manual "Sync now" also advances the sync state
			// and raises the same silent-failure alarm as the auto-sync.
			if j.lastErr != "" {
				recordZohoSyncResult(ctx, db, "calls", j.imported, fmt.Errorf("%s", j.lastErr))
			} else if spike, msg := zohoFailedSpike(j.imported, j.failed); spike {
				slog.Error("zoho manual import: HIGH INSERT-FAILURE RATE", "imported", j.imported, "failed", j.failed)
				recordZohoSyncResult(ctx, db, "calls", j.imported, fmt.Errorf("%s", msg))
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

				// Duration = completedTime - startTime (Zoho exposes no explicit duration).
				//
				// Two guards, both of which this used to get wrong:
				//
				// 1. A MISSED call has no talk time. completedTime - startTime on an
				//    unanswered record is how long the record stayed open — typically a
				//    second — and storing that in duration_sec meant the Call Log showed
				//    43,025 missed calls as one-second conversations. NULL is the honest
				//    value: no conversation happened, which is not the same as 0 seconds.
				// 2. Cap at 4h: some records carry a bogus completedTime (call left open
				//    and closed days later), which would poison talk-time averages.
				var durSec *int
				if outcome != "missed" {
					if comp := zohoParseTime(c["completedTime"]); !comp.IsZero() && comp.After(startedAt) {
						d := int(comp.Sub(startedAt).Seconds())
						if d >= 0 && d <= 14400 {
							durSec = &d
						}
					}
				}

				// Agent — prefer the call owner (ownerId) resolved via the Zoho agent
				// map; fall back to modifiedBy. Resolve to a workspace user through the
				// durable crosswalk (manual → email → name) so attribution survives
				// email mismatches and re-mapping is a set-based backfill, not a re-import.
				agentName, agentEmail, agentZID := "", "", ""
				if ownerID := zohoStr(c["ownerId"]); ownerID != "" {
					agentZID = ownerID
					if a, ok := agentMap[ownerID]; ok {
						agentName, agentEmail = a.name, a.email
					}
				}
				if mb, ok := c["modifiedBy"].(map[string]any); ok {
					if agentZID == "" {
						agentZID = zohoStr(mb["id"])
					}
					if agentName == "" {
						agentName = strings.TrimSpace(zohoStr(mb["firstName"]) + " " + zohoStr(mb["lastName"]))
					}
					if agentEmail == "" {
						agentEmail = strings.ToLower(strings.TrimSpace(zohoStr(mb["emailId"])))
					}
				}
				agentID := zohoResolveAgent(ctx, db, agentZID, agentEmail, agentName)

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
					   duration_sec, outcome, started_at, zoho_call_id, purpose, source_system, zoho_agent_id)
					  VALUES ($1,$2,$3,$4,
					    -- resolve CIF by phone against the customer master when Zoho gave none
					    COALESCE(NULLIF($5,''), (SELECT c.cif FROM app.customers c
					       WHERE app.norm_phone($4) <> '' AND app.norm_phone(c.phone) = app.norm_phone($4)
					       LIMIT 1), ''),  -- '' fallback: customer_cif is NOT NULL DEFAULT ''; unresolved call = '' not NULL (else 23502 drops it)
					    $6,$7,$8,$9,$10,
					    CASE
					      -- Which book does this call belong to?
					      --
					      -- The old rule called it COLLECTIONS whenever the number belonged to
					      -- an existing customer. Being a customer is not a debt: of 67 calls
					      -- filed as collections in one day, only 6 had a collections
					      -- assignment and 19 were agents working a marketing lead list. The
					      -- rule also never looked at call_center_leads at all, so a lead who
					      -- happened to also hold a card was filed as collections.
					      --
					      -- Order is by strength of evidence: what the agent is actually
					      -- working (a lead list), then a real debt, then a known customer.
					      WHEN $6 = 'inbound' THEN 'support'
					      -- On an active lead list: this is the agent working that list.
					      WHEN app.norm_phone($4) <> '' AND EXISTS (
					              SELECT 1 FROM call_center_leads d
					               WHERE app.norm_phone(d.customer_phone) = app.norm_phone($4))
					        THEN 'marketing'
					      -- A real collections case — an open assignment, not merely a customer.
					      WHEN EXISTS (
					              SELECT 1 FROM collection_assignments ca
					               WHERE ($5 <> '' AND ca.cif_number = $5)
					                  OR (app.norm_phone($4) <> '' AND ca.cif_number = (
					                        SELECT c.cif FROM app.customers c
					                         WHERE app.norm_phone(c.phone) = app.norm_phone($4) LIMIT 1)))
					        THEN 'collections'
					      -- An existing customer with no debt is a service call, not a chase.
					      WHEN ($5 <> '' AND EXISTS (SELECT 1 FROM app.customers c WHERE c.cif = $5))
					        OR (app.norm_phone($4) <> '' AND EXISTS (
					              SELECT 1 FROM app.customers c WHERE app.norm_phone(c.phone) = app.norm_phone($4)))
					        THEN 'support'
					      WHEN app.norm_phone($4) <> '' AND EXISTS (
					              SELECT 1 FROM crm_contacts l WHERE app.norm_phone(l.phone) = app.norm_phone($4))
					        THEN 'marketing'
					      ELSE 'marketing'
					    END,
					    'zoho_desk', NULLIF($11,''))
					-- Re-sync must not blank what the workspace knows and Zoho does not.
					-- Zoho carries no customer name for an outbound dial to a number that
					-- is not one of its contacts, which is exactly the call an agent types
					-- a name onto. Overwriting unconditionally wiped that name on the very
					-- next sync, so the call reverted to an anonymous number.
					ON CONFLICT (zoho_call_id) WHERE zoho_call_id IS NOT NULL DO UPDATE SET
					  agent_name     = COALESCE(NULLIF(EXCLUDED.agent_name,''), helpdesk_calls.agent_name),
					  agent_id       = COALESCE(EXCLUDED.agent_id, helpdesk_calls.agent_id),
					  zoho_agent_id  = COALESCE(EXCLUDED.zoho_agent_id, helpdesk_calls.zoho_agent_id),
					  customer_name  = COALESCE(NULLIF(EXCLUDED.customer_name,''), helpdesk_calls.customer_name),
					  customer_phone = COALESCE(NULLIF(EXCLUDED.customer_phone,''), helpdesk_calls.customer_phone),
					  customer_cif   = COALESCE(NULLIF(EXCLUDED.customer_cif,''), helpdesk_calls.customer_cif),
					  direction      = EXCLUDED.direction,
					  -- A re-sync that no longer resolves a duration must not erase one we
					  -- already captured.
					  duration_sec   = COALESCE(EXCLUDED.duration_sec, helpdesk_calls.duration_sec),
					  outcome        = EXCLUDED.outcome,
					  started_at     = EXCLUDED.started_at,
					  purpose        = COALESCE(helpdesk_calls.purpose, EXCLUDED.purpose)`,
					agentName, agentID, custName, custPhone, custCIF, direction,
					durSec, outcome, startedAt, zohoID, agentZID)
				if err != nil {
					slog.Warn("zohoImportDeskCalls: insert", "zoho_id", zohoID, "err", err)
					fail = 1
				} else if n, _ := res.RowsAffected(); n > 0 {
					imp = 1
				} else {
					skip = 1
				}
				// Agents dial through the carrier, so this importer is where the
				// outbound queue learns a contact was called. Without it the queue
				// keeps offering numbers that were dialled minutes ago (migration 144).
				if err == nil {
					ccStampQueueForPhone(ctx, db, custPhone)

					// Resolve the caller against our own records and fold in any
					// write-up the agent filed before this row existed. Both need the
					// row's id, so they run here rather than inside the upsert.
					if idRows, idErr := db.PGQuery(ctx,
						`SELECT id FROM helpdesk_calls WHERE zoho_call_id = $1`, zohoID); idErr == nil && len(idRows) > 0 {
						callID := toInt64(idRows[0]["id"])
						resolveCallCustomerName(ctx, db, callID)
						absorbPendingManualLog(ctx, db, callID)
					}
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

// voiceUserAccessToken fetches (or refreshes) a user's personal Zoho Voice access
// token from their stored refresh token, persisting the refreshed token. Returns
// ("","") when the user has not connected their Zoho Voice account.
func voiceUserAccessToken(ctx context.Context, db *core.DB, userID int64) (token, agentID string) {
	rows, _ := db.PGQuery(ctx,
		`SELECT zoho_voice_access_token, zoho_voice_token_expiry, zoho_voice_refresh_token, zoho_voice_agent_id
		 FROM o3c_users WHERE id=$1`, userID)
	if len(rows) == 0 {
		return "", ""
	}
	encAccess, _ := rows[0]["zoho_voice_access_token"].(string)
	expiry, _ := rows[0]["zoho_voice_token_expiry"].(time.Time)
	encRefresh, _ := rows[0]["zoho_voice_refresh_token"].(string)
	agentID, _ = rows[0]["zoho_voice_agent_id"].(string)
	if encAccess != "" && time.Now().Add(60*time.Second).Before(expiry) {
		token, _ = decryptValue(encAccess)
		return token, agentID
	}
	if encRefresh != "" {
		if rt, _ := decryptValue(encRefresh); rt != "" {
			if newAccess, newExpiry, err := voiceRefreshUserToken(ctx, rt); err == nil {
				token = newAccess
				if enc, encErr := encryptValue(newAccess); encErr == nil {
					db.PGExec(ctx, //nolint:errcheck
						`UPDATE o3c_users SET zoho_voice_access_token=$1, zoho_voice_token_expiry=$2 WHERE id=$3`,
						enc, newExpiry, userID)
				}
			}
		}
	}
	return token, agentID
}

// voiceTokenHandler — GET /api/zoho/voice/token. Returns the caller's fresh Zoho
// Voice access token (+ agent id + DC) for the browser WebSDK to authenticate. No
// call is logged (unlike /voice/call); used to initialise the SDK's OAuth callback.
func voiceTokenHandler(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		if user == nil {
			respondErr(w, 401, "unauthorized")
			return
		}
		token, agentID := voiceUserAccessToken(ctx, db, user.ID)
		if token == "" {
			respondErr(w, 403, "Zoho Voice not connected — connect your account in Settings")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{ //nolint:errcheck
			"access_token": token, "agent_id": agentID, "dc": zohoDC,
		})
	}
}

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
		callToken, agentVoiceID := "", ""
		if user != nil {
			callToken, agentVoiceID = voiceUserAccessToken(ctx, db, user.ID)
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

// ── Ticket vocabulary guards ─────────────────────────────────────────────────
//
// These mirror the CHECK constraints on helpdesk_tickets. They exist because the
// importer's job is to get the ticket IN: a value the column rejects turns an
// import into a silent data-loss bug, and the failure surfaces only as a warning
// on a line nobody reads.
//
// Keep them in step with the constraints. TestTicketVocabularyMatchesConstraints
// fails the build if they drift.
var (
	ticketStatuses   = []string{"open", "pending", "in_progress", "resolved", "closed"}
	ticketPriorities = []string{"low", "normal", "high", "urgent"}
	ticketChannels   = []string{"email", "sms", "whatsapp", "phone", "in_app", "call",
		"mobile", "web", "social", "chat"}
)

// coerceToAllowed returns v when the column accepts it, otherwise fallback.
//
// An out-of-vocabulary value is logged once with the ORIGINAL upstream value, so
// a new Zoho status shows up as something to map rather than as a ticket that
// quietly never arrived.
func coerceToAllowed(v string, allowed []string, fallback, field, upstream string) string {
	if v != "" {
		for _, a := range allowed {
			if v == a {
				return v
			}
		}
		slog.Warn("zoho import: value not accepted by the column, using fallback",
			"field", field, "mapped", v, "upstream", upstream, "fallback", fallback)
	}
	return fallback
}

// zohoCallDuration reads the talk time off a Zoho Voice call log, in seconds.
//
// Deliberately defensive: the Voice API is not versioned in this integration and
// has been seen to return the duration under different keys and in two shapes —
// a number of seconds, or a clock string ("09:08", "01:09:08"). Anything it
// cannot read returns 0, which every caller treats as "unknown" and falls back
// to the previous behaviour. An unreadable duration must never be worse than no
// duration at all.
func zohoCallDuration(c map[string]any) int {
	for _, key := range []string{"call_duration", "duration", "callduration", "billing_duration"} {
		v, ok := c[key]
		if !ok || v == nil {
			continue
		}
		if n := parseDurationValue(v); n > 0 {
			return n
		}
	}
	return 0
}

// parseDurationValue converts a duration expressed as a number or a clock string
// into seconds. Returns 0 for anything unrecognised or implausible.
func parseDurationValue(v any) int {
	switch t := v.(type) {
	case float64:
		return sanitiseDurationSec(int(t))
	case int:
		return sanitiseDurationSec(t)
	case int64:
		return sanitiseDurationSec(int(t))
	case string:
		s := strings.TrimSpace(t)
		if s == "" {
			return 0
		}
		// Plain seconds.
		if n, err := strconv.Atoi(s); err == nil {
			return sanitiseDurationSec(n)
		}
		// Clock form: mm:ss or hh:mm:ss.
		parts := strings.Split(s, ":")
		if len(parts) < 2 || len(parts) > 3 {
			return 0
		}
		total := 0
		for _, p := range parts {
			n, err := strconv.Atoi(strings.TrimSpace(p))
			if err != nil || n < 0 {
				return 0
			}
			total = total*60 + n
		}
		return sanitiseDurationSec(total)
	}
	return 0
}

// sanitiseDurationSec rejects values the calls table would refuse anyway
// (helpdesk_calls_duration_sane_chk: 0..14400), so a bad reading is dropped here
// rather than failing the whole attach.
func sanitiseDurationSec(n int) int {
	if n <= 0 || n > 14400 {
		return 0
	}
	return n
}

// absorbPendingManualLog folds a manually logged call into the Zoho row that has
// just arrived for the same conversation.
//
// The two halves of the same problem:
//
//	forward  — agent logs AFTER the Zoho row lands. The form finds it via
//	           /api/helpdesk/calls/latest and writes the notes onto it.
//	backward — agent logs BEFORE it lands, which is the common case: a Zoho call
//	           reaches us 35–186 seconds after it starts, and an agent writes up a
//	           call the moment they hang up. The form has nothing to attach to, so
//	           it creates its own row. This is that row being absorbed.
//
// Without this, every promptly-logged call leaves two records: the agent's notes on
// one, the duration and recording on the other, and neither complete.
//
// Conservative by construction: same agent, same number, the manual row must be
// within 15 minutes of the call, must carry an actual write-up, and must not
// already be merged. Anything short of that is left alone.
func absorbPendingManualLog(ctx context.Context, db *core.DB, callID int64) {
	rows, err := db.PGQuery(ctx, `
		WITH target AS (
		  SELECT id, agent_id, started_at,
		         `+normalizedPhoneExpr("customer_phone")+` AS ph
		    FROM helpdesk_calls WHERE id = $1
		),
		pending AS (
		  SELECT m.id
		    FROM helpdesk_calls m, target t
		   WHERE m.id <> t.id
		     AND m.source_system <> 'zoho_desk'
		     AND m.merged_into_call_id IS NULL
		     AND m.zoho_call_id IS NULL
		     AND m.agent_id IS NOT DISTINCT FROM t.agent_id
		     AND t.ph <> ''
		     AND `+normalizedPhoneExpr("m.customer_phone")+` = t.ph
		     -- Logged around the call: after it started, and not long after.
		     AND m.created_at BETWEEN t.started_at - interval '2 minutes'
		                          AND t.started_at + interval '15 minutes'
		     AND COALESCE(NULLIF(TRIM(m.notes),''), NULLIF(TRIM(m.disposition),'')) IS NOT NULL
		   ORDER BY m.created_at ASC
		   LIMIT 1
		)
		UPDATE helpdesk_calls v
		   SET notes         = COALESCE(v.notes, m.notes),
		       resolution    = COALESCE(v.resolution, m.resolution),
		       disposition   = COALESCE(NULLIF(v.disposition,''), m.disposition),
		       purpose       = COALESCE(NULLIF(v.purpose,''), m.purpose),
		       customer_name = COALESCE(NULLIF(v.customer_name,''), NULLIF(m.customer_name,''), ''),
		       customer_cif  = COALESCE(NULLIF(v.customer_cif,''),  NULLIF(m.customer_cif,''),  ''),
		       ticket_id     = COALESCE(v.ticket_id, m.ticket_id),
		       ticket_ref    = COALESCE(v.ticket_ref, m.ticket_ref),
		       ticket_type   = COALESCE(v.ticket_type, m.ticket_type),
		       lead_id       = COALESCE(v.lead_id, m.lead_id)
		  FROM helpdesk_calls m
		 WHERE v.id = $1 AND m.id = (SELECT id FROM pending)
		 RETURNING m.id AS absorbed`, callID)
	if err != nil {
		slog.Warn("absorbPendingManualLog", "call", callID, "err", err)
		return
	}
	if len(rows) == 0 {
		return
	}
	absorbed := toInt64(rows[0]["absorbed"])
	if _, err := db.PGExec(ctx,
		`UPDATE helpdesk_calls SET merged_into_call_id = $1 WHERE id = $2`, callID, absorbed); err != nil {
		slog.Warn("absorbPendingManualLog: mark merged", "call", callID, "absorbed", absorbed, "err", err)
		return
	}
	slog.Info("absorbed a manual call log into the synced call", "call", callID, "log", absorbed)
}

// resolveCallCustomerName names a call from our own records when Zoho could not.
//
// Zoho only carries a customer name when the number is one of ITS contacts. For an
// outbound dial to a lead, or an inbound call from a customer Zoho has never seen,
// it sends nothing — so 8,614 of the last 9,181 calls arrived anonymous, showing
// agents a bare phone number on a customer they are already doing business with.
//
// The workspace knows perfectly well who most of them are: 711 of those could be
// named from data we already hold. Resolution order is by strength of claim —
// the customer master first (a real, booked customer), then the lead the number
// was dialled FROM, then the wider CRM contact book.
//
// Works for both directions: the number matched is the customer's end of the
// call, which the importer has already normalised into customer_phone.
//
// Only ever fills a blank. A name a human typed is never overwritten.
func resolveCallCustomerName(ctx context.Context, db *core.DB, callID int64) {
	if _, err := db.PGExec(ctx, `
		WITH t AS (
		  SELECT id, `+normalizedPhoneExpr("customer_phone")+` AS ph
		    FROM helpdesk_calls
		   WHERE id = $1
		     AND NULLIF(TRIM(customer_name), '') IS NULL
		)
		UPDATE helpdesk_calls h
		   SET customer_name = COALESCE(
		         -- Only when the number identifies ONE person. A shared line (family,
		         -- or a placeholder like 08012345678 which 4,008 customers carry)
		         -- would otherwise hand the agent an arbitrary name to read out on a
		         -- live call. No name is honest; a wrong name is not.
		         (SELECT MIN(NULLIF(TRIM(c.full_name), '')) FROM app.customers c
		           WHERE `+normalizedPhoneExpr("c.phone")+` = t.ph
		           HAVING COUNT(DISTINCT NULLIF(TRIM(c.full_name), '')) = 1),
		         (SELECT NULLIF(TRIM(d.customer_name), '') FROM call_center_leads d
		           WHERE `+normalizedPhoneExpr("d.customer_phone")+` = t.ph LIMIT 1),
		         (SELECT NULLIF(TRIM(k.first_name || ' ' || COALESCE(k.last_name, '')), '')
		            FROM crm_contacts k
		           WHERE `+normalizedPhoneExpr("k.phone")+` = t.ph LIMIT 1),
		         h.customer_name),
		       customer_cif = COALESCE(NULLIF(h.customer_cif, ''),
		         (SELECT MIN(NULLIF(TRIM(c.cif), '')) FROM app.customers c
		           WHERE `+normalizedPhoneExpr("c.phone")+` = t.ph
		           HAVING COUNT(DISTINCT NULLIF(TRIM(c.cif), '')) = 1),
		         '')
		  FROM t
		 WHERE h.id = t.id AND t.ph <> ''`, callID); err != nil {
		slog.Warn("resolveCallCustomerName", "call", callID, "err", err)
	}
}

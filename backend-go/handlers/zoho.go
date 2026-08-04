package handlers

// Zoho integration — Voice call initiation and voice log import.
//
// Zoho Desk sync has been removed. This file now handles only Voice routes.
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
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'zoho_desk')
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

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"configured":     configured,
			"last_sync_at":   lastSyncAt,
			"total_imported": totalImported,
		})
	}
}

// StartZohoAutoSync launches a background goroutine that imports Zoho Voice
// call logs every hour, keeping the Calls page current without manual syncs.
func StartZohoAutoSync(db *core.DB) {
	if !zohoConfigured() {
		return
	}
	go func() {
		ticker := time.NewTicker(1 * time.Hour)
		defer ticker.Stop()
		for range ticker.C {
			ctx := context.Background()
			if !zohoEnsureConfigured(ctx, db) {
				continue
			}
			if err := ensureCallLogSchema(ctx, db); err != nil {
				slog.Error("zoho auto-sync: schema error", "err", err)
				continue
			}
			from := time.Now().AddDate(0, 0, -2).Format("2006-01-02")
			to := time.Now().Format("2006-01-02")
			imported, _, failed, err := runZohoVoiceImport(ctx, db, from, to)
			if err != nil {
				slog.Error("zoho auto-sync: import failed", "err", err)
			} else {
				slog.Info("zoho auto-sync: done", "imported", imported, "failed", failed)
			}
		}
	}()
}

// StartZohoDeskAutoSync keeps the helpdesk queue current by importing the newest
// Zoho Desk tickets every hour (a bounded, newest-first sweep). Idempotent upserts
// mean re-sweeping the recent window is cheap; new tickets are caught at the top.
func StartZohoDeskAutoSync(db *core.DB) {
	if !zohoConfigured() {
		return
	}
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

			// Newest-first, capped so each hourly sweep only touches the recent window.
			runZohoTicketImportJob(ctx, db, j, 2000, true)

			j.Lock()
			j.running, j.done, j.endedAt = false, true, time.Now()
			imported := j.imported
			j.Unlock()
			slog.Info("zoho desk auto-sync: tickets done", "imported", imported)
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

	var custName, custEmail, custPhone string
	if contact, ok := t["contact"].(map[string]any); ok {
		custName = strings.TrimSpace(zohoStr(contact["firstName"]) + " " + zohoStr(contact["lastName"]))
		custEmail = zohoStr(contact["email"])
		custPhone = zohoStr(contact["phone"])
	}

	res, err := db.PGExec(ctx, `
		INSERT INTO helpdesk_tickets
		  (subject, description, channel, status, priority, department,
		   customer_name, customer_email, customer_phone,
		   ticket_ref, resolved_at, closed_at, created_at, updated_at, source_system)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,'zoho_desk')
		ON CONFLICT (ticket_ref) DO UPDATE SET
		  status      = EXCLUDED.status,
		  priority    = EXCLUDED.priority,
		  channel     = EXCLUDED.channel,
		  resolved_at = EXCLUDED.resolved_at,
		  closed_at   = EXCLUDED.closed_at,
		  updated_at  = EXCLUDED.updated_at`,
		subject, body, channel, status, priority, dept,
		custName, custEmail, custPhone,
		ref, resolvedAt, closedAt, createdAt)
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
		})
	}
}

// runZohoDeskCallImportJob pages through Zoho Desk call logs (background context)
// and upserts them into helpdesk_calls tagged source_system='zoho_desk'.
func runZohoDeskCallImportJob(ctx context.Context, db *core.DB, j *zohoJob, from, to string, maxOffset int) {
	offset := 0
	pageSize := 100

	for {
		params := url.Values{
			"from":  {fmt.Sprintf("%d", offset)},
			"limit": {fmt.Sprintf("%d", pageSize)},
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

				rawType := strings.ToLower(zohoStr(c["callType"]))
				direction := "inbound"
				if strings.Contains(rawType, "outbound") || strings.Contains(rawType, "outgoing") {
					direction = "outbound"
				}

				outcome := "resolved"
				rawStatus := strings.ToLower(zohoStr(c["callStatus"]))
				if strings.Contains(rawStatus, "miss") || strings.Contains(rawStatus, "abandon") {
					outcome = "missed"
				}

				// Duration: try seconds int, then "HH:MM:SS" string, then millis
				durSec := zohoParseDurationSec(c["callDuration"])
				if durSec == nil {
					durSec = zohoParseDurationSec(c["duration"])
				}

				// Agent: try direct field then nested owner/agent objects
				agentName := zohoStr(c["agentName"])
				if agentName == "" {
					if owner, ok := c["owner"].(map[string]any); ok {
						agentName = zohoStr(owner["name"])
					}
				}
				if agentName == "" {
					if ag, ok := c["agent"].(map[string]any); ok {
						agentName = zohoStr(ag["name"])
					}
				}

				// Customer phone: Zoho Desk uses callerNumber for inbound
				custPhone := zohoStr(c["callerNumber"])
				if custPhone == "" {
					custPhone = zohoStr(c["customerNumber"])
				}
				if custPhone == "" {
					custPhone = zohoStr(c["from"])
				}
				if custPhone == "" {
					if contact, ok := c["contact"].(map[string]any); ok {
						custPhone = zohoStr(contact["phone"])
					}
				}

				// Customer name
				custName := zohoStr(c["callerName"])
				if custName == "" {
					if contact, ok := c["contact"].(map[string]any); ok {
						fn := zohoStr(contact["firstName"])
						ln := zohoStr(contact["lastName"])
						custName = strings.TrimSpace(fn + " " + ln)
					}
				}

				callTo := zohoStr(c["receiverNumber"])
				if callTo == "" {
					callTo = zohoStr(c["to"])
				}
				if callTo == "" {
					callTo = zohoStr(c["didNumber"])
				}

				res, err := db.PGExec(ctx, `
					INSERT INTO helpdesk_calls
					  (agent_name, customer_name, customer_phone, call_to, direction,
					   duration_sec, outcome, started_at, zoho_call_id, source_system)
					VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'zoho_desk')
					ON CONFLICT (zoho_call_id) WHERE zoho_call_id IS NOT NULL DO UPDATE SET
					  agent_name     = EXCLUDED.agent_name,
					  customer_name  = EXCLUDED.customer_name,
					  customer_phone = EXCLUDED.customer_phone,
					  direction      = EXCLUDED.direction,
					  duration_sec   = EXCLUDED.duration_sec,
					  outcome        = EXCLUDED.outcome,
					  started_at     = EXCLUDED.started_at`,
					agentName, custName, custPhone, callTo, direction,
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

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
	"strings"
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
	r.Post("/voice/import-logs", zohoImportVoiceLogs(db))
	r.Post("/voice/call", zohoInitiateCall(db))
	r.Post("/import-tickets", zohoImportTickets(db))
	r.Post("/import-calls", zohoImportDeskCalls(db))
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
	r.With(guard).Post("/admin/import-tickets", zohoImportTickets(db))
	r.With(guard).Post("/admin/import-calls", zohoImportDeskCalls(db))
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
				     outcome, started_at, zoho_voice_id)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
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

// ── Zoho Desk — import tickets ────────────────────────────────────────────────

func zohoImportTickets(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		if !zohoEnsureConfigured(ctx, db) {
			respondErr(w, 503, "Zoho credentials not configured")
			return
		}

		from := r.URL.Query().Get("from_date")
		to := r.URL.Query().Get("to_date")
		var dateFrom, dateTo time.Time
		if from != "" {
			dateFrom, _ = time.Parse("2006-01-02", from)
		}
		if to != "" {
			dateTo, _ = time.Parse("2006-01-02", to)
		}

		ensureHelpdeskColumns(ctx, db)

		tickets, err := zohoFetchTickets(ctx, dateFrom, dateTo, url.Values{"include": {"contacts,assignee"}}, 2000)
		if err != nil {
			respondErr(w, 502, "Zoho API error: "+err.Error())
			return
		}

		statusMap := map[string]string{
			"open": "open", "on hold": "pending", "escalated": "open",
			"resolved": "resolved", "closed": "closed",
		}
		priorityMap := map[string]string{
			"low": "low", "medium": "normal", "high": "high", "urgent": "urgent",
		}
		// Only values allowed by the DB CHECK constraint
		channelMap := map[string]string{
			"email": "email", "phone": "phone", "sms": "sms",
			"whatsapp": "whatsapp", "chat": "in_app", "web": "in_app",
			"twitter": "in_app", "facebook": "in_app",
		}

		var imported, skipped, failed int
		for _, t := range tickets {
			zohoID := zohoStr(t["id"])
			if zohoID == "" {
				skipped++
				continue
			}
			ref := "ZOHO-" + zohoID

			subject := zohoStr(t["subject"])
			if subject == "" {
				subject = "(no subject)"
			}
			body := zohoStr(t["description"])

			rawStatus := strings.ToLower(zohoStr(t["status"]))
			status := statusMap[rawStatus]
			if status == "" {
				status = "open"
			}
			rawPriority := strings.ToLower(zohoStr(t["priority"]))
			priority := priorityMap[rawPriority]
			if priority == "" {
				priority = "normal"
			}
			rawChannel := strings.ToLower(zohoStr(t["channel"]))
			channel := channelMap[rawChannel]
			if channel == "" {
				channel = "in_app"
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

			// Contact info — nested under "contact"
			var custName, custEmail, custPhone string
			if contact, ok := t["contact"].(map[string]any); ok {
				fn := zohoStr(contact["firstName"])
				ln := zohoStr(contact["lastName"])
				custName = strings.TrimSpace(fn + " " + ln)
				custEmail = zohoStr(contact["email"])
				custPhone = zohoStr(contact["phone"])
			}

			res, err := db.PGExec(ctx, `
				INSERT INTO helpdesk_tickets
				  (subject, description, channel, status, priority, department,
				   customer_name, customer_email, customer_phone,
				   ticket_ref, resolved_at, closed_at, created_at, updated_at)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
				ON CONFLICT (ticket_ref) DO NOTHING`,
				subject, body, channel, status, priority, dept,
				custName, custEmail, custPhone,
				ref, resolvedAt, closedAt, createdAt)
			if err != nil {
				slog.Warn("zohoImportTickets: insert", "ref", ref, "err", err)
				failed++
			} else if n, _ := res.RowsAffected(); n > 0 {
				imported++
			} else {
				skipped++ // already exists (ON CONFLICT DO NOTHING)
			}
		}

		slog.Info("zohoImportTickets done", "imported", imported, "skipped", skipped, "failed", failed)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"imported": imported, "skipped": skipped, "failed": failed,
		})
	}
}

// ── Zoho Desk — import call logs ─────────────────────────────────────────────

func zohoImportDeskCalls(db *core.DB) http.HandlerFunc {
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

		from := r.URL.Query().Get("from_date")
		to := r.URL.Query().Get("to_date")
		if from == "" {
			from = time.Now().AddDate(0, 0, -30).Format("2006-01-02")
		}
		if to == "" {
			to = time.Now().Format("2006-01-02")
		}

		var imported, skipped, failed int
		offset := 0
		pageSize := 100

		for {
			params := url.Values{
				"from":  {fmt.Sprintf("%d", offset)},
				"limit": {fmt.Sprintf("%d", pageSize)},
			}
			result, err := zohoFetch(ctx, "calls", params)
			if err != nil {
				respondErr(w, 502, "Zoho API error: "+err.Error())
				return
			}
			batch := zohoItems(result)
			if len(batch) == 0 {
				break
			}

			for _, c := range batch {
				zohoID := zohoStr(c["id"])
				if zohoID == "" {
					skipped++
					continue
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
					skipped++
					continue
				}
				dateStr := startedAt.Format("2006-01-02")
				if dateStr < from || dateStr > to {
					skipped++
					continue
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
					   duration_sec, outcome, started_at, zoho_call_id)
					VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
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
					failed++
				} else if n, _ := res.RowsAffected(); n > 0 {
					imported++
				} else {
					skipped++
				}
			}

			if len(batch) < pageSize {
				break
			}
			offset += pageSize
			if offset > 5000 {
				break
			}
		}

		slog.Info("zohoImportDeskCalls done", "imported", imported, "skipped", skipped, "failed", failed)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"imported": imported, "skipped": skipped, "failed": failed,
		})
	}
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

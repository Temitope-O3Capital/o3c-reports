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

// ── Route registration ────────────────────────────────────────────────────────

func RegisterZoho(r chi.Router, db *core.DB) {
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

		token, err := zohoAccessToken(ctx)
		if err != nil {
			respondErr(w, 503, "Token error: "+err.Error())
			return
		}

		// Date range: default last 30 days.
		fromDate := time.Now().AddDate(0, 0, -30).Format("2006-01-02")
		toDate := time.Now().Format("2006-01-02")
		if v := r.URL.Query().Get("from_date"); v != "" {
			fromDate = v
		}
		if v := r.URL.Query().Get("to_date"); v != "" {
			toDate = v
		}

		voiceBase := "https://voice.zoho.com/rest/json/zv"
		var imported, skipped, failed int
		var minStartedAt, maxStartedAt time.Time
		pageFrom := 0
		pageSize := 100

		for {
			reqURL := fmt.Sprintf("%s/logs?from=%d&size=%d&fromDate=%s&toDate=%s",
				voiceBase, pageFrom, pageSize, url.QueryEscape(fromDate), url.QueryEscape(toDate))
			req, err := http.NewRequestWithContext(ctx, "GET", reqURL, nil)
			if err != nil {
				break
			}
			req.Header.Set("Authorization", "Zoho-oauthtoken "+token)
			req.Header.Set("Accept", "application/json")

			resp, err := zohoHTTP.Do(req)
			if err != nil {
				slog.Error("zohoImportVoiceLogs: request", "err", err)
				break
			}

			bodyBytes, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			var result map[string]any
			json.Unmarshal(bodyBytes, &result) //nolint:errcheck

			var logs []map[string]any
			if resp.StatusCode != 200 {
				slog.Warn("zohoImportVoiceLogs: non-200", "status", resp.StatusCode, "body", string(bodyBytes[:min(len(bodyBytes), 400)]))
				respondErr(w, resp.StatusCode, "Zoho Voice API error: "+strings.TrimSpace(string(bodyBytes[:min(len(bodyBytes), 800)])))
				return
			}
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
				zohoTrackDateRange(startedAt, &minStartedAt, &maxStartedAt)

				res, err := db.PGExec(ctx, `
					INSERT INTO helpdesk_calls
					    (agent_name, customer_phone, call_to, direction, duration_sec,
					     outcome, started_at, zoho_voice_id)
					VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
					ON CONFLICT DO NOTHING`,
					ptrOrNilStr(agentName), ptrOrNilStr(customerPhone),
					ptrOrNilStr(callTo), direction, durSec, outcome, startedAt, voiceID)
				if err != nil {
					slog.Warn("zohoImportVoiceLogs: insert", "voice_id", voiceID, "err", err)
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

		slog.Info("zohoImportVoiceLogs done", "imported", imported, "skipped", skipped, "failed", failed)
		w.Header().Set("Content-Type", "application/json")
		out := map[string]any{"imported": imported, "skipped": skipped, "failed": failed}
		if !minStartedAt.IsZero() {
			out["date_from"] = minStartedAt.Format("2006-01-02")
			out["date_to"] = maxStartedAt.Format("2006-01-02")
		}
		json.NewEncoder(w).Encode(out) //nolint:errcheck
	}
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

		// Prefer the agent's personal Zoho Voice token; fall back to org token.
		callToken := ""
		if user != nil {
			rows, _ := db.PGQuery(ctx,
				`SELECT zoho_voice_access_token, zoho_voice_token_expiry, zoho_voice_refresh_token
				 FROM o3c_users WHERE id=$1`, user.ID)
			if len(rows) > 0 {
				encAccess, _ := rows[0]["zoho_voice_access_token"].(string)
				expiry, _ := rows[0]["zoho_voice_token_expiry"].(time.Time)
				encRefresh, _ := rows[0]["zoho_voice_refresh_token"].(string)
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

		payload := map[string]any{
			"callType": "OUTBOUND",
			"phone":    b.PhoneNumber,
		}
		payloadBytes, _ := json.Marshal(payload)

		var resp *http.Response
		var err error
		if callToken != "" {
			// Use agent's personal Voice token — Zoho knows which agent is calling.
			reqURL := "https://desk.zoho." + zohoDC + "/api/v1/calls"
			req, _ := http.NewRequestWithContext(ctx, "POST", reqURL, strings.NewReader(string(payloadBytes)))
			req.Header.Set("Authorization", "Zoho-oauthtoken "+callToken)
			req.Header.Set("orgId", zohoOrgID)
			req.Header.Set("Content-Type", "application/json")
			resp, err = zohoHTTP.Do(req)
		} else {
			resp, err = zohoWrite(ctx, "POST", "calls", strings.NewReader(string(payloadBytes)))
		}
		if err != nil {
			respondErr(w, 503, "Zoho Voice unavailable: "+err.Error())
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			body, _ := io.ReadAll(resp.Body)
			msg := strings.TrimSpace(string(body))
			if msg == "" {
				msg = fmt.Sprintf("Zoho returned HTTP %d", resp.StatusCode)
			}
			respondErr(w, 502, msg)
			return
		}

		var result map[string]any
		json.NewDecoder(resp.Body).Decode(&result) //nolint:errcheck

		agentName := ""
		if user != nil {
			agentName = user.FullName
		}
		db.PGExec(ctx, `
			INSERT INTO helpdesk_calls (agent_name, customer_phone, direction, outcome, ticket_id)
			VALUES ($1,$2,'outbound','in_progress',$3)`,
			agentName, b.PhoneNumber, b.TicketID) //nolint:errcheck

		respond(w, result, "zoho")
	}
}

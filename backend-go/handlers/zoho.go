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
		payload := map[string]any{
			"callType": "OUTBOUND",
			"toNumber": b.PhoneNumber,
		}
		payloadBytes, _ := json.Marshal(payload)

		resp, err := zohoWrite(ctx, "POST", "calls", strings.NewReader(string(payloadBytes)))
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

		user := core.UserFromCtx(ctx)
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

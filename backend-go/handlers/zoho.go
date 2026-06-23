package handlers

// Zoho integration: OAuth flow, ticket sync, Voice call initiation, and webhook receiver.
//
// Credentials (set in Admin → API Keys OR via env vars):
//   ZOHO_CLIENT_ID      – OAuth app client ID
//   ZOHO_CLIENT_SECRET  – OAuth app client secret
//   ZOHO_REFRESH_TOKEN  – long-lived refresh token (stored after OAuth flow)
//   ZOHO_ORG_ID         – Zoho Desk organization ID
//   ZOHO_DC             – data-center suffix: com (default) | eu | in | com.au | jp
//
// The token manager lives in call_center.go (zohoAccessToken / zohoTok).
// After an OAuth exchange this file updates both the DB store AND the package-level
// vars that call_center.go uses, so the running process picks up the new tokens
// immediately.

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

func RegisterZohoPublic(r chi.Router, db *core.DB) {
	r.Get("/oauth/callback", zohoOAuthCallback(db))
	r.Post("/webhooks/desk", zohoWebhookDesk(db))
}

func RegisterZoho(r chi.Router, db *core.DB) {
	r.Get("/status", zohoGetStatus(db))
	r.Get("/oauth/connect", zohoOAuthConnect(db))
	r.Delete("/oauth/disconnect", zohoOAuthDisconnect(db))
	r.Post("/desk/sync", zohoPushTickets(db))
	r.Post("/desk/tickets/{id}/push", zohoPushOneTicket(db))
	r.Post("/voice/call", zohoInitiateCall(db))
}

// ── Schema ────────────────────────────────────────────────────────────────────

func ensureZohoSchema(ctx context.Context, db *core.DB) {
	db.PGExec(ctx, `ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS zoho_ticket_id TEXT`)                                                                  //nolint:errcheck
	db.PGExec(ctx, `ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS zoho_synced_at TIMESTAMPTZ`)                                                           //nolint:errcheck
	db.PGExec(ctx, `CREATE UNIQUE INDEX IF NOT EXISTS idx_hd_tickets_zoho_id ON helpdesk_tickets(zoho_ticket_id) WHERE zoho_ticket_id IS NOT NULL`)               //nolint:errcheck
}

// ── Credential helpers ────────────────────────────────────────────────────────

// saveZohoCred persists a Zoho credential to api_credentials (encrypted).
func saveZohoCred(ctx context.Context, db *core.DB, key, desc, plain string) error {
	enc, err := encryptValue(plain)
	if err != nil {
		return err
	}
	_, err = db.PGExec(ctx, `
		INSERT INTO api_credentials (key_name, description, category, is_secret, encrypted_value, is_active, updated_at)
		VALUES ($1,$2,'zoho',TRUE,$3,TRUE,NOW())
		ON CONFLICT (key_name) DO UPDATE SET encrypted_value=$3, is_active=TRUE, updated_at=NOW()`,
		key, desc, enc)
	return err
}

// zohoCred returns the value for key: env var first, then DB.
func zohoCred(ctx context.Context, db *core.DB, key string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return resolveCredKey(ctx, db, key)
}

// zohoAccountsBase returns the OAuth base URL for the configured data centre.
func zohoAccountsBase(ctx context.Context, db *core.DB) string {
	dc := zohoCred(ctx, db, "ZOHO_DC")
	if dc == "" {
		dc = zohoDC // from call_center.go
	}
	return "https://accounts.zoho." + dc
}

// updateLiveVars re-hydrates the package-level vars in call_center.go from
// values just stored in DB / env, so the running token manager picks them up
// without a restart.
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
	// Invalidate cached token so next call refreshes
	zohoTok.Lock()
	zohoTok.access = ""
	zohoTok.expires = time.Time{}
	zohoTok.Unlock()
}

// ── zohoWrite — POST / PATCH / DELETE to Zoho Desk ───────────────────────────

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

// ── Status ────────────────────────────────────────────────────────────────────

func zohoGetStatus(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		ensureZohoSchema(ctx, db)

		configured := zohoConfigured()
		// Also check DB-stored credentials
		if !configured {
			rt := zohoCred(ctx, db, "ZOHO_REFRESH_TOKEN")
			cid := zohoCred(ctx, db, "ZOHO_CLIENT_ID")
			cs := zohoCred(ctx, db, "ZOHO_CLIENT_SECRET")
			if rt != "" && cid != "" && cs != "" {
				configured = true
				updateLiveVars(ctx, db)
			}
		}

		result := map[string]any{
			"connected":         configured,
			"org_id":            coalesce(zohoOrgID, zohoCred(ctx, db, "ZOHO_ORG_ID")),
			"data_centre":       coalesce(zohoDC, "com"),
			"client_id_set":     zohoCred(ctx, db, "ZOHO_CLIENT_ID") != "" || zohoClientID != "",
			"client_secret_set": zohoCred(ctx, db, "ZOHO_CLIENT_SECRET") != "" || zohoClientSecret != "",
		}

		if configured {
			resp, err := zohoFetch(ctx, "myProfile", nil)
			result["api_reachable"] = err == nil && resp["errorCode"] == nil
			if err != nil {
				result["api_error"] = err.Error()
			}
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(result) //nolint:errcheck
	}
}

// ── OAuth connect ─────────────────────────────────────────────────────────────

func zohoOAuthConnect(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		clientID := zohoCred(ctx, db, "ZOHO_CLIENT_ID")
		if clientID == "" {
			respondErr(w, 400, "ZOHO_CLIENT_ID not set — add it in Admin → API Keys first")
			return
		}
		backendURL := os.Getenv("BACKEND_URL")
		if backendURL == "" {
			backendURL = "https://o3c-reports-production.up.railway.app"
		}
		redirectURI := backendURL + "/api/zoho/oauth/callback"

		authURL := fmt.Sprintf(
			"%s/oauth/v2/auth?response_type=code&client_id=%s&scope=%s&redirect_uri=%s&access_type=offline&prompt=consent",
			zohoAccountsBase(ctx, db),
			url.QueryEscape(clientID),
			url.QueryEscape("Desk.tickets.ALL,Desk.contacts.READ,Desk.agents.READ,Desk.events.ALL"),
			url.QueryEscape(redirectURI),
		)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"auth_url": authURL}) //nolint:errcheck
	}
}

func zohoOAuthCallback(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		code := r.URL.Query().Get("code")
		if code == "" {
			http.Error(w, "Missing code parameter", 400)
			return
		}
		ctx := context.Background()

		clientID := zohoCred(ctx, db, "ZOHO_CLIENT_ID")
		clientSecret := zohoCred(ctx, db, "ZOHO_CLIENT_SECRET")
		backendURL := os.Getenv("BACKEND_URL")
		if backendURL == "" {
			backendURL = "https://o3c-reports-production.up.railway.app"
		}
		redirectURI := backendURL + "/api/zoho/oauth/callback"

		resp, err := http.PostForm(zohoAccountsBase(ctx, db)+"/oauth/v2/token", url.Values{
			"grant_type":    {"authorization_code"},
			"client_id":     {clientID},
			"client_secret": {clientSecret},
			"code":          {code},
			"redirect_uri":  {redirectURI},
		})
		if err != nil {
			slog.Error("zohoOAuthCallback: token exchange", "err", err)
			http.Error(w, "Token exchange failed: "+err.Error(), 500)
			return
		}
		defer resp.Body.Close()

		var tok struct {
			AccessToken  string `json:"access_token"`
			RefreshToken string `json:"refresh_token"`
			ExpiresIn    int    `json:"expires_in"`
			Error        string `json:"error"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&tok); err != nil || tok.Error != "" {
			slog.Error("zohoOAuthCallback: decode", "err", err, "zoho_err", tok.Error)
			http.Error(w, "Token decode failed", 500)
			return
		}

		// Persist to DB
		saveZohoCred(ctx, db, "ZOHO_ACCESS_TOKEN", "Zoho access token", tok.AccessToken)    //nolint:errcheck
		saveZohoCred(ctx, db, "ZOHO_REFRESH_TOKEN", "Zoho refresh token", tok.RefreshToken)  //nolint:errcheck
		expiry := time.Now().Add(time.Duration(tok.ExpiresIn) * time.Second)
		saveZohoCred(ctx, db, "ZOHO_TOKEN_EXPIRY", "Zoho token expiry", expiry.Format(time.RFC3339)) //nolint:errcheck

		// Inject into live process
		zohoRefreshTok = tok.RefreshToken
		zohoTok.Lock()
		zohoTok.access = tok.AccessToken
		zohoTok.expires = expiry
		zohoTok.Unlock()

		// Auto-fetch org ID if not configured
		if zohoOrgID == "" {
			if result, err := zohoFetch(ctx, "organizations", nil); err == nil {
				if items := zohoItems(result); len(items) > 0 {
					if id, _ := items[0]["id"].(string); id != "" {
						zohoOrgID = id
						saveZohoCred(ctx, db, "ZOHO_ORG_ID", "Zoho Desk Org ID (auto-fetched)", id) //nolint:errcheck
					}
				}
			}
		}

		slog.Info("Zoho OAuth connected", "org_id", zohoOrgID)
		frontendURL := os.Getenv("FRONTEND_URL")
		if frontendURL == "" {
			frontendURL = "https://o3c-reports.pages.dev"
		}
		http.Redirect(w, r, frontendURL+"/admin/integrations?zoho=connected", http.StatusFound)
	}
}

func zohoOAuthDisconnect(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		for _, key := range []string{"ZOHO_ACCESS_TOKEN", "ZOHO_REFRESH_TOKEN", "ZOHO_TOKEN_EXPIRY"} {
			db.PGExec(ctx, `UPDATE api_credentials SET is_active=FALSE, encrypted_value='' WHERE key_name=$1`, key) //nolint:errcheck
		}
		// Clear live process vars
		zohoRefreshTok = ""
		zohoTok.Lock()
		zohoTok.access = ""
		zohoTok.expires = time.Time{}
		zohoTok.Unlock()

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "disconnected"}) //nolint:errcheck
	}
}

// ── Ticket sync: our system → Zoho Desk ──────────────────────────────────────

var zohoPriorityMap = map[string]string{
	"urgent": "High",
	"high":   "High",
	"normal": "Medium",
	"low":    "Low",
}

var zohoStatusMap = map[string]string{
	"open":        "Open",
	"pending":     "On Hold",
	"in_progress": "In Progress",
	"resolved":    "Closed",
	"closed":      "Closed",
}

func zohoPushOneTicket(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		id := chi.URLParam(r, "id")
		tickets, err := db.PGQuery(ctx, `
			SELECT id, ticket_ref, subject, customer_name, customer_email, customer_phone,
			       status, priority, channel, zoho_ticket_id, department
			FROM helpdesk_tickets WHERE id=$1`, id)
		if err != nil || len(tickets) == 0 {
			respondErr(w, 404, "Ticket not found")
			return
		}
		result, err := zohoSyncTicket(ctx, db, tickets[0])
		if err != nil {
			respondErr(w, 500, "Zoho sync failed: "+err.Error())
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(result) //nolint:errcheck
	}
}

func zohoPushTickets(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		ensureZohoSchema(ctx, db)

		tickets, err := db.PGQuery(ctx, `
			SELECT id, ticket_ref, subject, customer_name, customer_email, customer_phone,
			       status, priority, channel, zoho_ticket_id, department
			FROM helpdesk_tickets
			WHERE status NOT IN ('resolved','closed')
			  AND (zoho_ticket_id IS NULL OR zoho_synced_at < NOW() - INTERVAL '1 hour')
			ORDER BY created_at DESC LIMIT 50`)
		if err != nil {
			respondErr(w, 500, "DB error")
			return
		}

		synced, failed := 0, 0
		for _, t := range tickets {
			if _, err := zohoSyncTicket(ctx, db, t); err != nil {
				slog.Warn("zoho sync ticket failed", "id", t["id"], "err", err)
				failed++
			} else {
				synced++
			}
		}
		respond(w, map[string]any{"synced": synced, "failed": failed, "total": len(tickets)}, "pg")
	}
}

func zohoSyncTicket(ctx context.Context, db *core.DB, t core.Row) (map[string]any, error) {
	zohoID, _ := t["zoho_ticket_id"].(string)

	payload := map[string]any{
		"subject":     str(t["subject"]),
		"email":       str(t["customer_email"]),
		"phone":       str(t["customer_phone"]),
		"description": fmt.Sprintf("Customer: %s | Ticket: %s", str(t["customer_name"]), str(t["ticket_ref"])),
		"priority":    coalesce(zohoPriorityMap[str(t["priority"])], "Medium"),
		"status":      coalesce(zohoStatusMap[str(t["status"])], "Open"),
		"channel":     strings.Title(str(t["channel"])), //nolint:staticcheck
	}

	payloadBytes, _ := json.Marshal(payload)
	method := "POST"
	path := "tickets"
	if zohoID != "" {
		method = "PATCH"
		path = "tickets/" + zohoID
	}

	resp, err := zohoWrite(ctx, method, path, strings.NewReader(string(payloadBytes)))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var result map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode zoho response: %w", err)
	}

	if zohoID == "" {
		if newID, _ := result["id"].(string); newID != "" {
			db.PGExec(ctx, `UPDATE helpdesk_tickets SET zoho_ticket_id=$1, zoho_synced_at=NOW() WHERE id=$2`, //nolint:errcheck
				newID, t["id"])
		}
	} else {
		db.PGExec(ctx, `UPDATE helpdesk_tickets SET zoho_synced_at=NOW() WHERE id=$1`, t["id"]) //nolint:errcheck
	}
	return result, nil
}

// ── Webhook: Zoho Desk → our system ──────────────────────────────────────────

func zohoWebhookDesk(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if err != nil {
			respondErr(w, 400, "Read error")
			return
		}

		var event struct {
			EventType string `json:"eventType"`
			Payload   struct {
				ID      string `json:"id"`
				Status  string `json:"status"`
				Subject string `json:"subject"`
				Contact struct {
					Email string `json:"email"`
					Phone string `json:"phone"`
				} `json:"contact"`
			} `json:"payload"`
		}

		if err := json.Unmarshal(body, &event); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}

		ctx := r.Context()
		zohoID := event.Payload.ID

		switch event.EventType {
		case "Ticket_Create":
			exists, _ := db.PGQuery(ctx, `SELECT id FROM helpdesk_tickets WHERE zoho_ticket_id=$1`, zohoID)
			if len(exists) == 0 {
				ourStatus := "open"
				for k, v := range zohoStatusMap {
					if v == event.Payload.Status {
						ourStatus = k
						break
					}
				}
				db.PGExec(ctx, `
					INSERT INTO helpdesk_tickets
					    (channel, status, priority, subject, customer_email, customer_phone, zoho_ticket_id, zoho_synced_at)
					VALUES ('email',$1,'normal',$2,$3,$4,$5,NOW())
					ON CONFLICT (zoho_ticket_id) DO NOTHING`,
					ourStatus, event.Payload.Subject,
					event.Payload.Contact.Email, event.Payload.Contact.Phone, zohoID) //nolint:errcheck

			}
		case "Ticket_Update", "Ticket_StatusChange":
			if zohoID != "" {
				ourStatus := "open"
				for k, v := range zohoStatusMap {
					if v == event.Payload.Status {
						ourStatus = k
						break
					}
				}
				db.PGExec(ctx, `UPDATE helpdesk_tickets SET status=$1, zoho_synced_at=NOW() WHERE zoho_ticket_id=$2`, //nolint:errcheck
					ourStatus, zohoID)
			}
		}

		w.WriteHeader(200)
		w.Write([]byte(`{"ok":true}`)) //nolint:errcheck
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

		var result map[string]any
		json.NewDecoder(resp.Body).Decode(&result) //nolint:errcheck

		// Log call in our system
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

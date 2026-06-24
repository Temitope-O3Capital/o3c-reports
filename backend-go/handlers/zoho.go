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
	"strconv"
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
	r.Post("/org-id", zohoSetOrgID(db))
	r.Get("/webhooks/desk/recent", zohoWebhookDeskRecent(db))
	r.Post("/desk/sync", zohoPushTickets(db))
	r.Post("/desk/import", zohoImportTickets(db))
	r.Post("/desk/resync", zohoResyncTickets(db))
	r.Post("/desk/import-threads", zohoImportThreads(db))
	r.Post("/desk/tickets/{id}/push", zohoPushOneTicket(db))
	r.Post("/calls/import", zohoImportCalls(db))
	r.Post("/voice/import-logs", zohoImportVoiceLogs(db))
	r.Post("/voice/call", zohoInitiateCall(db))
	// Temporary debug proxy — admin only, returns raw Zoho API response
}

// ── Schema ────────────────────────────────────────────────────────────────────

func ensureZohoSchema(ctx context.Context, db *core.DB) {
	db.PGExec(ctx, `ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS zoho_ticket_id TEXT`)                                                     //nolint:errcheck
	db.PGExec(ctx, `ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS zoho_synced_at TIMESTAMPTZ`)                                              //nolint:errcheck
	db.PGExec(ctx, `CREATE UNIQUE INDEX IF NOT EXISTS idx_hd_tickets_zoho_id ON helpdesk_tickets(zoho_ticket_id) WHERE zoho_ticket_id IS NOT NULL`) //nolint:errcheck
	db.PGExec(ctx, `CREATE UNIQUE INDEX IF NOT EXISTS idx_hd_tickets_zoho_id_full ON helpdesk_tickets(zoho_ticket_id)`)                             //nolint:errcheck
}

func ensureZohoWebhookSchema(ctx context.Context, db *core.DB) {
	db.PGExec(ctx, `
		CREATE TABLE IF NOT EXISTS zoho_webhook_events (
		  id BIGSERIAL PRIMARY KEY,
		  event_type TEXT NOT NULL DEFAULT '',
		  zoho_ticket_id TEXT NOT NULL DEFAULT '',
		  action TEXT NOT NULL DEFAULT '',
		  status TEXT NOT NULL DEFAULT 'received',
		  detail TEXT NOT NULL DEFAULT '',
		  payload JSONB,
		  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`) //nolint:errcheck
	db.PGExec(ctx, `CREATE INDEX IF NOT EXISTS idx_zoho_webhook_events_created ON zoho_webhook_events(created_at DESC)`)                //nolint:errcheck
	db.PGExec(ctx, `CREATE INDEX IF NOT EXISTS idx_zoho_webhook_events_ticket ON zoho_webhook_events(zoho_ticket_id, created_at DESC)`) //nolint:errcheck
}

// ── Org ID helpers ────────────────────────────────────────────────────────────

// zohoFetchOrgID calls GET /organizations WITHOUT the orgId header (safe before org is known).
func zohoFetchOrgID(ctx context.Context) string {
	token, err := zohoAccessToken(ctx)
	if err != nil {
		return ""
	}
	req, err := http.NewRequestWithContext(ctx, "GET",
		"https://desk.zoho."+zohoDC+"/api/v1/organizations", nil)
	if err != nil {
		return ""
	}
	req.Header.Set("Authorization", "Zoho-oauthtoken "+token)
	resp, err := zohoHTTP.Do(req)
	if err != nil || resp.StatusCode != 200 {
		return ""
	}
	defer resp.Body.Close()
	var body map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return ""
	}
	for _, item := range zohoItems(body) {
		if id, _ := item["id"].(string); id != "" {
			return id
		}
	}
	return ""
}

// zohoSetOrgID lets an admin paste the org ID when auto-fetch fails.
func zohoSetOrgID(db *core.DB) http.HandlerFunc {
	type req struct {
		OrgID string `json:"org_id"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b req
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil || b.OrgID == "" {
			respondErr(w, 422, "org_id is required")
			return
		}
		ctx := r.Context()
		if err := saveZohoCred(ctx, db, "ZOHO_ORG_ID", "Zoho Desk Org ID", b.OrgID); err != nil {
			respondErr(w, 500, "Failed to save org ID")
			return
		}
		zohoOrgID = b.OrgID
		// Invalidate token cache so next call uses new org ID
		zohoTok.Lock()
		zohoTok.access = ""
		zohoTok.expires = time.Time{}
		zohoTok.Unlock()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "ok", "org_id": b.OrgID}) //nolint:errcheck
	}
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

func zohoEnsureConfigured(ctx context.Context, db *core.DB) bool {
	if zohoConfigured() {
		return true
	}
	updateLiveVars(ctx, db)
	return zohoConfigured()
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

		configured := zohoEnsureConfigured(ctx, db)

		result := map[string]any{
			"connected":         configured,
			"org_id":            coalesce(zohoOrgID, zohoCred(ctx, db, "ZOHO_ORG_ID")),
			"data_centre":       coalesce(zohoDC, "com"),
			"client_id_set":     zohoCred(ctx, db, "ZOHO_CLIENT_ID") != "" || zohoClientID != "",
			"client_secret_set": zohoCred(ctx, db, "ZOHO_CLIENT_SECRET") != "" || zohoClientSecret != "",
		}

		if configured {
			resp, err := zohoFetch(ctx, "tickets", url.Values{"limit": {"1"}})
			result["api_reachable"] = err == nil && resp["errorCode"] == nil
			if err != nil {
				result["api_error"] = err.Error()
			} else if resp["errorCode"] != nil {
				result["api_error"] = fmt.Sprintf("%v", resp["message"])
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
			url.QueryEscape("Desk.tickets.ALL,Desk.contacts.READ,Desk.agents.READ,Desk.events.ALL,Desk.calls.READ"),
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
		saveZohoCred(ctx, db, "ZOHO_REFRESH_TOKEN", "Zoho refresh token", tok.RefreshToken) //nolint:errcheck
		expiry := time.Now().Add(time.Duration(tok.ExpiresIn) * time.Second)
		saveZohoCred(ctx, db, "ZOHO_TOKEN_EXPIRY", "Zoho token expiry", expiry.Format(time.RFC3339)) //nolint:errcheck

		// Inject into live process
		zohoRefreshTok = tok.RefreshToken
		zohoTok.Lock()
		zohoTok.access = tok.AccessToken
		zohoTok.expires = expiry
		zohoTok.Unlock()

		// Auto-fetch org ID — use a direct call without orgId header
		// (zohoFetch always sets orgId which is empty at this point)
		if zohoOrgID == "" {
			if id := zohoFetchOrgID(ctx); id != "" {
				zohoOrgID = id
				saveZohoCred(ctx, db, "ZOHO_ORG_ID", "Zoho Desk Org ID (auto-fetched)", id) //nolint:errcheck
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

func zohoSyncTicketByID(ctx context.Context, db *core.DB, ticketID int64) (map[string]any, error) {
	if ticketID == 0 {
		return nil, fmt.Errorf("ticket id is required")
	}
	ensureZohoSchema(ctx, db)
	if !zohoEnsureConfigured(ctx, db) {
		return nil, fmt.Errorf("Zoho credentials are not configured")
	}
	tickets, err := db.PGQuery(ctx, `
		SELECT id, ticket_ref, subject, customer_name, customer_email, customer_phone,
		       status, priority, channel, zoho_ticket_id, department
		FROM helpdesk_tickets WHERE id=$1`, ticketID)
	if err != nil {
		return nil, err
	}
	if len(tickets) == 0 {
		return nil, fmt.Errorf("ticket not found")
	}
	return zohoSyncTicket(ctx, db, tickets[0])
}

func zohoSyncTicketByIDAsync(db *core.DB, ticketID int64, reason string) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if _, err := zohoSyncTicketByID(ctx, db, ticketID); err != nil {
			slog.Warn("zoho async ticket sync failed", "ticket_id", ticketID, "reason", reason, "err", err)
		}
	}()
}

func zohoPostTicketMessageAsync(db *core.DB, ticketID int64, localMessageID int64, bodyText string, isInternalNote bool) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		if _, err := zohoSyncTicketByID(ctx, db, ticketID); err != nil {
			slog.Warn("zoho message sync: ticket sync failed", "ticket_id", ticketID, "err", err)
			return
		}

		rows, err := db.PGQuery(ctx, `SELECT zoho_ticket_id FROM helpdesk_tickets WHERE id=$1`, ticketID)
		if err != nil || len(rows) == 0 {
			return
		}
		zohoTicketID := str(rows[0]["zoho_ticket_id"])
		if zohoTicketID == "" {
			return
		}

		payload := map[string]any{
			"content":  bodyText,
			"isPublic": !isInternalNote,
		}
		raw, _ := json.Marshal(payload)
		resp, err := zohoWrite(ctx, http.MethodPost, "tickets/"+zohoTicketID+"/comments", strings.NewReader(string(raw)))
		if err != nil {
			slog.Warn("zoho message sync failed", "ticket_id", ticketID, "err", err)
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
			slog.Warn("zoho message sync rejected", "ticket_id", ticketID, "status", resp.StatusCode, "body", strings.TrimSpace(string(body)))
			return
		}
		if localMessageID == 0 {
			return
		}
		var result map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
			return
		}
		if zohoThreadID := str(result["id"]); zohoThreadID != "" {
			db.PGExec(ctx, `UPDATE helpdesk_messages SET zoho_thread_id=$1 WHERE id=$2 AND zoho_thread_id IS NULL`, zohoThreadID, localMessageID) //nolint:errcheck
		}
	}()
}

// ── Shared ticket field extraction ───────────────────────────────────────────

// zohoTicketExtras extracts enriched fields from a raw Zoho ticket map.
func zohoTicketExtras(t map[string]any) (description string, slaDueAt *time.Time, csatScore *int, csatComment string, threadCount *int) {
	description, _ = t["description"].(string)
	csatComment, _ = t["ratingComment"].(string)

	if v, _ := t["dueDate"].(string); v != "" {
		if ts, err := time.Parse(time.RFC3339, v); err == nil {
			slaDueAt = &ts
		}
	}

	parseIntField := func(v any) *int {
		switch x := v.(type) {
		case float64:
			i := int(x)
			return &i
		case string:
			if i, err := strconv.Atoi(x); err == nil {
				return &i
			}
		}
		return nil
	}

	if r := t["rating"]; r != nil {
		if p := parseIntField(r); p != nil && *p >= 1 && *p <= 5 {
			csatScore = p
		}
	}
	if tc := t["threadCount"]; tc != nil {
		threadCount = parseIntField(tc)
	}
	return
}

// zohoFetchDeptNames returns a map of Zoho departmentId → readable name.
func zohoFetchDeptNames(ctx context.Context) map[string]string {
	result, err := zohoFetch(ctx, "departments", url.Values{"limit": {"50"}})
	out := map[string]string{}
	if err != nil {
		return out
	}
	for _, d := range zohoItems(result) {
		id, _ := d["id"].(string)
		name, _ := d["name"].(string)
		if id != "" && name != "" {
			out[id] = name
		}
	}
	return out
}

// zohoFetchAndStoreThreads fetches threads for one Zoho ticket and upserts them
// into helpdesk_messages. Safe to call concurrently (uses ON CONFLICT DO NOTHING).
func zohoFetchAndStoreThreads(ctx context.Context, db *core.DB, ticketID int64, zohoTicketID string) {
	db.PGExec(ctx, `ALTER TABLE helpdesk_messages ADD COLUMN IF NOT EXISTS zoho_thread_id TEXT`) //nolint:errcheck
	// Use non-partial unique index so ON CONFLICT DO NOTHING works without specifying WHERE
	db.PGExec(ctx, `CREATE UNIQUE INDEX IF NOT EXISTS idx_hd_messages_zoho_thread ON helpdesk_messages(zoho_thread_id) WHERE zoho_thread_id IS NOT NULL`) //nolint:errcheck

	result, err := zohoFetch(ctx, "tickets/"+zohoTicketID+"/threads", url.Values{
		"limit": {"50"},
	})
	if err != nil {
		slog.Warn("zohoFetchAndStoreThreads: fetch", "zoho_id", zohoTicketID, "err", err)
		return
	}

	for _, th := range zohoItems(result) {
		zohoThreadID, _ := th["id"].(string)
		if zohoThreadID == "" {
			continue
		}

		// Zoho thread shape: direction="in"/"out", visibility="public"/"private"
		// author.name / author.email hold the sender; no top-level fromDisplayName
		dirRaw, _ := th["direction"].(string)
		direction := "outbound"
		if strings.EqualFold(dirRaw, "in") {
			direction = "inbound"
		}
		visibility, _ := th["visibility"].(string)
		isNote := !strings.EqualFold(visibility, "public") // private = internal note

		// summary is the plain-text body in list view (full HTML only in single-thread fetch)
		bodyText, _ := th["summary"].(string)
		bodyText = strings.TrimSpace(bodyText)

		// author info lives in nested author object
		var authorName, authorEmail string
		if author, ok := th["author"].(map[string]any); ok {
			authorName, _ = author["name"].(string)
			authorEmail, _ = author["email"].(string)
		}
		if authorName == "" {
			authorName = authorEmail
		}

		var createdAt *time.Time
		if ct, _ := th["createdTime"].(string); ct != "" {
			if ts, err2 := time.Parse(time.RFC3339, ct); err2 == nil {
				createdAt = &ts
			}
		}
		if createdAt == nil {
			now := time.Now()
			createdAt = &now
		}

		channel, _ := th["channel"].(string)
		if channel == "" {
			channel = "email"
		}
		channel = strings.ToLower(channel)

		// Skip if already stored
		var exists bool
		db.PG.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM helpdesk_messages WHERE zoho_thread_id=$1)`, zohoThreadID).Scan(&exists) //nolint:errcheck
		if exists {
			continue
		}

		if _, err := db.PGExec(ctx, `
			INSERT INTO helpdesk_messages
			    (ticket_id, direction, channel, author_name, body_text, body_html,
			     is_internal_note, zoho_thread_id, created_at)
			VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8)`,
			ticketID, direction, channel,
			ptrOrNilStr(authorName),
			ptrOrNilStr(bodyText),
			isNote, zohoThreadID, createdAt); err != nil {
			slog.Warn("zohoFetchAndStoreThreads: insert", "thread_id", zohoThreadID, "err", err)
		}
	}
}

// ── Import: Zoho Desk → our system (historical pull) ─────────────────────────

// zohoImportTickets pages through all Zoho Desk tickets and upserts them into
// helpdesk_tickets. Safe to call repeatedly — uses zoho_ticket_id as the
// conflict key so duplicates are skipped.
func zohoImportTickets(db *core.DB) http.HandlerFunc {
	type reqBody struct {
		From     int `json:"from"`
		MaxPages int `json:"max_pages"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		ensureZohoSchema(ctx, db)
		if !zohoEnsureConfigured(ctx, db) {
			respondErr(w, 503, "Zoho credentials are not configured — set them in Admin → API Keys")
			return
		}

		var body reqBody
		_ = json.NewDecoder(r.Body).Decode(&body)
		var imported, skipped, failed int
		from := body.From
		if from < 0 {
			from = 0
		}
		limit := 50
		maxPages := body.MaxPages
		if maxPages <= 0 || maxPages > 10 {
			maxPages = 5
		}
		pagesFetched := 0
		done := false

		for pagesFetched < maxPages {
			result, err := zohoFetch(ctx, "tickets", url.Values{
				"from":    {strconv.Itoa(from)},
				"limit":   {strconv.Itoa(limit)},
				"sortBy":  {"createdTime"},
				"include": {"contacts,assignee"},
			})
			if err != nil {
				slog.Error("zohoImportTickets: fetch page", "from", from, "err", err)
				respondErr(w, 502, "Zoho Desk import failed: "+err.Error())
				return
			}

			items := zohoItems(result)
			if len(items) == 0 {
				done = true
				break
			}
			pagesFetched++

			for _, t := range items {
				zohoID, _ := t["id"].(string)
				if zohoID == "" {
					skipped++
					continue
				}

				// Don't re-import tickets we already have
				existing, _ := db.PGQuery(ctx, `SELECT id FROM helpdesk_tickets WHERE zoho_ticket_id=$1`, zohoID)
				if len(existing) > 0 {
					skipped++
					continue
				}

				subject, _ := t["subject"].(string)
				statusRaw, _ := t["status"].(string)
				priorityRaw, _ := t["priority"].(string)
				channelRaw, _ := t["channel"].(string)
				var deptName string
				if dept, ok := t["department"].(map[string]any); ok {
					deptName, _ = dept["name"].(string)
				}

				ourStatus := "open"
				for k, v := range zohoStatusMap {
					if strings.EqualFold(v, statusRaw) {
						ourStatus = k
						break
					}
				}
				ourPriority := "normal"
				for k, v := range zohoPriorityMap {
					if strings.EqualFold(v, priorityRaw) {
						ourPriority = k
						break
					}
				}
				ourChannel := zohoMapChannel(channelRaw)

				contactName, contactEmail, contactPhone := "", "", ""
				if contact, ok := t["contact"].(map[string]any); ok {
					contactName, _ = contact["firstName"].(string)
					if ln, _ := contact["lastName"].(string); ln != "" {
						if contactName != "" {
							contactName += " " + ln
						} else {
							contactName = ln
						}
					}
					contactEmail, _ = contact["email"].(string)
					contactPhone, _ = contact["phone"].(string)
				}

				var createdAt *time.Time
				if ct, _ := t["createdTime"].(string); ct != "" {
					if ts, err := time.Parse(time.RFC3339, ct); err == nil {
						createdAt = &ts
					}
				}

				description, slaDueAt, csatScore, csatComment, threadCount := zohoTicketExtras(t)

				_, err := db.PGExec(ctx, `
					INSERT INTO helpdesk_tickets
					    (channel, status, priority, subject, customer_name, customer_email,
					     customer_phone, department, zoho_department_name, description,
					     sla_due_at, csat_score, csat_comment, zoho_thread_count,
					     zoho_ticket_id, zoho_synced_at, created_at)
					VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW(),$16)
					ON CONFLICT (zoho_ticket_id) DO NOTHING`,
					ourChannel, ourStatus, ourPriority, subject,
					contactName, contactEmail, contactPhone,
					ptrOrNilStr(deptName), ptrOrNilStr(deptName), ptrOrNilStr(description),
					slaDueAt, csatScore, ptrOrNilStr(csatComment), threadCount,
					zohoID, createdAt)
				if err != nil {
					slog.Warn("zohoImportTickets: insert failed", "zoho_id", zohoID, "err", err)
					failed++
				} else {
					imported++
				}
			}

			if len(items) < limit {
				done = true
				break
			}
			from += limit
		}

		slog.Info("zohoImportTickets batch done", "imported", imported, "skipped", skipped, "failed", failed, "next_from", from, "done", done)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"imported":  imported,
			"skipped":   skipped,
			"failed":    failed,
			"next_from": from,
			"done":      done,
		})
	}
}

// zohoResyncTickets fetches all Zoho tickets and updates status/last-activity for
// ones we already have, and imports ones we don't.
func zohoResyncTickets(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		ensureZohoSchema(ctx, db)
		if !zohoEnsureConfigured(ctx, db) {
			respondErr(w, 503, "Zoho credentials are not configured — set them in Admin → API Keys")
			return
		}

		var updated, failed int
		// Start from tail - 500 so we get the most recently modified tickets.
		// Zoho rejects sortOrder=desc, so the tail = most recently modified.
		tail := zohoFindTailOffset(ctx)
		from := tail - 500
		if from < 0 {
			from = 0
		}
		limit := 50

		for {
			result, err := zohoFetch(ctx, "tickets", url.Values{
				"from":    {strconv.Itoa(from)},
				"limit":   {strconv.Itoa(limit)},
				"sortBy":  {"modifiedTime"},
				"include": {"contacts,assignee"},
			})
			if err != nil {
				respondErr(w, 502, "Zoho fetch failed: "+err.Error())
				return
			}
			items := zohoItems(result)
			if len(items) == 0 {
				break
			}

			for _, t := range items {
				zohoID, _ := t["id"].(string)
				if zohoID == "" {
					continue
				}
				statusRaw, _ := t["status"].(string)
				priorityRaw, _ := t["priority"].(string)
				channelRaw, _ := t["channel"].(string)
				subject, _ := t["subject"].(string)
				var deptName string
				if dept, ok := t["department"].(map[string]any); ok {
					deptName, _ = dept["name"].(string)
				}

				ourStatus := "open"
				for k, v := range zohoStatusMap {
					if strings.EqualFold(v, statusRaw) {
						ourStatus = k
						break
					}
				}
				ourPriority := "normal"
				for k, v := range zohoPriorityMap {
					if strings.EqualFold(v, priorityRaw) {
						ourPriority = k
						break
					}
				}
				ourChannel := zohoMapChannel(channelRaw)

				contactName, contactEmail, contactPhone := "", "", ""
				if contact, ok := t["contact"].(map[string]any); ok {
					contactName, _ = contact["firstName"].(string)
					if ln, _ := contact["lastName"].(string); ln != "" {
						if contactName != "" {
							contactName += " " + ln
						} else {
							contactName = ln
						}
					}
					contactEmail, _ = contact["email"].(string)
					contactPhone, _ = contact["phone"].(string)
				}

				var createdAt *time.Time
				if ct, _ := t["createdTime"].(string); ct != "" {
					if ts, err2 := time.Parse(time.RFC3339, ct); err2 == nil {
						createdAt = &ts
					}
				}

				description, slaDueAt, csatScore, csatComment, threadCount := zohoTicketExtras(t)

				_, err := db.PGExec(ctx, `
					INSERT INTO helpdesk_tickets
					    (channel, status, priority, subject, customer_name, customer_email,
					     customer_phone, department, zoho_department_name, description,
					     sla_due_at, csat_score, csat_comment, zoho_thread_count,
					     zoho_ticket_id, zoho_synced_at, created_at)
					VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW(),$16)
					ON CONFLICT (zoho_ticket_id) DO UPDATE
					  SET status=$2, priority=$3, subject=$4, customer_name=$5,
					      customer_email=$6, customer_phone=$7, department=$8,
					      zoho_department_name=$9, description=COALESCE(EXCLUDED.description, helpdesk_tickets.description),
					      sla_due_at=COALESCE(EXCLUDED.sla_due_at, helpdesk_tickets.sla_due_at),
					      csat_score=COALESCE(EXCLUDED.csat_score, helpdesk_tickets.csat_score),
					      csat_comment=COALESCE(EXCLUDED.csat_comment, helpdesk_tickets.csat_comment),
					      zoho_thread_count=EXCLUDED.zoho_thread_count,
					      zoho_synced_at=NOW()`,
					ourChannel, ourStatus, ourPriority, subject,
					contactName, contactEmail, contactPhone,
					ptrOrNilStr(deptName), ptrOrNilStr(deptName), ptrOrNilStr(description),
					slaDueAt, csatScore, ptrOrNilStr(csatComment), threadCount,
					zohoID, createdAt)
				if err != nil {
					failed++
				} else {
					updated++
				}
			}

			if len(items) < limit {
				break
			}
			from += limit
			if from > 2000 {
				break
			}
		}

		slog.Info("zohoResyncTickets done", "updated", updated, "failed", failed)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"synced": updated, "failed": failed}) //nolint:errcheck
	}
}

// zohoImportCalls pulls calls from Zoho Desk and inserts them into helpdesk_calls.
// Requires zoho_call_id column for dedup (added lazily).
func zohoImportCalls(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		if !zohoEnsureConfigured(ctx, db) {
			respondErr(w, 503, "Zoho credentials are not configured — set them in Admin → API Keys")
			return
		}
		if err := ensureCallLogSchema(ctx, db); err != nil {
			respondErr(w, 500, "Call log schema setup failed")
			return
		}

		var imported, skipped, failed int
		var minStartedAt, maxStartedAt time.Time
		from := 0
		limit := 50
		maxPages := 10

		for page := 0; page < maxPages; page++ {
			result, err := zohoFetch(ctx, "calls", url.Values{
				"from":   {strconv.Itoa(from)},
				"limit":  {strconv.Itoa(limit)},
				"sortBy": {"startTime"},
			})
			if err != nil {
				slog.Error("zohoImportCalls: fetch page", "from", from, "err", err)
				break
			}
			items := zohoItems(result)
			if len(items) == 0 {
				break
			}

			for _, c := range items {
				zohoCallID, _ := c["id"].(string)
				if zohoCallID == "" {
					skipped++
					continue
				}

				// Direction
				callType, _ := c["type"].(string)
				direction := "inbound"
				if strings.EqualFold(callType, "OUTBOUND") {
					direction = "outbound"
				}

				// Outcome
				status, _ := c["status"].(string)
				outcome := "missed"
				switch strings.ToUpper(status) {
				case "ANSWERED", "COMPLETED":
					outcome = "resolved"
				case "TRANSFERRED":
					outcome = "transferred"
				}

				// Duration
				var durSec *int
				if d, ok := c["duration"]; ok {
					switch v := d.(type) {
					case float64:
						i := int(v)
						durSec = &i
					case string:
						if i, err2 := strconv.Atoi(v); err2 == nil {
							durSec = &i
						}
					}
				}

				// Agent
				agentName := ""
				if agent, ok := c["agent"].(map[string]any); ok {
					agentName, _ = agent["name"].(string)
					if agentName == "" {
						agentName, _ = agent["firstName"].(string)
					}
				}

				// Contact
				customerName, customerPhone, customerEmail := "", "", ""
				if contact, ok := c["contact"].(map[string]any); ok {
					fn, _ := contact["firstName"].(string)
					ln, _ := contact["lastName"].(string)
					if fn != "" || ln != "" {
						customerName = strings.TrimSpace(fn + " " + ln)
					}
					customerPhone, _ = contact["phone"].(string)
					customerEmail, _ = contact["email"].(string)
				}
				if customerPhone == "" {
					customerPhone, _ = c["callFrom"].(string)
				}

				// Start time
				startedAt := time.Now()
				if ts := zohoParseMillisTime(c["startTime"]); !ts.IsZero() {
					startedAt = ts
				} else if st, _ := c["startTime"].(string); st != "" {
					if ts, err2 := time.Parse(time.RFC3339, st); err2 == nil {
						startedAt = ts
					}
				}
				zohoTrackDateRange(startedAt, &minStartedAt, &maxStartedAt)

				res, err := db.PGExec(ctx, `
					INSERT INTO helpdesk_calls
					    (agent_name, customer_name, customer_phone, customer_email,
					     direction, duration_sec, outcome, started_at, zoho_call_id)
					VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
					ON CONFLICT DO NOTHING`,
					agentName, customerName, customerPhone, customerEmail,
					direction, durSec, outcome, startedAt, zohoCallID)
				if err != nil {
					slog.Warn("zohoImportCalls: insert failed", "zoho_call_id", zohoCallID, "err", err)
					failed++
				} else {
					if n, _ := res.RowsAffected(); n > 0 {
						imported++
					} else {
						skipped++
					}
				}
			}

			if len(items) < limit {
				break
			}
			from += limit
		}

		slog.Info("zohoImportCalls done", "imported", imported, "skipped", skipped, "failed", failed)
		w.Header().Set("Content-Type", "application/json")
		out := map[string]any{"imported": imported, "skipped": skipped, "failed": failed}
		if !minStartedAt.IsZero() {
			out["date_from"] = minStartedAt.Format("2006-01-02")
			out["date_to"] = maxStartedAt.Format("2006-01-02")
		}
		json.NewEncoder(w).Encode(out) //nolint:errcheck
	}
}

// zohoImportThreads fetches message threads for Zoho tickets and stores them in
// helpdesk_messages. On first run processes all tickets with no messages; on
// subsequent runs only tickets modified in the last 7 days.
func zohoImportThreads(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		if !zohoEnsureConfigured(ctx, db) {
			respondErr(w, 503, "Zoho credentials not configured")
			return
		}
		// Ensure dedup index exists
		db.PGExec(ctx, `ALTER TABLE helpdesk_messages ADD COLUMN IF NOT EXISTS zoho_thread_id TEXT`)                                                          //nolint:errcheck
		db.PGExec(ctx, `CREATE UNIQUE INDEX IF NOT EXISTS idx_hd_messages_zoho_thread ON helpdesk_messages(zoho_thread_id) WHERE zoho_thread_id IS NOT NULL`) //nolint:errcheck

		// Optional: process only a specific ticket
		onlyZohoID := r.URL.Query().Get("zoho_id")

		// Pick tickets to process
		var ticketQuery string
		var ticketArgs []any
		if onlyZohoID != "" {
			ticketQuery = `SELECT id, zoho_ticket_id FROM helpdesk_tickets WHERE zoho_ticket_id=$1`
			ticketArgs = []any{onlyZohoID}
		} else {
			// All tickets with no messages yet, plus recently-synced ones
			ticketQuery = `
				SELECT t.id, t.zoho_ticket_id
				FROM helpdesk_tickets t
				WHERE t.zoho_ticket_id IS NOT NULL
				  AND (
				    (SELECT COUNT(*) FROM helpdesk_messages m WHERE m.ticket_id=t.id) = 0
				    OR t.zoho_synced_at > NOW() - INTERVAL '7 days'
				  )
				ORDER BY t.created_at DESC
				LIMIT 200`
		}

		tickets, err := db.PGQuery(ctx, ticketQuery, ticketArgs...)
		if err != nil {
			respondErr(w, 500, "DB error: "+err.Error())
			return
		}

		var imported, skipped, failed int
		for _, ticket := range tickets {
			zohoID, _ := ticket["zoho_ticket_id"].(string)
			ticketID := toInt64(ticket["id"])
			if zohoID == "" {
				continue
			}

			// Fetch threads for this ticket
			result, err := zohoFetch(ctx, "tickets/"+zohoID+"/threads", url.Values{
				"limit": {"50"},
			})
			if err != nil {
				slog.Warn("zohoImportThreads: fetch threads", "zoho_id", zohoID, "err", err)
				failed++
				continue
			}

			threads := zohoItems(result)
			for _, th := range threads {
				zohoThreadID, _ := th["id"].(string)
				if zohoThreadID == "" {
					skipped++
					continue
				}

				// Actual Zoho thread shape (confirmed via API test):
				// direction = "in" | "out"   (not "inbound"/"outbound")
				// visibility = "public" | "private"  (private = internal note)
				// author = {name, email, ...}   (no top-level fromDisplayName)
				// summary = plain-text body in list view (content only in single-thread fetch)
				dirRaw, _ := th["direction"].(string)
				direction := "outbound"
				if strings.EqualFold(dirRaw, "in") {
					direction = "inbound"
				}
				visibility, _ := th["visibility"].(string)
				isNote := !strings.EqualFold(visibility, "public")

				bodyText, _ := th["summary"].(string)
				bodyText = strings.TrimSpace(bodyText)

				var authorName string
				if author, ok := th["author"].(map[string]any); ok {
					authorName, _ = author["name"].(string)
					if authorName == "" {
						authorName, _ = author["email"].(string)
					}
				}

				var createdAt *time.Time
				if ct, _ := th["createdTime"].(string); ct != "" {
					if ts, err2 := time.Parse(time.RFC3339, ct); err2 == nil {
						createdAt = &ts
					}
				}
				if createdAt == nil {
					now := time.Now()
					createdAt = &now
				}

				channel, _ := th["channel"].(string)
				if channel == "" {
					channel = "EMAIL"
				}
				channel = strings.ToLower(channel)

				// Use EXISTS check instead of ON CONFLICT on partial index
				var exists bool
				db.PG.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM helpdesk_messages WHERE zoho_thread_id=$1)`, zohoThreadID).Scan(&exists) //nolint:errcheck
				if exists {
					skipped++
					continue
				}

				_, err := db.PGExec(ctx, `
					INSERT INTO helpdesk_messages
					    (ticket_id, direction, channel, author_name, body_text, body_html,
					     is_internal_note, zoho_thread_id, created_at)
					VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8)`,
					ticketID, direction, channel,
					ptrOrNilStr(authorName),
					ptrOrNilStr(bodyText),
					isNote, zohoThreadID, createdAt)
				if err != nil {
					slog.Warn("zohoImportThreads: insert", "thread_id", zohoThreadID, "ticket_id", ticketID, "err", err)
					failed++
				} else {
					imported++
				}
			}
		}

		slog.Info("zohoImportThreads done", "imported", imported, "skipped", skipped, "failed", failed, "tickets", len(tickets))
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"imported": imported,
			"skipped":  skipped,
			"failed":   failed,
			"tickets":  len(tickets),
		})
	}
}

// zohoImportVoiceLogs pulls call records from the Zoho Voice API
// (voice.zoho.{DC}/rest/json/zv/logs) — separate from Zoho Desk calls.
// Requires the ZohoVoice.call.READ OAuth scope.
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

		// Date range: default last 30 days. Zoho Voice documents fromDate/toDate
		// on /logs; the frontend sends ISO yyyy-mm-dd values.
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

			// Voice API returns "logs"; keep fallback shapes for older responses.
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

func zohoMapChannel(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "email", "mail":
		return "email"
	case "sms":
		return "sms"
	case "whatsapp", "whats_app":
		return "whatsapp"
	case "phone", "telephone", "call":
		return "phone"
	case "web", "portal", "chat", "live chat", "social", "twitter", "facebook", "forum":
		return "in_app"
	default:
		return "in_app"
	}
}

// ── Webhook: Zoho Desk → our system ──────────────────────────────────────────

func zohoWebhookPayload(raw map[string]any) map[string]any {
	for _, key := range []string{"payload", "data", "ticket", "resource"} {
		if p, ok := raw[key].(map[string]any); ok {
			return p
		}
	}
	return raw
}

func zohoFirstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func zohoWebhookEvent(raw map[string]any) string {
	for _, key := range []string{"eventType", "event_type", "event", "type", "action"} {
		if v := strings.TrimSpace(str(raw[key])); v != "" {
			v = strings.ToLower(v)
			replacer := strings.NewReplacer("_", "", "-", "", " ", "", ".", "")
			return replacer.Replace(v)
		}
	}
	return ""
}

func zohoWebhookTicketID(raw, payload map[string]any) string {
	candidates := []any{
		payload["ticketId"], payload["ticketID"], payload["ticket_id"], payload["id"],
		raw["ticketId"], raw["ticketID"], raw["ticket_id"],
	}
	if t, ok := payload["ticket"].(map[string]any); ok {
		candidates = append(candidates, t["id"], t["ticketId"], t["ticketID"])
	}
	if c, ok := payload["call"].(map[string]any); ok {
		candidates = append(candidates, c["ticketId"], c["ticketID"], c["ticket_id"])
	}
	for _, v := range candidates {
		if s := str(v); s != "" {
			return s
		}
	}
	return ""
}

func zohoLocalStatus(raw string) string {
	for k, v := range zohoStatusMap {
		if strings.EqualFold(v, raw) || strings.EqualFold(k, raw) {
			return k
		}
	}
	return "open"
}

func zohoLocalPriority(raw string) string {
	for k, v := range zohoPriorityMap {
		if strings.EqualFold(v, raw) || strings.EqualFold(k, raw) {
			return k
		}
	}
	return "normal"
}

func zohoWebhookFetchTicket(ctx context.Context, zohoID string) map[string]any {
	if zohoID == "" {
		return nil
	}
	result, err := zohoFetch(ctx, "tickets/"+zohoID, url.Values{"include": {"contacts,assignee,departments"}})
	if err != nil {
		slog.Warn("zoho webhook: fetch ticket failed", "zoho_id", zohoID, "err", err)
		return nil
	}
	if data, ok := result["data"].(map[string]any); ok {
		return data
	}
	return result
}

func zohoUpsertWebhookTicket(ctx context.Context, db *core.DB, raw, payload map[string]any) int64 {
	ensureZohoSchema(ctx, db)
	zohoID := zohoWebhookTicketID(raw, payload)
	if zohoID == "" {
		return 0
	}

	if fetched := zohoWebhookFetchTicket(ctx, zohoID); fetched != nil {
		for k, v := range fetched {
			if payload[k] == nil || str(payload[k]) == "" {
				payload[k] = v
			}
		}
	}

	subject := coalesce(str(payload["subject"]), str(payload["title"]))
	status := zohoLocalStatus(str(payload["status"]))
	priority := zohoLocalPriority(str(payload["priority"]))
	channel := zohoMapChannel(coalesce(str(payload["channel"]), "email"))

	contactName := coalesce(str(payload["customerName"]), str(payload["contactName"]))
	contactEmail := coalesce(str(payload["email"]), str(payload["customerEmail"]))
	contactPhone := coalesce(str(payload["phone"]), str(payload["customerPhone"]))
	if contact, ok := payload["contact"].(map[string]any); ok {
		first := coalesce(str(contact["firstName"]), str(contact["first_name"]))
		last := coalesce(str(contact["lastName"]), str(contact["last_name"]))
		if contactName == "" {
			contactName = strings.TrimSpace(first + " " + last)
		}
		if contactEmail == "" {
			contactEmail = str(contact["email"])
		}
		if contactPhone == "" {
			contactPhone = coalesce(str(contact["phone"]), str(contact["mobile"]))
		}
	}

	deptName := ""
	if dept, ok := payload["department"].(map[string]any); ok {
		deptName = str(dept["name"])
	} else {
		deptName = str(payload["department"])
	}

	var createdAt *time.Time
	if ct := coalesce(str(payload["createdTime"]), str(payload["created_at"])); ct != "" {
		if ts, err := time.Parse(time.RFC3339, ct); err == nil {
			createdAt = &ts
		}
	}
	description, slaDueAt, csatScore, csatComment, threadCount := zohoTicketExtras(payload)

	rows, err := db.PGQuery(ctx, `
		INSERT INTO helpdesk_tickets
		    (channel, status, priority, subject, customer_name, customer_email,
		     customer_phone, department, zoho_department_name, description,
		     sla_due_at, csat_score, csat_comment, zoho_thread_count,
		     zoho_ticket_id, zoho_synced_at, created_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW(),COALESCE($16,NOW()))
		ON CONFLICT (zoho_ticket_id) DO UPDATE
		  SET channel=EXCLUDED.channel,
		      status=EXCLUDED.status,
		      priority=EXCLUDED.priority,
		      subject=COALESCE(NULLIF(EXCLUDED.subject,''), helpdesk_tickets.subject),
		      customer_name=COALESCE(NULLIF(EXCLUDED.customer_name,''), helpdesk_tickets.customer_name),
		      customer_email=COALESCE(NULLIF(EXCLUDED.customer_email,''), helpdesk_tickets.customer_email),
		      customer_phone=COALESCE(NULLIF(EXCLUDED.customer_phone,''), helpdesk_tickets.customer_phone),
		      department=COALESCE(NULLIF(EXCLUDED.department,''), helpdesk_tickets.department),
		      zoho_department_name=COALESCE(NULLIF(EXCLUDED.zoho_department_name,''), helpdesk_tickets.zoho_department_name),
		      description=COALESCE(EXCLUDED.description, helpdesk_tickets.description),
		      sla_due_at=COALESCE(EXCLUDED.sla_due_at, helpdesk_tickets.sla_due_at),
		      csat_score=COALESCE(EXCLUDED.csat_score, helpdesk_tickets.csat_score),
		      csat_comment=COALESCE(EXCLUDED.csat_comment, helpdesk_tickets.csat_comment),
		      zoho_thread_count=COALESCE(EXCLUDED.zoho_thread_count, helpdesk_tickets.zoho_thread_count),
		      zoho_synced_at=NOW(),
		      updated_at=NOW()
		RETURNING id`,
		channel, status, priority, subject,
		contactName, contactEmail, contactPhone,
		ptrOrNilStr(deptName), ptrOrNilStr(deptName), ptrOrNilStr(description),
		slaDueAt, csatScore, ptrOrNilStr(csatComment), threadCount,
		zohoID, createdAt)
	if err != nil {
		slog.Warn("zoho webhook: upsert ticket failed", "zoho_id", zohoID, "err", err)
		return 0
	}
	if len(rows) == 0 {
		return 0
	}
	ticketID := toInt64(rows[0]["id"])
	go zohoFetchAndStoreThreads(context.Background(), db, ticketID, zohoID)
	return ticketID
}

func zohoLogWebhookEvent(ctx context.Context, db *core.DB, eventType, zohoTicketID, action, status, detail string, raw map[string]any) {
	ensureZohoWebhookSchema(ctx, db)
	payload := []byte("{}")
	if raw != nil {
		if b, err := json.Marshal(raw); err == nil {
			payload = b
		}
	}
	db.PGExec(ctx, `
		INSERT INTO zoho_webhook_events
		    (event_type, zoho_ticket_id, action, status, detail, payload)
		VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
		eventType, zohoTicketID, action, status, detail, string(payload)) //nolint:errcheck
}

func zohoWebhookDeskRecent(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		ensureZohoWebhookSchema(ctx, db)
		limit := qint(r, "limit", 25, 1, 100)
		rows, err := db.PGQuery(ctx, `
			SELECT id, event_type, zoho_ticket_id, action, status, detail, created_at
			FROM zoho_webhook_events
			ORDER BY created_at DESC
			LIMIT $1`, limit)
		if err != nil {
			respondErr(w, 500, "Webhook event query failed")
			return
		}
		jsonRows(w, rows)
	}
}

func zohoWebhookDesk(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if secret := zohoCred(r.Context(), db, "ZOHO_WEBHOOK_SECRET"); secret != "" {
			got := r.Header.Get("X-O3C-Webhook-Secret")
			if got == "" {
				got = r.URL.Query().Get("secret")
			}
			if got != secret {
				respondErr(w, 401, "Invalid webhook secret")
				return
			}
		}

		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if err != nil {
			respondErr(w, 400, "Read error")
			return
		}

		// Zoho sends either a flat payload or a nested one depending on event type
		var raw map[string]any
		if err := json.Unmarshal(body, &raw); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}

		eventType := zohoWebhookEvent(raw)
		payload := zohoWebhookPayload(raw)

		ctx := r.Context()
		ensureZohoSchema(ctx, db)
		zohoTicketID := zohoWebhookTicketID(raw, payload)
		action := "ignored"
		status := "ignored"
		detail := "Event type did not match a supported ticket, message, or call event"
		defer func() {
			zohoLogWebhookEvent(context.Background(), db, eventType, zohoTicketID, action, status, detail, raw)
		}()

		switch {
		case strings.Contains(eventType, "ticket") && (strings.Contains(eventType, "create") || strings.Contains(eventType, "add")):
			if zohoTicketID == "" {
				detail = "Missing Zoho ticket ID"
				break
			}
			if ticketID := zohoUpsertWebhookTicket(ctx, db, raw, payload); ticketID > 0 {
				action = "ticket_upserted"
				status = "ok"
				detail = fmt.Sprintf("O3 ticket %d upserted from Zoho ticket create", ticketID)
			} else {
				status = "failed"
				detail = "Ticket create event received but O3 upsert failed"
			}

		case strings.Contains(eventType, "ticket") && (strings.Contains(eventType, "update") || strings.Contains(eventType, "status") || strings.Contains(eventType, "edit")):
			if zohoTicketID == "" {
				detail = "Missing Zoho ticket ID"
				break
			}
			if ticketID := zohoUpsertWebhookTicket(ctx, db, raw, payload); ticketID > 0 {
				action = "ticket_upserted"
				status = "ok"
				detail = fmt.Sprintf("O3 ticket %d upserted from Zoho ticket update", ticketID)
			} else {
				status = "failed"
				detail = "Ticket update event received but O3 upsert failed"
			}

		case strings.Contains(eventType, "comment") || strings.Contains(eventType, "thread") || strings.Contains(eventType, "reply"):
			// A new message/reply was posted on a ticket — insert into helpdesk_messages
			if zohoTicketID == "" {
				detail = "Missing Zoho ticket ID"
				break
			}
			ticketID := zohoUpsertWebhookTicket(ctx, db, raw, payload)
			ticketRows, _ := db.PGQuery(ctx, `SELECT id FROM helpdesk_tickets WHERE zoho_ticket_id=$1`, zohoTicketID)
			if ticketID == 0 && len(ticketRows) > 0 {
				ticketID = toInt64(ticketRows[0]["id"])
			}
			if ticketID == 0 {
				status = "failed"
				detail = "Message event received but O3 ticket could not be found or created"
				break
			}

			comment, _ := payload["comment"].(map[string]any)
			if comment == nil {
				if thread, ok := payload["thread"].(map[string]any); ok {
					comment = thread
				} else {
					comment = payload
				}
			}
			zohoMsgID := zohoFirstNonEmpty(str(comment["id"]), str(comment["threadId"]), str(comment["commentId"]))

			dirRaw := coalesce(str(comment["direction"]), str(comment["type"]))
			isPublic, _ := comment["isPublic"].(bool)
			bodyText := zohoFirstNonEmpty(str(comment["content"]), str(comment["body"]), str(comment["summary"]))
			authorName := str(comment["author"])
			if am, ok := comment["commentedBy"].(map[string]any); ok {
				authorName, _ = am["name"].(string)
			} else if am, ok := comment["author"].(map[string]any); ok {
				authorName, _ = am["name"].(string)
			}

			direction := "outbound"
			if strings.EqualFold(dirRaw, "in") || strings.EqualFold(dirRaw, "inbound") || strings.EqualFold(dirRaw, "incoming") {
				direction = "inbound"
			}
			isNote := !isPublic

			var msgCreatedAt *time.Time
			if ct, _ := comment["createdTime"].(string); ct != "" {
				if ts, err2 := time.Parse(time.RFC3339, ct); err2 == nil {
					msgCreatedAt = &ts
				}
			}
			if msgCreatedAt == nil {
				now := time.Now()
				msgCreatedAt = &now
			}

			res, err := db.PGExec(ctx, `
				INSERT INTO helpdesk_messages
				    (ticket_id, direction, channel, author_name, body_text, is_internal_note, zoho_thread_id, created_at)
				VALUES ($1,$2,'email',$3,$4,$5,$6,$7)
				ON CONFLICT DO NOTHING`,
				ticketID, direction, ptrOrNilStr(authorName), ptrOrNilStr(bodyText), isNote, zohoMsgID, msgCreatedAt)
			if err != nil {
				status = "failed"
				detail = "Message insert failed: " + err.Error()
			} else if n, _ := res.RowsAffected(); n > 0 {
				action = "message_inserted"
				status = "ok"
				detail = fmt.Sprintf("Message inserted on O3 ticket %d", ticketID)
			} else {
				action = "message_duplicate"
				status = "ok"
				detail = fmt.Sprintf("Duplicate message ignored on O3 ticket %d", ticketID)
			}

		case strings.Contains(eventType, "call"):
			// A call was logged in Zoho Desk — insert into helpdesk_calls
			call, _ := payload["call"].(map[string]any)
			if call == nil {
				call = payload
			}
			zohoCallID := zohoFirstNonEmpty(str(call["id"]), str(call["callId"]), str(call["call_id"]))
			if zohoCallID == "" {
				detail = "Missing Zoho call ID"
				break
			}
			if err := ensureCallLogSchema(ctx, db); err != nil {
				slog.Warn("zoho webhook: call schema failed", "err", err)
				status = "failed"
				detail = "Call schema setup failed: " + err.Error()
				break
			}

			callType := zohoFirstNonEmpty(str(call["type"]), str(call["callType"]), str(call["direction"]))
			direction := "inbound"
			if strings.EqualFold(callType, "OUTBOUND") || strings.EqualFold(callType, "outgoing") {
				direction = "outbound"
			}

			statusStr := str(call["status"])
			outcome := "missed"
			if strings.EqualFold(statusStr, "ANSWERED") || strings.EqualFold(statusStr, "COMPLETED") {
				outcome = "resolved"
			}

			durSec := zohoParseDurationSec(call["duration"])
			agentName := coalesce(str(call["agentName"]), str(call["agent_name"]))
			customerPhone := zohoFirstNonEmpty(str(call["callFrom"]), str(call["from"]), str(call["caller_id_number"]))

			startedAt := time.Now()
			if ts := zohoParseMillisTime(call["startTime"]); !ts.IsZero() {
				startedAt = ts
			} else if ts := zohoParseMillisTime(call["start_time"]); !ts.IsZero() {
				startedAt = ts
			} else if st := coalesce(str(call["startTime"]), str(call["start_time"])); st != "" {
				if ts, err2 := time.Parse(time.RFC3339, st); err2 == nil {
					startedAt = ts
				}
			}
			var ticketID any
			if zohoTicketID != "" {
				if rows, _ := db.PGQuery(ctx, `SELECT id FROM helpdesk_tickets WHERE zoho_ticket_id=$1`, zohoTicketID); len(rows) > 0 {
					ticketID = toInt64(rows[0]["id"])
				}
			}

			res, err := db.PGExec(ctx, `
				INSERT INTO helpdesk_calls
				    (agent_name, customer_phone, direction, duration_sec, outcome, started_at, zoho_call_id, ticket_id)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
				ON CONFLICT DO NOTHING`,
				ptrOrNilStr(agentName), ptrOrNilStr(customerPhone), direction, durSec, outcome, startedAt, zohoCallID, ticketID)
			if err != nil {
				status = "failed"
				detail = "Call insert failed: " + err.Error()
			} else if n, _ := res.RowsAffected(); n > 0 {
				action = "call_inserted"
				status = "ok"
				detail = "Call inserted into O3 call log"
			} else {
				action = "call_duplicate"
				status = "ok"
				detail = "Duplicate call ignored"
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

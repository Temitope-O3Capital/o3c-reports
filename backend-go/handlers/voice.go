package handlers

// Zoho Voice per-user OAuth — lets each agent connect their own Zoho Voice
// account so the WebSDK can be initialised with a fresh per-user access token.
//
// Routes (registered in main.go):
//   Public  (no auth):  GET  /api/voice/callback
//   Protected (JWT):    GET  /api/voice/status
//                       GET  /api/voice/connect
//                       DELETE /api/voice/disconnect
//
// Tokens are stored encrypted in four new columns on o3c_users
// (migration 024_voice_oauth_columns.sql).

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"time"

	"github.com/o3c/reports/core"
)

// ── helpers ───────────────────────────────────────────────────────────────────

func voiceBackendURL() string {
	if v := os.Getenv("BACKEND_URL"); v != "" {
		return v
	}
	return "https://o3c-reports-production.up.railway.app"
}

func voiceFrontendURL() string {
	if v := os.Getenv("FRONTEND_URL"); v != "" {
		return v
	}
	return "https://o3c-reports.pages.dev"
}

func voiceRedirectURI() string {
	return voiceBackendURL() + "/api/voice/callback"
}

// voiceRefreshUserToken exchanges a stored refresh token for a new access token.
// It returns the access token and its expiry. The caller is responsible for
// persisting the new values.
func voiceRefreshUserToken(ctx context.Context, refreshToken string) (accessToken string, expiry time.Time, err error) {
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

// fetchZohoUserInfo calls Zoho's userinfo endpoint and returns the authenticated
// Zoho account's email. Useful for diagnosing OAuth mismatches.
func fetchZohoUserInfo(ctx context.Context, accessToken string) string {
	reqURL := "https://accounts.zoho." + zohoDC + "/oauth/user/info"
	req, err := http.NewRequestWithContext(ctx, "GET", reqURL, nil)
	if err != nil {
		return ""
	}
	req.Header.Set("Authorization", "Zoho-oauthtoken " + accessToken)
	req.Header.Set("Accept", "application/json")

	resp, err := zohoHTTP.Do(req)
	if err != nil {
		return ""
	}
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()

	slog.Info("voice: userinfo API", "status", resp.StatusCode, "body", string(raw))

	var info map[string]any
	if json.Unmarshal(raw, &info) != nil {
		return ""
	}
	// Zoho returns Email, email, or email_id depending on the DC.
	for _, k := range []string{"Email", "email", "email_id", "login_id"} {
		if v, _ := info[k].(string); v != "" {
			return v
		}
	}
	return ""
}

// fetchZohoVoiceAgentID calls the Zoho Voice users API and returns the numeric
// agent ID matching the given email.  The response format varies by Zoho
// datacenter and API version, so we probe multiple envelope shapes.
func fetchZohoVoiceAgentID(ctx context.Context, accessToken, email string) string {
	reqURL := "https://voice.zoho." + zohoDC + "/rest/json/zv/api/users"
	req, err := http.NewRequestWithContext(ctx, "GET", reqURL, nil)
	if err != nil {
		return ""
	}
	req.Header.Set("Authorization", "Zoho-oauthtoken "+accessToken)
	req.Header.Set("Accept", "application/json")

	resp, err := zohoHTTP.Do(req)
	if err != nil {
		return ""
	}
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()

	slog.Info("voice: users API", "status", resp.StatusCode, "body", string(raw))

	// Parse as generic map to handle multiple envelope shapes.
	var top any
	if json.Unmarshal(raw, &top) != nil {
		return ""
	}

	// Collect the user list from whichever envelope shape Zoho used.
	var users []map[string]any
	switch v := top.(type) {
	case []any:
		// Bare array at root.
		for _, item := range v {
			if m, ok := item.(map[string]any); ok {
				users = append(users, m)
			}
		}
	case map[string]any:
		// Try common wrapper keys in order of likelihood.
		for _, key := range []string{"data", "users", "agents", "result", "response"} {
			switch inner := v[key].(type) {
			case []any:
				for _, item := range inner {
					if m, ok := item.(map[string]any); ok {
						users = append(users, m)
					}
				}
				if len(users) > 0 {
					break
				}
			case map[string]any:
				// One more level: {"response": {"data": [...]}}
				for _, k2 := range []string{"data", "users", "agents"} {
					if arr, ok := inner[k2].([]any); ok {
						for _, item := range arr {
							if m, ok2 := item.(map[string]any); ok2 {
								users = append(users, m)
							}
						}
					}
				}
			}
			if len(users) > 0 {
				break
			}
		}
	}

	slog.Info("voice: users API parsed", "count", len(users), "looking_for", email)

	// Find the user whose email matches.
	for _, u := range users {
		var userEmail string
		for _, ek := range []string{"email", "Email", "email_id", "emailId", "emailid", "login_id"} {
			if e, _ := u[ek].(string); e != "" {
				userEmail = e
				break
			}
		}
		if userEmail == "" || userEmail != email {
			continue
		}
		// Found — extract the ID.
		for _, ik := range []string{"id", "Id", "user_id", "userId", "agent_id", "agentId"} {
			switch idv := u[ik].(type) {
			case string:
				if idv != "" {
					return idv
				}
			case float64:
				if idv != 0 {
					return fmt.Sprintf("%.0f", idv)
				}
			}
		}
	}
	return ""
}

// ── VoiceStatus ───────────────────────────────────────────────────────────────

// VoiceStatus returns the current user's Zoho Voice connection state.
// If the access token is expired but a refresh token is present it silently
// refreshes and returns the new access token.
func VoiceStatus(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}

		rows, err := db.PGQuery(ctx, `
			SELECT email, full_name,
			       zoho_voice_refresh_token,
			       zoho_voice_access_token,
			       zoho_voice_token_expiry,
			       zoho_voice_connected_at,
			       zoho_voice_agent_id
			FROM o3c_users WHERE id=$1`, user.ID)
		if err != nil || len(rows) == 0 {
			respondErr(w, 500, "DB error")
			return
		}
		row := rows[0]

		email, _ := row["email"].(string)
		fullName, _ := row["full_name"].(string)
		encRefresh, _ := row["zoho_voice_refresh_token"].(string)
		encAccess, _ := row["zoho_voice_access_token"].(string)
		expiryRaw := row["zoho_voice_token_expiry"]
		connectedAt := row["zoho_voice_connected_at"]
		agentID, _ := row["zoho_voice_agent_id"].(string)

		if encRefresh == "" {
			writeVoiceStatus(w, false, "", false, nil, email, "", fullName, "")
			return
		}

		refreshToken, err := decryptValue(encRefresh)
		if err != nil || refreshToken == "" {
			writeVoiceStatus(w, false, "", false, nil, email, "", fullName, "")
			return
		}

		var expiry time.Time
		if t, ok := expiryRaw.(time.Time); ok {
			expiry = t
		}

		tokenValid := encAccess != "" && time.Now().Add(60*time.Second).Before(expiry)

		accessToken := ""
		refreshed := false
		if tokenValid {
			accessToken, _ = decryptValue(encAccess)
		} else {
			newAccess, newExpiry, err := voiceRefreshUserToken(ctx, refreshToken)
			if err != nil {
				slog.Warn("voice token refresh failed", "user_id", user.ID, "err", err)
				writeVoiceStatus(w, true, "", false, connectedAt, email, agentID, fullName, "")
				return
			}
			encA, err := encryptValue(newAccess)
			if err == nil {
				db.PGExec(ctx, `
					UPDATE o3c_users
					SET zoho_voice_access_token=$1, zoho_voice_token_expiry=$2
					WHERE id=$3`,
					encA, newExpiry, user.ID) //nolint:errcheck
			}
			accessToken = newAccess
			tokenValid = true
			refreshed = true
		}

		// Fetch which Zoho account the token authenticates as.
		// If userinfo returns empty while the token appeared valid by clock, the token
		// may have been revoked — force a refresh to get a new one.
		zohoAccountEmail := fetchZohoUserInfo(ctx, accessToken)
		if zohoAccountEmail == "" && !refreshed {
			if newAccess, newExpiry, err := voiceRefreshUserToken(ctx, refreshToken); err == nil {
				accessToken = newAccess
				if encA, err := encryptValue(newAccess); err == nil {
					db.PGExec(ctx, `
						UPDATE o3c_users
						SET zoho_voice_access_token=$1, zoho_voice_token_expiry=$2
						WHERE id=$3`,
						encA, newExpiry, user.ID) //nolint:errcheck
				}
				zohoAccountEmail = fetchZohoUserInfo(ctx, accessToken)
			}
		}

		// If we now have a token but agent_id is still empty, re-resolve it.
		if agentID == "" && zohoAccountEmail != "" {
			if newID := fetchZohoVoiceAgentID(ctx, accessToken, zohoAccountEmail); newID != "" {
				agentID = newID
				db.PGExec(ctx, `UPDATE o3c_users SET zoho_voice_agent_id=$1 WHERE id=$2`,
					agentID, user.ID) //nolint:errcheck
			}
		}

		writeVoiceStatus(w, true, accessToken, tokenValid, connectedAt, email, agentID, fullName, zohoAccountEmail)
	}
}

func writeVoiceStatus(w http.ResponseWriter, connected bool, accessToken string, tokenValid bool, connectedAt any, email, agentID, fullName, zohoAccountEmail string) {
	w.Header().Set("Content-Type", "application/json")
	var connectedAtStr string
	if t, ok := connectedAt.(time.Time); ok {
		connectedAtStr = t.Format(time.RFC3339)
	}
	json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
		"connected":          connected,
		"access_token":       accessToken,
		"token_valid":        tokenValid,
		"connected_at":       connectedAtStr,
		"email":              email,
		"agent_id":           agentID,
		"full_name":          fullName,
		"zoho_account_email": zohoAccountEmail,
		"org_id":             zohoOrgID,
	})
}

// ── VoiceConnect ──────────────────────────────────────────────────────────────

// VoiceConnect returns the Zoho OAuth URL for the current user.
// The state parameter encodes the user ID so the callback knows who completed OAuth.
func VoiceConnect(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}

		clientID := zohoCred(ctx, db, "ZOHO_CLIENT_ID")
		if clientID == "" {
			respondErr(w, 400, "ZOHO_CLIENT_ID not configured — set it in Admin → API Keys")
			return
		}

		// Generate a cryptographically random state nonce to prevent CSRF.
		nonceBytes := make([]byte, 32)
		rand.Read(nonceBytes) //nolint:errcheck
		state := hex.EncodeToString(nonceBytes)
		db.PGExec(ctx, `
			INSERT INTO voice_oauth_states (nonce, user_id, expires_at)
			VALUES ($1, $2, now() + interval '10 minutes')
			ON CONFLICT (nonce) DO NOTHING`, state, user.ID) //nolint:errcheck

		// Scopes breakdown:
		// AaaServer.profile.Read  — allows /oauth/user/info to reveal which Zoho account is linked
		// ZohoVoice.sdk.ALL       — full WebRTC/SIP SDK access (sdk.READ alone is insufficient)
		// ZohoVoice.call.*        — outbound/inbound call control
		// ZohoVoice.agents.*      — agent list lookup for agent-ID resolution
		// Desk.calls.ALL          — Zoho Desk call log write-back
		const voiceScope = "AaaServer.profile.Read,Desk.calls.ALL,Desk.settings.READ,Desk.contacts.READ," +
			"ZohoVoice.sdk.ALL,ZohoVoice.call.READ,ZohoVoice.call.UPDATE,ZohoVoice.agents.READ,ZohoVoice.agents.UPDATE"
		authURL := fmt.Sprintf(
			"https://accounts.zoho.%s/oauth/v2/auth?response_type=code&client_id=%s&scope=%s&redirect_uri=%s&access_type=offline&prompt=consent&state=%s",
			zohoDC,
			url.QueryEscape(clientID),
			url.QueryEscape(voiceScope),
			url.QueryEscape(voiceRedirectURI()),
			url.QueryEscape(state),
		)

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"auth_url": authURL}) //nolint:errcheck
	}
}

// ── VoiceDisconnect ───────────────────────────────────────────────────────────

// VoiceDisconnect clears the current user's stored Zoho Voice tokens.
func VoiceDisconnect(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}

		db.PGExec(ctx, `
			UPDATE o3c_users
			SET zoho_voice_refresh_token=NULL,
			    zoho_voice_access_token=NULL,
			    zoho_voice_token_expiry=NULL,
			    zoho_voice_connected_at=NULL
			WHERE id=$1`, user.ID) //nolint:errcheck

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "disconnected"}) //nolint:errcheck
	}
}

// ── VoiceOAuthCallback ────────────────────────────────────────────────────────

// VoiceOAuthCallback is the public redirect target Zoho sends the user to after
// they authorise. It identifies the user from the state param, exchanges the
// code for tokens, and stores them encrypted on the user row.
func VoiceOAuthCallback(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		code := r.URL.Query().Get("code")
		state := r.URL.Query().Get("state")
		if code == "" || state == "" {
			http.Error(w, "Missing code or state parameter", http.StatusBadRequest)
			return
		}

		ctx := context.Background()

		// Look up user from the state nonce stored at OAuth initiation.
		stateRows, err := db.PGQuery(ctx,
			`DELETE FROM voice_oauth_states
			 WHERE nonce=$1 AND expires_at > now()
			 RETURNING user_id`, state)
		if err != nil || len(stateRows) == 0 {
			http.Error(w, "Invalid or expired state parameter", http.StatusBadRequest)
			return
		}
		userID := toInt64(stateRows[0]["user_id"])

		clientID := zohoCred(ctx, db, "ZOHO_CLIENT_ID")
		clientSecret := zohoCred(ctx, db, "ZOHO_CLIENT_SECRET")

		tokenURL := "https://accounts.zoho." + zohoDC + "/oauth/v2/token"
		body := url.Values{
			"grant_type":    {"authorization_code"},
			"client_id":     {clientID},
			"client_secret": {clientSecret},
			"code":          {code},
			"redirect_uri":  {voiceRedirectURI()},
		}.Encode()

		resp, err := httpPost(tokenURL, "application/x-www-form-urlencoded", "", []byte(body), 15*time.Second)
		if err != nil {
			slog.Error("voice callback: token exchange", "user_id", userID, "err", err)
			http.Error(w, "Token exchange failed", http.StatusInternalServerError)
			return
		}
		defer resp.Body.Close()
		raw, _ := io.ReadAll(resp.Body)

		var tok struct {
			AccessToken  string `json:"access_token"`
			RefreshToken string `json:"refresh_token"`
			ExpiresIn    int    `json:"expires_in"`
			Error        string `json:"error"`
			ErrorDesc    string `json:"error_description"`
		}
		if err := json.Unmarshal(raw, &tok); err != nil || tok.Error != "" {
			slog.Error("voice callback: decode", "user_id", userID, "err", err, "zoho_err", tok.Error, "zoho_desc", tok.ErrorDesc)
			http.Error(w, "Token decode failed", http.StatusInternalServerError)
			return
		}

		secs := tok.ExpiresIn
		if secs == 0 {
			secs = 3600
		}
		expiry := time.Now().Add(time.Duration(secs) * time.Second)

		encRefresh, err := encryptValue(tok.RefreshToken)
		if err != nil {
			slog.Error("voice callback: encrypt refresh token", "user_id", userID, "err", err)
			http.Error(w, "Encryption failed", http.StatusInternalServerError)
			return
		}
		encAccess, err := encryptValue(tok.AccessToken)
		if err != nil {
			slog.Error("voice callback: encrypt access token", "user_id", userID, "err", err)
			http.Error(w, "Encryption failed", http.StatusInternalServerError)
			return
		}

		// Look up the user's email so we can match against the Zoho Voice users list.
		userEmail := ""
		if rows, err := db.PGQuery(ctx, `SELECT email FROM o3c_users WHERE id=$1`, userID); err == nil && len(rows) > 0 {
			userEmail, _ = rows[0]["email"].(string)
		}

		// Fetch the agent's Zoho Voice agent ID (best-effort; non-fatal if unavailable).
		agentID := fetchZohoVoiceAgentID(ctx, tok.AccessToken, userEmail)

		_, err = db.PGExec(ctx, `
			UPDATE o3c_users
			SET zoho_voice_refresh_token=$1,
			    zoho_voice_access_token=$2,
			    zoho_voice_token_expiry=$3,
			    zoho_voice_connected_at=NOW(),
			    zoho_voice_agent_id=$5
			WHERE id=$4`,
			encRefresh, encAccess, expiry, userID, agentID)
		if err != nil {
			slog.Error("voice callback: save tokens", "user_id", userID, "err", err)
			http.Error(w, "Failed to save tokens", http.StatusInternalServerError)
			return
		}

		slog.Info("Zoho Voice connected for user", "user_id", userID, "agent_id", agentID)
		http.Redirect(w, r, voiceFrontendURL()+"/settings?voice_connected=true", http.StatusFound)
	}
}

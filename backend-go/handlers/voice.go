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
	"encoding/base64"
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
			SELECT email,
			       zoho_voice_refresh_token,
			       zoho_voice_access_token,
			       zoho_voice_token_expiry,
			       zoho_voice_connected_at
			FROM o3c_users WHERE id=$1`, user.ID)
		if err != nil || len(rows) == 0 {
			respondErr(w, 500, "DB error")
			return
		}
		row := rows[0]

		email, _ := row["email"].(string)
		encRefresh, _ := row["zoho_voice_refresh_token"].(string)
		encAccess, _ := row["zoho_voice_access_token"].(string)
		expiryRaw := row["zoho_voice_token_expiry"]
		connectedAt := row["zoho_voice_connected_at"]

		if encRefresh == "" {
			// Not connected at all.
			writeVoiceStatus(w, false, "", false, nil, email)
			return
		}

		refreshToken, err := decryptValue(encRefresh)
		if err != nil || refreshToken == "" {
			writeVoiceStatus(w, false, "", false, nil, email)
			return
		}

		// Determine if the stored access token is still valid.
		var expiry time.Time
		if t, ok := expiryRaw.(time.Time); ok {
			expiry = t
		}

		tokenValid := encAccess != "" && time.Now().Add(60*time.Second).Before(expiry)

		accessToken := ""
		if tokenValid {
			accessToken, _ = decryptValue(encAccess)
		} else {
			// Attempt silent refresh.
			newAccess, newExpiry, err := voiceRefreshUserToken(ctx, refreshToken)
			if err != nil {
				slog.Warn("voice token refresh failed", "user_id", user.ID, "err", err)
				// Return connected=true but token_valid=false — user may need to re-auth.
				writeVoiceStatus(w, true, "", false, connectedAt, email)
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
		}

		writeVoiceStatus(w, true, accessToken, tokenValid, connectedAt, email)
	}
}

func writeVoiceStatus(w http.ResponseWriter, connected bool, accessToken string, tokenValid bool, connectedAt any, email string) {
	w.Header().Set("Content-Type", "application/json")
	var connectedAtStr string
	if t, ok := connectedAt.(time.Time); ok {
		connectedAtStr = t.Format(time.RFC3339)
	}
	json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
		"connected":    connected,
		"access_token": accessToken,
		"token_valid":  tokenValid,
		"connected_at": connectedAtStr,
		"email":        email,
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

		state := base64.URLEncoding.EncodeToString([]byte(fmt.Sprintf("%d", user.ID)))

		authURL := fmt.Sprintf(
			"https://accounts.zoho.%s/oauth/v2/auth?response_type=code&client_id=%s&scope=%s&redirect_uri=%s&access_type=offline&prompt=consent&state=%s",
			zohoDC,
			url.QueryEscape(clientID),
			url.QueryEscape("ZohoVoice.call.ALL,ZohoVoice.settings.READ"),
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

		// Decode user ID from state.
		stateBytes, err := base64.URLEncoding.DecodeString(state)
		if err != nil {
			http.Error(w, "Invalid state parameter", http.StatusBadRequest)
			return
		}
		var userID int64
		if _, err := fmt.Sscanf(string(stateBytes), "%d", &userID); err != nil || userID == 0 {
			http.Error(w, "Invalid state parameter", http.StatusBadRequest)
			return
		}

		ctx := context.Background()

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

		_, err = db.PGExec(ctx, `
			UPDATE o3c_users
			SET zoho_voice_refresh_token=$1,
			    zoho_voice_access_token=$2,
			    zoho_voice_token_expiry=$3,
			    zoho_voice_connected_at=NOW()
			WHERE id=$4`,
			encRefresh, encAccess, expiry, userID)
		if err != nil {
			slog.Error("voice callback: save tokens", "user_id", userID, "err", err)
			http.Error(w, "Failed to save tokens", http.StatusInternalServerError)
			return
		}

		slog.Info("Zoho Voice connected for user", "user_id", userID)
		http.Redirect(w, r, voiceFrontendURL()+"/settings/voice?connected=true", http.StatusFound)
	}
}

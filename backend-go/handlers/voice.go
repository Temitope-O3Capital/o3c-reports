package handlers

// Telnyx Voice per-user SIP credentials.
// Each agent is assigned a Telnyx SIP credential (username + password) by an admin.
// The frontend uses these to initialise @telnyx/webrtc for browser-based calling.
//
// Routes (registered in main.go):
//   Protected (JWT):  GET    /api/voice/status
//                     DELETE /api/voice/disconnect   (agent clears own; admin clears any)
//   Admin only:       POST   /api/voice/credentials

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"os"

	"github.com/o3c/reports/core"
)

var telnyxCallerID = os.Getenv("TELNYX_CALLER_ID")

// VoiceStatus returns the current user's Telnyx SIP credentials (decrypted).
// The frontend passes sip_username + sip_password directly to TelnyxRTC.
func VoiceStatus(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}

		rows, err := db.PGQuery(ctx,
			`SELECT full_name, telnyx_sip_username, telnyx_sip_password_enc
			 FROM o3c_users WHERE id=$1`, user.ID)
		if err != nil || len(rows) == 0 {
			respondErr(w, 500, "DB error")
			return
		}
		row := rows[0]

		fullName, _ := row["full_name"].(string)
		sipUser, _ := row["telnyx_sip_username"].(string)
		sipPassEnc, _ := row["telnyx_sip_password_enc"].(string)

		if sipUser == "" || sipPassEnc == "" {
			writeTelnyxStatus(w, false, "", "", fullName)
			return
		}

		sipPass, err := decryptValue(sipPassEnc)
		if err != nil {
			slog.Error("voice: decrypt sip password", "user_id", user.ID, "err", err)
			writeTelnyxStatus(w, false, "", "", fullName)
			return
		}

		writeTelnyxStatus(w, true, sipUser, sipPass, fullName)
	}
}

func writeTelnyxStatus(w http.ResponseWriter, configured bool, sipUsername, sipPassword, fullName string) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
		"configured":   configured,
		"sip_username": sipUsername,
		"sip_password": sipPassword,
		"full_name":    fullName,
		"caller_id":    telnyxCallerID,
	})
}

// VoiceSetCredentials (admin-only) sets Telnyx SIP credentials for a specific user.
// POST /api/voice/credentials  body: { user_id, sip_username, sip_password }
// Send sip_username="" to clear credentials.
func VoiceSetCredentials(db *core.DB) http.HandlerFunc {
	type body struct {
		UserID      int64  `json:"user_id"`
		SIPUsername string `json:"sip_username"`
		SIPPassword string `json:"sip_password"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil || b.UserID == 0 {
			respondErr(w, 400, "user_id required")
			return
		}

		if b.SIPUsername == "" {
			db.PGExec(ctx, //nolint:errcheck
				`UPDATE o3c_users SET telnyx_sip_username=NULL, telnyx_sip_password_enc=NULL WHERE id=$1`,
				b.UserID)
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]string{"status": "cleared"}) //nolint:errcheck
			return
		}

		if b.SIPPassword == "" {
			respondErr(w, 400, "sip_password required when sip_username is set")
			return
		}

		encPass, err := encryptValue(b.SIPPassword)
		if err != nil {
			respondErr(w, 500, "Encryption failed")
			return
		}

		res, err := db.PGQuery(ctx,
			`UPDATE o3c_users SET telnyx_sip_username=$1, telnyx_sip_password_enc=$2
			 WHERE id=$3 RETURNING id, email, full_name`,
			b.SIPUsername, encPass, b.UserID)
		if err != nil || len(res) == 0 {
			respondErr(w, 404, "User not found")
			return
		}

		slog.Info("voice: Telnyx credentials set", "user_id", b.UserID, "sip_user", b.SIPUsername)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"status": "ok", "user": res[0]}) //nolint:errcheck
	}
}

// VoiceDisconnect clears the current user's Telnyx SIP credentials.
func VoiceDisconnect(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		db.PGExec(ctx, //nolint:errcheck
			`UPDATE o3c_users SET telnyx_sip_username=NULL, telnyx_sip_password_enc=NULL WHERE id=$1`,
			user.ID)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "disconnected"}) //nolint:errcheck
	}
}

package handlers

// Africa's Talking (AT) + Telnyx voice integration.
//
// AT handles the Nigerian +234 inbound DID and browser-based outbound WebRTC.
// Telnyx handles SIP credentials for optional outbound via Telnyx (kept for
// backward compatibility — new code uses AT WebRTC exclusively).
//
// Routes registered in main.go:
//   Public (no JWT):
//     POST /api/voice/at-inbound   — AT fires this on every call to your +234 number
//   Protected (JWT required):
//     GET  /api/voice/at-token     — Fetch AT WebRTC capability token for agent browser
//     GET  /api/voice/status       — Telnyx SIP credential status (legacy)
//     DELETE /api/voice/disconnect — Clear Telnyx SIP credentials (legacy)
//   Admin only:
//     POST /api/voice/credentials  — Set Telnyx SIP credentials for a user (legacy)
//
// Required env vars:
//   AT_API_KEY        — Africa's Talking API key (from AT dashboard → Settings → API Key)
//   AT_USERNAME       — Africa's Talking username (usually your email or sandbox for testing)
//   AT_PHONE_NUMBER   — Your AT Nigerian +234 virtual number (e.g. +23417006001)
//   AT_AGENT_MOBILE   — Phone number to bridge inbound calls to (e.g. +2348012345678)
//                       This is the agent's real mobile that rings when a customer calls in.
//                       Phase 2: replace with per-agent routing from o3c_users.at_mobile_number
//
// Optional (Telnyx legacy):
//   TELNYX_CALLER_ID    — Telnyx outbound caller ID
//   TELNYX_PHONE_NUMBER — Telnyx number for legacy AT→Telnyx forwarding

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/o3c/reports/core"
)

// ── Config ────────────────────────────────────────────────────────────────────

var (
	// Telnyx — kept for legacy SIP credential management
	telnyxCallerID    = os.Getenv("TELNYX_CALLER_ID")
	telnyxPhoneNumber = os.Getenv("TELNYX_PHONE_NUMBER")
)

var atHTTPClient = &http.Client{Timeout: 10 * time.Second}

type atCfg struct {
	apiKey      string
	username    string
	phoneNumber string
	agentMobile string
}

// getATConfig reads AT credentials from the settings table, falling back to
// env vars for each missing key. This lets admins update credentials from the
// Settings UI without a server redeploy.
func getATConfig(ctx context.Context, db *core.DB) atCfg {
	cfg := atCfg{
		apiKey:      os.Getenv("AT_API_KEY"),
		username:    os.Getenv("AT_USERNAME"),
		phoneNumber: os.Getenv("AT_PHONE_NUMBER"),
		agentMobile: os.Getenv("AT_AGENT_MOBILE"),
	}
	rows, err := db.PGQuery(ctx,
		`SELECT key, value FROM settings WHERE key LIKE 'at_%' AND value <> ''`)
	if err != nil {
		return cfg
	}
	for _, row := range rows {
		k, _ := row["key"].(string)
		v, _ := row["value"].(string)
		if sensitiveSettingKey(k) {
			dec, err := decryptValue(v)
			if err != nil {
				continue
			}
			v = dec
		}
		switch k {
		case "at_api_key":      cfg.apiKey = v
		case "at_username":     cfg.username = v
		case "at_phone_number": cfg.phoneNumber = v
		case "at_agent_mobile": cfg.agentMobile = v
		}
	}
	return cfg
}

// ── AT Capability Token ───────────────────────────────────────────────────────

// VoiceATCapabilityToken issues a short-lived WebRTC capability token from AT's
// token service. The browser loads this token into the AT WebRTC SDK to enable
// both inbound and outbound browser calling.
//
// GET /api/voice/at-token   (JWT required)
func VoiceATCapabilityToken(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		at := getATConfig(r.Context(), db)
		if at.apiKey == "" || at.username == "" {
			respondErr(w, 503, "Africa's Talking not configured — set AT_API_KEY and AT_USERNAME in Settings → Call Center")
			return
		}

		// Client names must be unique per session; embed agent ID + timestamp.
		clientName := fmt.Sprintf("o3c-agent-%d-%d", user.ID, time.Now().Unix())

		payload, _ := json.Marshal(map[string]any{
			"clientName":  clientName,
			"incoming":    true,
			"outgoing":    true,
			"lifeTimeSec": 3600,
		})

		req, err := http.NewRequestWithContext(r.Context(), http.MethodPost,
			"https://webrtc.africastalking.com/capability-token/request",
			bytes.NewReader(payload))
		if err != nil {
			respondErr(w, 500, "Failed to build AT token request")
			return
		}
		req.Header.Set("apiKey", at.apiKey)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json")

		resp, err := atHTTPClient.Do(req)
		if err != nil {
			slog.Error("voice: AT capability token request failed", "err", err)
			respondErr(w, 502, "AT token request failed: "+err.Error())
			return
		}
		defer resp.Body.Close()

		if resp.StatusCode != 200 {
			slog.Error("voice: AT capability token non-200", "status", resp.StatusCode)
			respondErr(w, 502, fmt.Sprintf("AT returned HTTP %d for capability token", resp.StatusCode))
			return
		}

		var result map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
			respondErr(w, 502, "AT token response could not be decoded")
			return
		}

		// Surface phone number so the browser knows what number it's calling from.
		result["at_phone_number"] = at.phoneNumber

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(result) //nolint:errcheck
	}
}

// ── AT Inbound Webhook ────────────────────────────────────────────────────────

// VoiceATInbound handles Africa's Talking voice webhook.
// AT posts here on every state change for calls to your +234 number.
//
// Two lifecycle events:
//   isActive=1  — call is live; respond with ActionScript XML to route it
//   isActive=0  — call ended; update the call log with duration + outcome
//
// POST /api/voice/at-inbound   (no JWT — AT posts here directly)
func VoiceATInbound(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}

		isActive     := r.FormValue("isActive")
		sessionID    := r.FormValue("sessionId")
		callerNumber := r.FormValue("callerNumber")
		durationStr  := r.FormValue("durationInSeconds")
		ctx          := r.Context()

		// ── Call ended ─────────────────────────────────────────────────────────
		if isActive == "0" {
			if sessionID != "" {
				duration, _ := strconv.Atoi(durationStr)
				outcome := "completed"
				if duration == 0 {
					outcome = "missed"
				}
				db.PGExec(ctx, //nolint:errcheck
					`UPDATE helpdesk_calls
					    SET duration_sec=$1, outcome=$2
					  WHERE session_id=$3 AND outcome='pending'`,
					duration, outcome, sessionID)
				slog.Info("voice: AT call ended", "caller", callerNumber, "duration", duration, "outcome", outcome)
			}
			xmlOK(w)
			return
		}

		// ── Call active — route it ─────────────────────────────────────────────
		slog.Info("voice: AT inbound call", "caller", callerNumber, "session", sessionID)

		// Ensure session_id column exists (idempotent ALTER; only runs on first call)
		db.PGExec(ctx, `ALTER TABLE helpdesk_calls ADD COLUMN IF NOT EXISTS session_id TEXT`) //nolint:errcheck

		// Look up customer by phone number
		var custName, custCIF string
		if rows, err := db.PGQuery(ctx,
			`SELECT COALESCE("Full Name",'') AS name, COALESCE("CIF Number",'') AS cif
			   FROM "Accounts" WHERE "Phone"=$1 LIMIT 1`, callerNumber,
		); err == nil && len(rows) > 0 {
			custName, _ = rows[0]["name"].(string)
			custCIF, _ = rows[0]["cif"].(string)
		}

		// Create helpdesk ticket
		subject := "Inbound Call from " + callerNumber
		if custName != "" {
			subject = "Inbound Call — " + custName + " (" + callerNumber + ")"
		}
		var ticketID int64
		var ticketRef string
		if rows, err := db.PGQuery(ctx,
			`INSERT INTO helpdesk_tickets
			   (channel, status, priority, subject, customer_cif, customer_phone)
			 VALUES ('phone','open','medium',$1,$2,$3)
			 RETURNING id, ticket_ref`,
			subject, custCIF, callerNumber,
		); err == nil && len(rows) > 0 {
			ticketID, _ = rows[0]["id"].(int64)
			ticketRef, _ = rows[0]["ticket_ref"].(string)
		} else if err != nil {
			slog.Error("voice: AT inbound — failed to create ticket", "err", err)
		}

		// Create pending call log entry (duration + outcome updated on call end)
		var tID, tRef any
		if ticketID > 0 {
			tID = ticketID
			tRef = ticketRef
		}
		db.PGExec(ctx, //nolint:errcheck
			`INSERT INTO helpdesk_calls
			   (agent_name, customer_name, customer_cif, customer_phone,
			    direction, duration_sec, outcome, ticket_id, ticket_ref, session_id)
			 VALUES ('Inbound',$1,$2,$3,'inbound',0,'pending',$4,$5,$6)`,
			custName, custCIF, callerNumber, tID, tRef, sessionID)

		// ── Route to agent ─────────────────────────────────────────────────────
		mobile := getATConfig(ctx, db).agentMobile
		if mobile == "" {
			slog.Warn("voice: AT inbound — AT_AGENT_MOBILE not set; cannot bridge call")
			w.Header().Set("Content-Type", "application/xml")
			fmt.Fprint(w, atXML(`<Say>We're sorry, all agents are currently unavailable. Please try again shortly.</Say>`))
			return
		}

		slog.Info("voice: bridging inbound to agent mobile", "agent_mobile", mobile, "ticket_ref", ticketRef)
		w.Header().Set("Content-Type", "application/xml")
		fmt.Fprintf(w,
			`<?xml version="1.0" encoding="UTF-8"?>`+"\n"+
				`<Response>`+"\n"+
				`  <Say>Thank you for calling O3 Capital. Please hold while we connect you to an agent.</Say>`+"\n"+
				`  <Dial record="true" sequential="true" callerId="%s">`+"\n"+
				`    <Number>%s</Number>`+"\n"+
				`  </Dial>`+"\n"+
				`</Response>`,
			callerNumber, mobile)
	}
}

func xmlOK(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/xml")
	fmt.Fprint(w, `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`)
}

func atXML(body string) string {
	return `<?xml version="1.0" encoding="UTF-8"?><Response>` + body + `</Response>`
}

// ── Telnyx SIP credentials (legacy) ──────────────────────────────────────────

// VoiceStatus returns the current user's Telnyx SIP status (masked username).
// GET /api/voice/status   (JWT required)
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

		fullName, _    := row["full_name"].(string)
		sipUser, _     := row["telnyx_sip_username"].(string)
		sipPassEnc, _  := row["telnyx_sip_password_enc"].(string)

		if sipUser == "" || sipPassEnc == "" {
			writeTelnyxStatus(w, false, "", fullName)
			return
		}

		sipPass, err := decryptValue(sipPassEnc)
		if err != nil {
			slog.Error("voice: decrypt sip password", "user_id", user.ID, "err", err)
			writeTelnyxStatus(w, false, "", fullName)
			return
		}
		_ = sipPass // decrypted only to confirm the account is properly configured

		writeTelnyxStatus(w, true, sipUser, fullName)
	}
}

func writeTelnyxStatus(w http.ResponseWriter, configured bool, sipUsername, fullName string) {
	masked := ""
	if len(sipUsername) > 3 {
		masked = sipUsername[:3] + "***"
	} else if sipUsername != "" {
		masked = "***"
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
		"configured":   configured,
		"sip_username": masked,
		"full_name":    fullName,
		"caller_id":    telnyxCallerID,
	})
}

// VoiceSetCredentials (admin-only) sets Telnyx SIP credentials for a user.
// POST /api/voice/credentials   body: { user_id, sip_username, sip_password }
// Send sip_username="" to clear.
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
// DELETE /api/voice/disconnect   (JWT required)
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

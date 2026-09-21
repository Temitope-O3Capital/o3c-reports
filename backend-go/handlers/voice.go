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
//   AT_WEBHOOK_SECRET — Shared secret authenticating the inbound webhook. AT has no
//                       request signing, so it rides in the callback URL configured in
//                       the AT dashboard: .../api/voice/at-inbound?key=<secret>.
//                       Fails CLOSED — until this is set, no inbound call is logged.
//                       Stored like every other credential: env var, else api_credentials.
//
// Optional (Telnyx legacy):
//   TELNYX_CALLER_ID    — Telnyx outbound caller ID
//   TELNYX_PHONE_NUMBER — Telnyx number for legacy AT→Telnyx forwarding

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/o3c/workspace/core"
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
		case "at_api_key":
			cfg.apiKey = v
		case "at_username":
			cfg.username = v
		case "at_phone_number":
			cfg.phoneNumber = v
		case "at_agent_mobile":
			cfg.agentMobile = v
		}
	}
	return cfg
}

// ── AT webhook authenticity ───────────────────────────────────────────────────

// atProvider names this producer in the provider-neutral telephony model (mig 225).
const atProvider = "africastalking"

// atMaxTalkSec mirrors helpdesk_calls_duration_sane_chk (mig 159). A "call" longer
// than this is a bad record, not a long conversation, so it is stored as NULL rather
// than failing the UPDATE and stranding the row at 'pending'.
const atMaxTalkSec = 14400

// atPendingStaleAfter is how long a row may sit at outcome='pending' before the
// call-end webhook is presumed lost. Nothing real outlives the 4h talk-time cap.
const atPendingStaleAfter = "4 hours"

// atSecretWarnOnce makes the fail-closed rejection loud exactly once, so an
// unconfigured deploy reads as a misconfiguration and not as "AT went quiet".
var atSecretWarnOnce sync.Once

// atWebhookAuthOK verifies that an /api/voice/at-inbound POST really came from AT.
//
// AT has no request-signing scheme — the callback URL is typed into the AT dashboard
// by hand — so the only authenticator available is a shared secret carried IN that
// URL. This follows ZohoWebhook exactly: same storage (env var, then api_credentials,
// via resolveCredKey), constant-time compare, and fail closed when unset. Until this
// landed the endpoint was completely open: anyone who guessed the URL could post
// fabricated calls and tickets into the ledger that QA, agent stats and the CBN report
// are built on, or close a live call with a duration of their choosing.
//
// Accepted in order: ?key= (the Zoho convention, and what the AT dashboard can carry),
// then X-AT-Webhook-Secret for a fronting proxy able to inject a header.
func atWebhookAuthOK(ctx context.Context, db *core.DB, r *http.Request) bool {
	secret := resolveCredKey(ctx, db, "AT_WEBHOOK_SECRET")
	if secret == "" {
		atSecretWarnOnce.Do(func() {
			slog.Error("voice: AT_WEBHOOK_SECRET is NOT SET — rejecting every Africa's Talking webhook, " +
				"so NO inbound call is being logged. Set AT_WEBHOOK_SECRET (env var, or api_credentials " +
				"key_name='AT_WEBHOOK_SECRET') and append ?key=<secret> to the voice callback URL in the AT dashboard.")
		})
		return false
	}
	presented := r.URL.Query().Get("key")
	if presented == "" {
		presented = r.Header.Get("X-AT-Webhook-Secret")
	}
	return subtle.ConstantTimeCompare([]byte(presented), []byte(secret)) == 1
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
//
//	isActive=1  — call is live; respond with ActionScript XML to route it
//	isActive=0  — call ended; update the call log with duration + outcome
//
// POST /api/voice/at-inbound   (no JWT — AT posts here directly)
func VoiceATInbound(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		// Fail closed BEFORE parsing or touching the ledger: an unauthenticated caller
		// must reach neither the call log nor the dial plan.
		if !atWebhookAuthOK(ctx, db, r) {
			slog.Warn("voice: AT webhook REJECTED — bad or missing key", "remote", getRealIPFromRequest(r))
			respondErr(w, 403, "forbidden")
			return
		}

		if err := r.ParseForm(); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}

		isActive := r.FormValue("isActive")
		sessionID := strings.TrimSpace(r.FormValue("sessionId"))
		callerNumber := strings.TrimSpace(r.FormValue("callerNumber"))

		// ── Call ended ─────────────────────────────────────────────────────────
		if isActive == "0" {
			atFinishCall(ctx, db, r, sessionID, callerNumber)
			xmlOK(w)
			atSweepStalePending(ctx, db)
			return
		}

		// ── Call active — route it ─────────────────────────────────────────────
		slog.Info("voice: AT inbound call", "caller", callerNumber, "session", sessionID)

		at := getATConfig(ctx, db)
		if at.agentMobile == "" {
			slog.Warn("voice: AT inbound — AT_AGENT_MOBILE not set; cannot bridge call")
			w.Header().Set("Content-Type", "application/xml")
			fmt.Fprint(w, atXML(`<Say>We're sorry, all agents are currently unavailable. Please try again shortly.</Say>`))
			return
		}

		// Answer AT FIRST, then write the ledger. AT retries the whole webhook when we
		// are slow, and each retry used to duplicate the ticket and the call row; the
		// dial plan depends only on the config read above, so nothing the caller waits
		// on needs the customer lookup or the insert.
		writeATDialPlan(w, at.phoneNumber, at.agentMobile)
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}

		atLogInboundCall(ctx, db, sessionID, callerNumber, at.agentMobile)
		atSweepStalePending(ctx, db)
	}
}

// atEsc XML-escapes a value interpolated into the ActionScript response.
func atEsc(s string) string {
	var b strings.Builder
	xml.EscapeText(&b, []byte(s)) //nolint:errcheck
	return b.String()
}

// writeATDialPlan renders the ActionScript that bridges the caller to an agent.
//
// Both values go through encoding/xml. callerNumber used to be interpolated raw, so a
// crafted caller ID could inject its own dial plan — and with the webhook
// unauthenticated that was an attacker-controlled response. callerId is now our AT
// virtual number (AT_PHONE_NUMBER), the outbound identity AT requires; it was set to
// the CALLER's number, which is not a number we own.
func writeATDialPlan(w http.ResponseWriter, virtualNumber, agentMobile string) {
	w.Header().Set("Content-Type", "application/xml")
	callerID := ""
	if virtualNumber != "" {
		callerID = ` callerId="` + atEsc(virtualNumber) + `"`
	} else {
		// AT rejects a callerId that isn't one of ours; omitting it lets AT choose.
		slog.Warn("voice: AT_PHONE_NUMBER not set — dialling without an explicit callerId")
	}
	fmt.Fprintf(w,
		`<?xml version="1.0" encoding="UTF-8"?>`+"\n"+
			`<Response>`+"\n"+
			`  <Say>Thank you for calling O3 Capital. Please hold while we connect you to an agent.</Say>`+"\n"+
			`  <Dial record="true" sequential="true"%s>`+"\n"+
			`    <Number>%s</Number>`+"\n"+
			`  </Dial>`+"\n"+
			`</Response>`,
		callerID, atEsc(agentMobile))
}

// atLogInboundCall records the in-flight call. Idempotent on session_id (migration
// 254's uq_helpdesk_calls_session), so an AT retry no longer inserts a second row that
// the later call-end UPDATE would match and double-count.
//
// No ticket is raised here on purpose — see atRaiseTicket. duration_sec starts NULL,
// not 0: migration 159 makes it TALK TIME, and no conversation has happened yet (a 0
// would read as "connected, said nothing").
func atLogInboundCall(ctx context.Context, db *core.DB, sessionID, callerNumber, agentMobile string) {
	if sessionID == "" {
		// Without a session id nothing can be deduplicated or completed later.
		slog.Warn("voice: AT inbound with no sessionId — call cannot be deduplicated or closed out", "caller", callerNumber)
	}

	// Blank phone guard: matching on an empty number would pick an arbitrary
	// blank-phone customer record.
	var custName, custCIF string
	if callerNumber != "" {
		if rows, err := db.PGQuery(ctx,
			`SELECT COALESCE(full_name,'') AS name, COALESCE(cif,'') AS cif
			   FROM app.customers WHERE phone=$1 LIMIT 1`, callerNumber,
		); err != nil {
			slog.Error("voice: AT inbound — customer lookup failed", "session", sessionID, "err", err)
		} else if len(rows) > 0 {
			custName, _ = rows[0]["name"].(string)
			custCIF, _ = rows[0]["cif"].(string)
		}
	}

	// customer_cif stays '' here (the column is NOT NULL DEFAULT ''); it is the TICKET
	// insert that must use NULLIF, so idx_tickets_cif isn't filled with empty strings.
	if _, err := db.PGExec(ctx,
		`INSERT INTO helpdesk_calls
		   (agent_name, customer_name, customer_cif, customer_phone, call_to,
		    direction, duration_sec, outcome, session_id, telephony_provider)
		 VALUES ('Inbound',$1,$2,$3,$4,'inbound',NULL,'pending',NULLIF($5,''),$6)
		 ON CONFLICT (session_id) WHERE session_id IS NOT NULL DO NOTHING`,
		custName, custCIF, callerNumber, agentMobile, sessionID, atProvider,
	); err != nil {
		// These writes were all //nolint:errcheck, so a failed insert left no evidence
		// the call had ever happened.
		slog.Error("voice: AT inbound — failed to log call", "session", sessionID, "caller", callerNumber, "err", err)
		return
	}
	slog.Info("voice: bridging inbound to agent mobile", "agent_mobile", agentMobile, "session", sessionID)
}

// atDialOutcome maps AT's DIAL-LEG fields onto the ledger's vocabulary, returning the
// outcome and the TALK time.
//
// The session fields measure how long the CALLER was on the line — greeting, ringing
// and all — not how long anyone spoke to them. Deciding on durationInSeconds==0
// therefore stored a caller who heard the greeting, got no answer and hung up at 40s as
// outcome='completed', duration_sec=40: a missed call recorded as a 40-second
// conversation. dialCallStatus says whether an agent actually picked up, and
// dialDurationInSeconds is the length of that conversation.
//
// Talk time is nil unless a conversation actually happened (migration 159: NULL is the
// honest value for "no conversation"), and anything outside the range
// helpdesk_calls_duration_sane_chk allows is dropped rather than stored — a value over
// the 4h cap would fail the UPDATE and strand the row at 'pending'.
func atDialOutcome(dialStatus string, dialDur int) (string, *int) {
	// AT's dial-leg statuses: Completed | NoAnswer | Busy | Failed | Aborted. Anything
	// that is not an explicit completion never reached a conversation — including an
	// EMPTY status, which means the caller hung up during the greeting before we dialled.
	s := strings.ToLower(strings.TrimSpace(dialStatus))
	if !strings.Contains(s, "complete") && !strings.Contains(s, "success") && !strings.Contains(s, "bridge") {
		return "missed", nil
	}
	if dialDur <= 0 || dialDur > atMaxTalkSec {
		// Connected, but with no usable talk time: record the connect and leave the
		// duration unknown rather than store a number the constraint would reject.
		return "completed", nil
	}
	d := dialDur
	return "completed", &d
}

// atFinishCall closes out the call when AT reports the session ended.
func atFinishCall(ctx context.Context, db *core.DB, r *http.Request, sessionID, callerNumber string) {
	if sessionID == "" {
		slog.Warn("voice: AT call-end with no sessionId — cannot match a call row", "caller", callerNumber)
		return
	}

	dialStatus := strings.TrimSpace(r.FormValue("dialCallStatus"))
	hangupCause := strings.TrimSpace(r.FormValue("hangupCause"))
	sessionDur, _ := strconv.Atoi(r.FormValue("durationInSeconds"))
	dialDur, _ := strconv.Atoi(r.FormValue("dialDurationInSeconds"))
	outcome, talkSec := atDialOutcome(dialStatus, dialDur)

	// The dial plan sets record="true", so AT produces audio for connected calls.
	// recordingUrl is only written when AT actually supplies it (COALESCE leaves the
	// column alone otherwise). recording_filename matters as much as the URL:
	// callUnansweredExpr treats a missing recording as evidence that a short call never
	// connected, so a genuine short AT call would otherwise be silently reclassified.
	recURL := strings.TrimSpace(r.FormValue("recordingUrl"))
	recFile := ""
	if recURL != "" {
		base := recURL
		if i := strings.IndexAny(base, "?#"); i >= 0 {
			base = base[:i]
		}
		if i := strings.LastIndex(base, "/"); i >= 0 {
			base = base[i+1:]
		}
		recFile = base
	}

	rows, err := db.PGQuery(ctx,
		`UPDATE helpdesk_calls
		    SET duration_sec       = $1,
		        outcome            = $2,
		        hangup_cause       = COALESCE(NULLIF($3,''), hangup_cause),
		        recording_url      = COALESCE(NULLIF($4,''), recording_url),
		        recording_filename = COALESCE(NULLIF($5,''), recording_filename)
		  WHERE session_id=$6 AND outcome='pending'
		  RETURNING id, COALESCE(call_to,'') AS call_to`,
		talkSec, outcome, hangupCause, recURL, recFile, sessionID)
	if err != nil {
		slog.Error("voice: AT call-end — failed to close call", "session", sessionID, "err", err)
		return
	}
	if len(rows) == 0 {
		// Already closed: an AT retry, or a session we never logged. Nothing more to do
		// — and, crucially, no second ticket to raise.
		slog.Info("voice: AT call ended — no pending row (retry or unknown session)", "session", sessionID)
		return
	}
	callID, _ := rows[0]["id"].(int64)
	agentMobile, _ := rows[0]["call_to"].(string)

	slog.Info("voice: AT call ended", "caller", callerNumber, "session", sessionID,
		"outcome", outcome, "dial_status", dialStatus, "session_sec", sessionDur)

	atEnrichTelephony(ctx, db, callID, outcome, hangupCause, agentMobile, sessionDur, talkSec)

	// A caller who hung up during the greeting is not a support request.
	if outcome == "completed" {
		atRaiseTicket(ctx, db, callID, sessionID, callerNumber)
	}
}

// atEnrichTelephony routes the AT call through the provider-neutral telephony seam
// (telephony.go), which until now only the Zoho producer used — so no AT call ever got
// answered_at, wait_sec, abandoned or telephony_provider, and the Inbound page's
// abandonment and wait-time analytics read 0%/NULL for AT traffic instead of "unknown".
//
// disconnected_by and queue_name are deliberately left unset: AT sends no "who hung up"
// party field, and its dial plan has no queue. Unknown is the honest value.
func atEnrichTelephony(ctx context.Context, db *core.DB, callID int64, outcome, hangupCause, agentMobile string, sessionDur int, talkSec *int) {
	answered := outcome == "completed"
	abandoned := !answered

	// AT sends no answer timestamp, so it is derived: the session has just ended and the
	// conversation occupied its last talkSec.
	var ansPtr *time.Time
	if answered && talkSec != nil {
		t := time.Now().Add(-time.Duration(*talkSec) * time.Second)
		ansPtr = &t
	}

	// Wait = time on the line before the conversation started (greeting + ring). For a
	// call that never connected, the whole session was wait.
	var waitPtr *int
	wait := sessionDur
	if answered && talkSec != nil {
		wait = sessionDur - *talkSec
	}
	if wait >= 0 && wait <= 3600 {
		waitPtr = &wait
	}

	if err := enrichCallTelephony(ctx, db, callID, CallTelephony{
		Provider:    atProvider,
		AnsweredAt:  ansPtr,
		WaitSec:     waitPtr,
		HangupCause: hangupCause,
		Abandoned:   &abandoned,
	}); err != nil {
		slog.Error("voice: AT call-end — telephony enrich failed", "call_id", callID, "err", err)
	}

	// The AT dial plan rings exactly one destination, so that IS the ring sequence.
	// Recorded through the same seam Zoho uses so the Inbound ring-leg view works for AT
	// traffic; the dialled number is the only agent identity AT gives us.
	if agentMobile != "" {
		legOutcome := "no_answer"
		if answered {
			legOutcome = "answered"
		}
		upsertRingLegs(ctx, db, callID, atProvider, "", "sequential", []RingLeg{{
			Position: 1, AgentName: agentMobile, RingSec: waitPtr, Outcome: legOutcome,
		}})
	}
}

// atRaiseTicket opens ONE support ticket for a connected inbound call.
//
// Two changes from the old per-call insert. It runs at call END, so a caller who hung
// up during the greeting no longer generates a ticket at all. And it dedupes by number
// against open phone tickets inside ccInboundReturnWindow, matching what
// ccQueueMissedCallbacks was built to express: a customer who rang five times is owed
// ONE return call, not five. Re-running for the same session cannot happen — the caller
// only gets here when the call-end UPDATE actually moved a pending row.
func atRaiseTicket(ctx context.Context, db *core.DB, callID int64, sessionID, callerNumber string) {
	var custName, custCIF string
	if rows, err := db.PGQuery(ctx,
		`SELECT COALESCE(customer_name,'') AS nm, COALESCE(customer_cif,'') AS cif
		   FROM helpdesk_calls WHERE id=$1`, callID); err == nil && len(rows) > 0 {
		custName, _ = rows[0]["nm"].(string)
		custCIF, _ = rows[0]["cif"].(string)
	}

	subject := "Inbound Call from " + callerNumber
	if custName != "" {
		subject = "Inbound Call — " + custName + " (" + callerNumber + ")"
	}

	// priority is 'normal', not 'medium': helpdesk_tickets_priority_check allows only
	// low/normal/high/urgent, so every ticket this handler tried to raise was in fact
	// being rejected outright by the constraint.
	//
	// app.norm_phone returns the LAST 10 DIGITS and '' for anything unparseable, so a
	// bare equality would match a withheld number against every blank-phone ticket.
	// Both sides are length-guarded, and an unusable caller ID raises no ticket.
	rows, err := db.PGQuery(ctx, `
		INSERT INTO helpdesk_tickets
		   (channel, status, priority, subject, customer_cif, customer_phone,
		    customer_name, linked_call_id)
		SELECT 'phone','open','normal',$1,NULLIF($2,''),$3,NULLIF($4,''),$5
		 WHERE length(app.norm_phone($3)) = 10
		   AND NOT EXISTS (
		     SELECT 1 FROM helpdesk_tickets t
		      WHERE t.channel = 'phone'
		        AND t.status IN ('open','pending','in_progress')
		        AND length(app.norm_phone(t.customer_phone)) = 10
		        AND app.norm_phone(t.customer_phone) = app.norm_phone($3)
		        AND t.created_at > NOW() - INTERVAL '`+ccInboundReturnWindow+`')
		RETURNING id, ticket_ref`,
		subject, custCIF, callerNumber, custName, callID)
	if err != nil {
		slog.Error("voice: AT inbound — failed to create ticket", "session", sessionID, "err", err)
		return
	}
	if len(rows) == 0 {
		// Unusable number, or this caller already has an open phone ticket in the
		// window — one return call is owed, not another ticket.
		return
	}

	if _, err := db.PGExec(ctx,
		`UPDATE helpdesk_calls SET ticket_id=$1, ticket_ref=$2 WHERE id=$3`,
		rows[0]["id"], rows[0]["ticket_ref"], callID); err != nil {
		slog.Error("voice: AT inbound — failed to link ticket to call", "session", sessionID, "err", err)
	}
}

// ── Stale 'pending' resolution ────────────────────────────────────────────────

var (
	atSweepMu   sync.Mutex
	atSweepLast time.Time
)

const atSweepInterval = 10 * time.Minute

// atSweepStalePending gives outcome='pending' a terminal state when the call-end
// webhook never arrives.
//
// This matters because callConnectedExpr (helpdesk.go) reads 'pending' as CONNECTED, so
// a stranded row counts as an answered call with zero talk time in the Inbound answer
// rate and in every agent KPI. Nothing else ever clears it.
//
// Done here, throttled, rather than as a new background worker: this webhook is the only
// thing that creates these rows, so it is the only thing that needs to tidy them, and
// main.go already starts ~25 workers — another ticker for one UPDATE would duplicate
// what this call does for free. It runs AFTER the response is written, so it never adds
// latency to a live call.
func atSweepStalePending(ctx context.Context, db *core.DB) {
	atSweepMu.Lock()
	if time.Since(atSweepLast) < atSweepInterval {
		atSweepMu.Unlock()
		return
	}
	atSweepLast = time.Now()
	atSweepMu.Unlock()

	// 'no_answer' (rather than 'missed') records that we never learned how the call
	// ended; both read as unanswered to callUnansweredExpr. duration_sec stays NULL —
	// no conversation was ever confirmed (migration 159). Scoped to this provider so it
	// can never touch a Zoho row.
	res, err := db.PGExec(ctx, `
		UPDATE helpdesk_calls
		   SET outcome      = 'no_answer',
		       duration_sec = NULL,
		       abandoned    = TRUE,
		       hangup_cause = COALESCE(NULLIF(hangup_cause,''), 'AT_CALL_END_MISSING')
		 WHERE outcome = 'pending'
		   AND telephony_provider = $1
		   AND started_at < NOW() - INTERVAL '`+atPendingStaleAfter+`'`, atProvider)
	if err != nil {
		slog.Error("voice: AT stale-pending sweep failed", "err", err)
		return
	}
	if n, _ := res.RowsAffected(); n > 0 {
		slog.Warn("voice: resolved stale pending AT calls (call-end webhook never arrived)", "rows", n)
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

		fullName, _ := row["full_name"].(string)
		sipUser, _ := row["telnyx_sip_username"].(string)
		sipPassEnc, _ := row["telnyx_sip_password_enc"].(string)

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

		// Defence in depth. The route is admin-gated in main.go, but this handler takes
		// user_id from the BODY, so without its own check any authenticated caller could
		// repoint or clear another user's SIP credentials — telephony identity theft.
		caller := core.UserFromCtx(ctx)
		if caller == nil || caller.Role != "admin" {
			respondErr(w, 403, "Admin only")
			return
		}

		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil || b.UserID == 0 {
			respondErr(w, 400, "user_id required")
			return
		}

		if b.SIPUsername == "" {
			// Don't report "cleared" when the clear failed.
			if _, err := db.PGExec(ctx,
				`UPDATE o3c_users SET telnyx_sip_username=NULL, telnyx_sip_password_enc=NULL WHERE id=$1`,
				b.UserID); err != nil {
				respondErrLog(w, 500, "Could not clear SIP credentials", err)
				return
			}
			slog.Info("voice: Telnyx credentials cleared", "user_id", b.UserID, "by", caller.ID)
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

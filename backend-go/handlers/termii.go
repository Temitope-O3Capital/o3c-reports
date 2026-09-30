package handlers

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

const termiiSendURL = "https://api.ng.termii.com/api/sms/send"

// termiiHTTPClient is used for ALL Termii calls. The O3 network's SSL-inspection
// appliance takes ~10s to complete the TLS handshake to api.ng.termii.com, which
// trips Go's DEFAULT 10s TLSHandshakeTimeout — so the default client fails every
// Termii request with "TLS handshake timeout" even though the call would succeed
// (a raw request returns 200 in ~10.6s). A dedicated transport with generous
// handshake/response timeouts fixes it without loosening timeouts app-wide.
// termiiInspectionCAPEM is the O3 network's SSL-inspection appliance re-signing CA
// (CN=Root YR, O=ISRG) presented for api.ng.termii.com. The appliance ships a
// NON-self-signed anchor, which the Windows trust store will not honour as a root —
// so even a machine-wide import doesn't make Go trust the chain. A Go x509.CertPool
// DOES accept any member as a trust anchor, so we pin it here for the Termii client
// ONLY. Scoped to Termii; the rest of the app's TLS trust is untouched. If the
// appliance is ever bypassed, Termii's real Let's Encrypt cert still validates via
// the system roots that are also in the pool.
const termiiInspectionCAPEM = `-----BEGIN CERTIFICATE-----
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
-----END CERTIFICATE-----`

func termiiRootCAs() *x509.CertPool {
	pool, _ := x509.SystemCertPool()
	if pool == nil {
		pool = x509.NewCertPool()
	}
	pool.AppendCertsFromPEM([]byte(termiiInspectionCAPEM))
	return pool
}

var termiiHTTPClient = &http.Client{
	Timeout: 60 * time.Second,
	Transport: &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		TLSHandshakeTimeout:   45 * time.Second,
		ResponseHeaderTimeout: 45 * time.Second,
		IdleConnTimeout:       90 * time.Second,
		TLSClientConfig:       &tls.Config{RootCAs: termiiRootCAs()},
	},
}

// termiiPost performs a JSON POST to Termii through termiiHTTPClient.
func termiiPost(ctx context.Context, endpoint string, body []byte) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	return termiiHTTPClient.Do(req)
}

type termiiPayload struct {
	To      string `json:"to"`
	From    string `json:"from"`
	SMS     string `json:"sms"`
	Type    string `json:"type"`
	APIKey  string `json:"api_key"`
	Channel string `json:"channel"`
}

type termiiResponse struct {
	MessageID string `json:"message_id"`
	Message   string `json:"message"`
	Balance   any    `json:"balance"`
	User      string `json:"user"`
}

// SendSMS sends a plain-text SMS via Termii. phone must be in international
// format without the leading +  (e.g. "2348012345678"). Returns nil on success,
// and an error — never nil — when it could not send.
func SendSMS(ctx context.Context, phone, message string) error {
	apiKey := strings.TrimSpace(os.Getenv("TERMII_API_KEY"))
	if apiKey == "" {
		// This RETURNED NIL until 2026-09-30, reasoning that staging has no key and
		// should not error. But nil means success to every caller, so a missing key made
		// an unsent SMS indistinguishable from a delivered one — and callers write that
		// result into a customer's contact history. Recording that we texted someone
		// about money they owe, having not texted them, is worse than any staging
		// inconvenience. Staging now gets a clear error instead of a false receipt.
		slog.Warn("Termii: TERMII_API_KEY not set — SMS NOT sent", "phone", phone)
		return fmt.Errorf("termii: TERMII_API_KEY not configured, SMS not sent")
	}

	// api_credentials first via the env, same precedence as resolveCredKey, so the
	// sender name is changeable without a redeploy. The hard-coded fallback is the
	// cards brand and this is O3 Capital's lending book, so it is a last resort only.
	senderID := strings.TrimSpace(os.Getenv("TERMII_SENDER_ID"))
	if senderID == "" {
		senderID = "O3 CARDS"
	}

	phone = normalizeTermiiPhone(phone)
	if phone == "" {
		return fmt.Errorf("termii: invalid phone number")
	}

	payload := termiiPayload{
		To:      phone,
		From:    senderID,
		SMS:     message,
		Type:    "plain",
		APIKey:  apiKey,
		Channel: "dnd",
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("termii: marshal: %w", err)
	}

	// Generous timeout: the O3 network's SSL-inspection appliance adds ~10s of
	// latency to every api.ng.termii.com call, so a tight timeout spuriously fails
	// a request that is actually succeeding upstream.
	reqCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, termiiSendURL, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("termii: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := termiiHTTPClient.Do(req)
	if err != nil {
		return fmt.Errorf("termii: http: %w", err)
	}
	defer resp.Body.Close()

	var tr termiiResponse
	_ = json.NewDecoder(resp.Body).Decode(&tr)

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return fmt.Errorf("termii: status %d — %s", resp.StatusCode, tr.Message)
	}

	slog.Info("Termii: SMS sent", "phone", phone, "message_id", tr.MessageID)
	return nil
}

// ── Admin: Termii health / status & test-send ────────────────────────────────
//
// These run through the backend (which can reach Termii) so an operator can, from
// the app, confirm the account is funded and the sender ID is approved — the two
// account-level things that actually decide whether MTN/Airtel/Glo/9mobile SMS
// gets delivered — and fire a single real test SMS to prove end-to-end delivery.
func RegisterTermiiAdmin(r chi.Router, db *core.DB) {
	r.Get("/termii/status", TermiiStatus(db))
	r.Post("/termii/test-send", TermiiTestSend(db))
}

// termiiGET performs an authenticated GET against a Termii endpoint and returns the
// decoded JSON body + HTTP status.
func termiiGET(ctx context.Context, endpoint string) (map[string]any, int, error) {
	reqCtx, cancel := context.WithTimeout(ctx, 45*time.Second) // appliance adds ~10s latency
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, 0, err
	}
	resp, err := termiiHTTPClient.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	var m map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&m)
	return m, resp.StatusCode, nil
}

// TermiiStatus returns the live Termii balance and the registered sender IDs with
// their approval status — the answer to "can we actually send to all networks".
func TermiiStatus(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		apiKey := resolveCredKey(ctx, db, "TERMII_API_KEY")
		if apiKey == "" {
			respondErr(w, 503, "TERMII_API_KEY is not configured")
			return
		}
		senderID := coalesce(resolveCredKey(ctx, db, "TERMII_SENDER_ID"), "O3 CARDS")
		out := map[string]any{"configured_sender_id": senderID, "channel": "dnd"}

		if m, code, err := termiiGET(ctx, "https://api.ng.termii.com/api/get-balance?api_key="+url.QueryEscape(apiKey)); err != nil {
			out["balance_error"] = err.Error()
		} else if code == 200 {
			out["balance"] = m["balance"]
			out["currency"] = m["currency"]
			out["user"] = m["user"]
		} else {
			out["balance_error"] = fmt.Sprintf("Termii HTTP %d: %v", code, m["message"])
		}

		if m, code, err := termiiGET(ctx, "https://api.ng.termii.com/api/sender-id?api_key="+url.QueryEscape(apiKey)); err != nil {
			out["sender_error"] = err.Error()
		} else if code == 200 {
			out["sender_ids"] = m["data"] // [{sender_id, status, usecase, company, country}]
		} else {
			out["sender_error"] = fmt.Sprintf("Termii HTTP %d: %v", code, m["message"])
		}

		respond(w, out, "termii")
	}
}

// TermiiTestSend fires a single real SMS to prove delivery to a specific number /
// network. Reuses the campaign send path (DND channel, DB-resolved key) so the test
// exercises exactly what production uses. Costs one SMS credit.
func TermiiTestSend(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			To      string `json:"to"`
			Message string `json:"message"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if strings.TrimSpace(body.To) == "" {
			respondErr(w, 400, "to (phone number) is required")
			return
		}
		msg := strings.TrimSpace(body.Message)
		if msg == "" {
			msg = "O3 Capital Workspace: test SMS — please ignore."
		}
		ok, providerID := sendSMS(r.Context(), db, body.To, msg)
		respond(w, map[string]any{
			"ok":          ok,
			"to":          normalizeTermiiPhone(body.To),
			"provider_id": providerID, // Termii message_id on success, error text on failure
			"sender_id":   coalesce(resolveCredKey(r.Context(), db, "TERMII_SENDER_ID"), "O3 CARDS"),
		}, "termii")
	}
}

// normalizeTermiiPhone puts a number into the plain international form Termii wants
// (2348012345678), or returns "" when it is not a number worth paying to send to.
//
// THE TEN-DIGIT CASE IS THE WHOLE REASON THIS WAS REWRITTEN. The old version handled
// only the 11-digit 0XXXXXXXXXX form and passed everything else through untouched. But
// 260 of the 558 phone numbers in the arrears book — 47% — are stored as ten digits
// with the leading zero already stripped (8059342861), because that is what
// app.norm_phone produces and what several upstream feeds supply. Those went to Termii
// as "8059342861", which is not a routable number anywhere. Nearly half the book would
// have silently failed, one paid API call at a time, and the dunning log would have
// recorded "failed" against people whose numbers were perfectly good.
//
// It now also REFUSES what it cannot fix. The old code returned anything 7 characters
// or longer, so "7212399" and "802523260" were sent and billed. An empty return makes
// sendSMS report "invalid phone number", which lands in dunning_sends as a no-contact
// the collections team can act on, instead of a delivery failure that looks like the
// customer's phone is off.
func normalizeTermiiPhone(raw string) string {
	var d strings.Builder
	for _, r := range raw {
		if r >= '0' && r <= '9' {
			d.WriteRune(r)
		}
	}
	n := d.String()

	switch {
	// Already international and well formed.
	case len(n) == 13 && strings.HasPrefix(n, "234"):
		return n
	// 234 followed by the local zero, e.g. 2340803... A common double-prefix mistake
	// when a local number is concatenated onto a country code.
	case len(n) == 14 && strings.HasPrefix(n, "2340"):
		return "234" + n[4:]
	// Local 11-digit: 0803..., 0703..., 0903..., 0913...
	case len(n) == 11 && n[0] == '0' && isNigerianMobilePrefix(n[1]):
		return "234" + n[1:]
	// Ten digits with the leading zero already gone. The 47% case.
	case len(n) == 10 && isNigerianMobilePrefix(n[0]):
		return "234" + n
	// Some other country, already in international form. Left alone rather than
	// mangled: this book is Nigerian but the function is not Nigeria-only.
	case len(n) >= 11 && len(n) <= 15:
		return n
	}
	return ""
}

// isNigerianMobilePrefix reports whether a digit can start a Nigerian mobile number
// once the leading zero is removed. Every MTN, Airtel, Glo and 9mobile range begins
// 7, 8 or 9; a number starting 6 (one is in the book) is not a mobile at all.
func isNigerianMobilePrefix(b byte) bool { return b == '7' || b == '8' || b == '9' }

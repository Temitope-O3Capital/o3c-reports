package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

/*
WhatsApp setup and health — the screen you use on the day the credentials arrive.

WHY THIS IS A PAGE AND NOT A README. Connecting a WhatsApp Business Account has four
moving parts that fail independently and silently: a phone number id, an access token, an
app secret for webhook signatures, and a verify token Meta echoes during subscription. If
any one is missing the symptom is the same — nothing happens — and the logs that would
say which are on a server nobody watching the onboarding can read.

So this reports each part separately, says what it is FOR, and offers one button that
actually asks Meta whether the account is reachable. Everything here is read-only: it
never writes a credential, because the credential store already has a screen and a second
way to set a secret is a second way to leak one.

NOTHING HERE REVEALS A SECRET. Each credential reports only whether it is set and how
long it is. A setup screen that printed the token would put a WABA-wide bearer credential
into every screenshot of a support call.
*/

func RegisterWhatsAppAdmin(r chi.Router, db *core.DB) {
	// Settings-grade access: this names the credentials the platform holds and can make
	// an authenticated call to Meta. 'campaigns' is included because the marketing team
	// owns the number's reputation and needs to see quality rating and tier without
	// waiting on IT.
	access := core.RequirePages("settings", "campaigns")

	r.With(access).Get("/status", waAdminStatus(db))
	r.With(access).Post("/test", waAdminTest(db))
}

// waCredState describes one credential without disclosing it.
type waCredState struct {
	Key    string `json:"key"`
	Set    bool   `json:"set"`
	Length int    `json:"length"`
	Source string `json:"source"` // "env" | "credential store" | ""
	Needed string `json:"needed"` // what breaks without it
}

func waCredLook(ctx context.Context, db *core.DB, key, needed string) waCredState {
	st := waCredState{Key: key, Needed: needed}
	if v := os.Getenv(key); v != "" {
		return waCredState{Key: key, Set: true, Length: len(v), Source: "env", Needed: needed}
	}
	if v := resolveCredKey(ctx, db, key); v != "" {
		st.Set, st.Length, st.Source = true, len(v), "credential store"
	}
	return st
}

// waAdminStatus answers "what is connected, and what is still missing".
func waAdminStatus(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		creds := []waCredState{
			waCredLook(ctx, db, "WHATSAPP_PHONE_NUMBER_ID",
				"Nothing can be sent. This is the number Meta sends from."),
			waCredLook(ctx, db, "WHATSAPP_ACCESS_TOKEN",
				"Nothing can be sent. This is the bearer token for every Cloud API call."),
			waCredLook(ctx, db, "WHATSAPP_APP_SECRET",
				"Inbound messages are REFUSED with 503: without it the X-Hub-Signature-256 "+
					"on Meta's webhook cannot be verified, and an unverified webhook is a "+
					"spoofable one."),
			waCredLook(ctx, db, "WHATSAPP_WEBHOOK_VERIFY_TOKEN",
				"Meta's webhook subscription handshake fails, so no inbound message or "+
					"delivery receipt ever arrives."),
		}
		ready := true
		for _, c := range creds {
			if !c.Set {
				ready = false
			}
		}

		// The webhook URL Meta must be given. Built from the configured public base so
		// the screen shows what to paste rather than asking someone to assemble it — and
		// says plainly when that base is not reachable from the internet, which is the
		// failure that silently cost this platform its campaign open tracking and every
		// CSAT response.
		base := strings.TrimRight(strings.TrimSpace(firstNonEmpty(
			os.Getenv("APP_URL"), os.Getenv("APP_BASE_URL"))), "/")
		publicOK := base != "" && hdCSATBaseIsPublic(base)
		webhook := ""
		if base != "" {
			webhook = base + waWebhookPublicPath
		}

		out := map[string]any{
			"credentials":    creds,
			"ready_to_send":  ready,
			"webhook_url":    webhook,
			"webhook_public": publicOK,
			"graph_version":  waAPIBase,
		}
		if !publicOK {
			out["webhook_warning"] = "This base URL is not reachable from the internet, so " +
				"Meta cannot deliver webhooks to it. Inbound messages, delivery receipts and " +
				"ad-click attribution will all be missing — the send side will appear to work."
		}

		// A short read of the ledger, so the screen shows real traffic rather than only
		// configuration. Zero rows with credentials set is itself diagnostic.
		if rows, err := db.PGQuery(ctx, `
			SELECT COUNT(*)                                                        AS total,
			       COUNT(*) FILTER (WHERE direction = 'in')                         AS inbound,
			       COUNT(*) FILTER (WHERE direction = 'out')                        AS outbound,
			       COUNT(*) FILTER (WHERE status = 'failed')                        AS failed,
			       COUNT(*) FILTER (WHERE ctwa_clid IS NOT NULL)                    AS from_ads,
			       COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours') AS last_24h
			  FROM app.whatsapp_messages`); err == nil && len(rows) > 0 {
			out["traffic"] = rows[0]
		}
		if rows, err := db.PGQuery(ctx,
			`SELECT COUNT(*) AS open_windows FROM app.v_whatsapp_window WHERE window_open`); err == nil && len(rows) > 0 {
			out["open_windows"] = rows[0]["open_windows"]
		}

		respond(w, out, "pg")
	}
}

// waAdminTest asks Meta whether the configured number is actually reachable.
//
// It calls GET /{phone_number_id}, which is the cheapest authenticated read there is: it
// needs the same token and id every send needs, sends no message, costs nothing, and
// returns the two things nobody can see from inside this platform — the display name
// Meta has verified, and the quality rating that governs how many customers the number
// may reach per day.
func waAdminTest(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		phoneID := resolveCredKey(ctx, db, "WHATSAPP_PHONE_NUMBER_ID")
		token := resolveCredKey(ctx, db, "WHATSAPP_ACCESS_TOKEN")
		if phoneID == "" || token == "" {
			respondErr(w, 422, "Set WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN first")
			return
		}

		url := fmt.Sprintf("%s/%s?fields=display_phone_number,verified_name,quality_rating,platform_type",
			waAPIBase, phoneID)
		req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
		if err != nil {
			respondErrLog(w, 500, "Could not build the request", err)
			return
		}
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
		if err != nil {
			// The most likely cause by far, and worth saying rather than making someone
			// read a transport error: this host cannot reach the internet.
			respondErr(w, 502, "Could not reach Meta: "+err.Error()+
				". If this host has no outbound internet access, no WhatsApp call will work.")
			return
		}
		defer resp.Body.Close()
		var d map[string]any
		json.NewDecoder(resp.Body).Decode(&d) //nolint:errcheck

		if resp.StatusCode != 200 {
			detail := ""
			if e, ok := d["error"].(map[string]any); ok {
				detail = str(e["message"])
			}
			// 190 is an expired or invalid token — by far the commonest, and the one
			// whose generic wording ("Invalid OAuth access token") sends people hunting
			// in the wrong place.
			respondErr(w, 422, fmt.Sprintf("Meta refused the request (HTTP %d). %s", resp.StatusCode, detail))
			return
		}

		respond(w, map[string]any{
			"ok":            true,
			"phone_number":  str(d["display_phone_number"]),
			"verified_name": str(d["verified_name"]),
			// Green, Yellow or Red. Red for 7 days costs a messaging tier, so it belongs
			// on the screen the marketing team watches, not only in Meta's dashboard.
			"quality_rating": str(d["quality_rating"]),
			"platform":       str(d["platform_type"]),
		}, "meta")
	}
}

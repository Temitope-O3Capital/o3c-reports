package handlers

// The offer letter, mandate cancellation, and the consent trail — the parts of the
// customer journey the workspace could not previously see or act on.
//
// Phoenix owns the Offer: it generates one when a request is approved, freezes the
// terms at that moment, sends it, and expires it after a tenant-configured window
// (14 days by default). The workspace already had an OfferPanel, but it wrote only
// to its own columns — a private note about an offer, with no connection to the
// document the customer actually received. Two systems each holding "the offer"
// with no link between them is exactly the drift the Phoenix integration exists to
// prevent, so these read Phoenix's offer and act on Phoenix's copy.
//
// One capability is deliberately missing: recording that the customer accepted or
// declined. Phoenix exposes accept and decline only on /v1/portal/offers/{id}/…,
// behind a staff JWT, with no machine equivalent — so an API-key integration can
// read an offer, resend it, and watch it expire, but cannot record the answer.
// Adding those two routes to Phoenix is the fix; until then the workspace does not
// pretend to offer the action.

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

// ── Offer ────────────────────────────────────────────────────────────────────

// losOffers returns every offer Phoenix holds for this application's credit
// request, newest version first.
//
// A credit request can carry more than one: Phoenix versions offers, and the live
// one is whichever is DRAFT, SENT or VIEWED. The list is returned whole rather than
// reduced to "the current offer" because the earlier versions are the record of
// what was previously put to the customer, which is the question an officer asks
// when a customer says they were told something different.
func losOffers(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := losParseID(r)
		if err != nil {
			respondErr(w, 400, "Invalid application ID")
			return
		}
		c, err := phoenixLoadAppContext(r.Context(), db, id)
		if err != nil {
			// Not an error the officer can act on: an application that never
			// reached Phoenix simply has no offer. Say so rather than 502.
			respond(w, map[string]any{"offers": nil, "reason": err.Error()}, "phoenix")
			return
		}
		raw, err := phoenixCall(r.Context(), http.MethodGet,
			"/credit-requests/"+c.PhoenixID+"/offers", nil)
		if err != nil {
			respondErrLog(w, 502, "Could not read offers from Phoenix", err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":{"offers":`)) //nolint:errcheck
		w.Write(raw)                          //nolint:errcheck
		w.Write([]byte(`}}`))                 //nolint:errcheck
	}
}

// losOfferResend asks Phoenix to send the same offer again — an officer nudge when
// a customer says they never received it.
//
// This re-fans-out the existing offer; it does not regenerate one. Phoenix's
// SendOffer keeps the frozen terms and the original expiry, so a resend never
// quietly gives the customer a longer window or different numbers.
func losOfferResend(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := losParseID(r)
		if err != nil {
			respondErr(w, 400, "Invalid application ID")
			return
		}
		offerID := strings.TrimSpace(chi.URLParam(r, "offer_id"))
		if offerID == "" {
			respondErr(w, 400, "offer_id is required")
			return
		}
		raw, err := phoenixCall(r.Context(), http.MethodPost,
			"/offers/"+offerID+"/resend", map[string]any{})
		if err != nil {
			respondErrLog(w, 502, err.Error(), err)
			return
		}
		user := core.UserFromCtx(r.Context())
		// Name the offer in the trail. "Offer resent" on an application with three
		// versions does not say which one the customer just received again.
		var o struct {
			Reference string `json:"reference"`
			Version   int    `json:"version"`
		}
		note := "Offer letter resent to the customer"
		if json.Unmarshal(raw, &o) == nil && o.Reference != "" {
			note = "Offer letter " + o.Reference + " resent to the customer"
		}
		phoenixLogWorkspaceAction(r.Context(), db, id, user.ID, "offer.resent", note)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":`)) //nolint:errcheck
		w.Write(raw)                //nolint:errcheck
		w.Write([]byte(`}`))        //nolint:errcheck
	}
}

// ── Mandate cancellation ─────────────────────────────────────────────────────

// losMandateCancel cancels a direct-debit mandate.
//
// Separate from losMandateAction because it is not a nudge: Phoenix calls the
// provider's cancel API on the way through (NIBSS, Mono or Remita, unless the
// connection is a sandbox one), so this stops a real instruction to debit a real
// customer's real account. It also requires a reason, which the reminder and
// status-check actions do not — a cancelled mandate blocks disbursement on any
// product that requires one, and somebody will ask later why it was cancelled.
func losMandateCancel(db *core.DB) http.HandlerFunc {
	type body struct {
		Reason string `json:"reason"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := losParseID(r)
		if err != nil {
			respondErr(w, 400, "Invalid application ID")
			return
		}
		mandateID := strings.TrimSpace(chi.URLParam(r, "mandate_id"))
		if mandateID == "" {
			respondErr(w, 400, "mandate_id is required")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if strings.TrimSpace(b.Reason) == "" {
			respondErr(w, 400, "A reason is required to cancel a mandate")
			return
		}
		raw, err := phoenixCall(r.Context(), http.MethodPost,
			"/open-banking/mandates/"+mandateID+"/status", map[string]any{
				"status":         "CANCELLED",
				"failure_reason": strings.TrimSpace(b.Reason),
			})
		if err != nil {
			respondErrLog(w, 502, err.Error(), err)
			return
		}
		user := core.UserFromCtx(r.Context())
		phoenixLogWorkspaceAction(r.Context(), db, id, user.ID, "mandate.cancelled",
			"Direct debit mandate cancelled: "+strings.TrimSpace(b.Reason))
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":`)) //nolint:errcheck
		w.Write(raw)                //nolint:errcheck
		w.Write([]byte(`}`))        //nolint:errcheck
	}
}

// losMandateCollections lists the debits Phoenix has attempted against a mandate.
//
// This is what makes a mandate meaningful to an officer: ACTIVE only says the
// instruction is registered, while the collection history says whether money has
// actually been taken, and a run of FAILED rows is the earliest warning that a
// repayment is about to go wrong.
func losMandateCollections(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, err := losParseID(r); err != nil {
			respondErr(w, 400, "Invalid application ID")
			return
		}
		mandateID := strings.TrimSpace(chi.URLParam(r, "mandate_id"))
		if mandateID == "" {
			respondErr(w, 400, "mandate_id is required")
			return
		}
		raw, err := phoenixCall(r.Context(), http.MethodGet,
			"/open-banking/collections?mandate_id="+mandateID, nil)
		if err != nil {
			respondErrLog(w, 502, "Could not read collections from Phoenix", err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":{"collections":`)) //nolint:errcheck
		w.Write(raw)                               //nolint:errcheck
		w.Write([]byte(`}}`))                      //nolint:errcheck
	}
}

// ── Consent ──────────────────────────────────────────────────────────────────

// losConsentTrail reports what the workspace knows about NDPA consent for this
// application.
//
// It reads the workspace's own activity trail, not Phoenix. That is a limitation,
// not a design choice: Phoenix can be written to machine-to-machine (POST
// /v1/portal/customers/{id}/consent-records takes tenant_id in the body) but the
// only way to read consent back is /v1/admin/compliance/consent, which needs a
// console super-admin session. So the workspace can say "consent was recorded from
// here, by this person, at this time" — which is the question staff actually ask
// before a bureau pull — but it cannot yet confirm consent captured in Phoenix's
// own intake wizard. A tenant-scoped read endpoint on Phoenix would close that.
func losConsentTrail(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := losParseID(r)
		if err != nil {
			respondErr(w, 400, "Invalid application ID")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT e.event_type,
			       e.notes,
			       e.created_at,
			       e.actor_source,
			       COALESCE(u.full_name, e.actor_label, '') AS actor
			  FROM app.application_events e
			  LEFT JOIN app.o3c_users u ON u.id = e.actor_user_id
			 WHERE e.application_id = $1
			   AND e.event_type LIKE 'consent%'
			 ORDER BY e.created_at DESC`, id)
		if err != nil {
			respondErrLog(w, 500, "Could not read the consent trail", err)
			return
		}
		respond(w, map[string]any{
			"records": rows,
			// Whether consent currently holds is decided by the newest record, the
			// same rule Phoenix's HasActiveConsent applies to its own ledger.
			"granted":          len(rows) > 0 && !strings.Contains(strings.ToLower(str(rows[0]["event_type"])), "revoke"),
			"phoenix_readable": false,
			"phoenix_read_gap": "Phoenix exposes no tenant-scoped consent read; this is the workspace's own record.",
		}, "")
	}
}

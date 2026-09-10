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
// The customer's answer is recorded through Phoenix's machine routes
// (/v1/offers/{id}/accept|decline), which Phoenix added for this integration. The
// offer letter PDF is read the same way, but Phoenix does not yet let the API key
// read it — see losOfferPDF.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
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
			respondPhoenixErr(w, r, err, "read the offers for this application")
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
		if !phoenixUUID(offerID) {
			respondErr(w, 400, "offer_id is not a Phoenix offer id")
			return
		}
		raw, err := phoenixCall(r.Context(), http.MethodPost,
			"/offers/"+offerID+"/resend", map[string]any{})
		if err != nil {
			respondPhoenixErr(w, r, err, "resend the offer")
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

// losOfferAccept and losOfferDecline record the customer's answer to the offer.
//
// Phoenix does the real work: accepting confirms the frozen amount and activates the
// credit account (rolling the offer status back if activation fails), and declining
// also declines the linked credit request. The workspace only carries the decision an
// officer took with the customer.
//
// acted_by_label carries who that officer was. An API key has no Phoenix staff user
// behind it, so Phoenix cannot attribute the decision to an account — the label is a
// free-text breadcrumb on its audit trail, and the workspace's own activity row is
// the attributable record.
func losOfferDecision(db *core.DB, action string) http.HandlerFunc {
	type body struct {
		Reason string `json:"reason"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := losParseID(r)
		if err != nil {
			respondErr(w, 400, "Invalid application ID")
			return
		}
		offerID := strings.TrimSpace(chi.URLParam(r, "offer_id"))
		if !phoenixUUID(offerID) {
			respondErr(w, 400, "offer_id is not a Phoenix offer id")
			return
		}
		var b body
		// Accept carries no body; tolerate an absent or empty one rather than 400.
		if r.Body != nil {
			_ = json.NewDecoder(r.Body).Decode(&b)
		}
		reason := strings.TrimSpace(b.Reason)
		if action == "decline" && reason == "" {
			respondErr(w, 400, "A reason is required to decline an offer")
			return
		}

		user := core.UserFromCtx(r.Context())
		payload := map[string]any{}
		if user != nil && strings.TrimSpace(user.FullName) != "" {
			payload["acted_by_label"] = "O3 Workspace — " + strings.TrimSpace(user.FullName)
		} else {
			payload["acted_by_label"] = "O3 Workspace"
		}
		if action == "decline" {
			payload["reason"] = reason
		}

		raw, err := phoenixCall(r.Context(), http.MethodPost, "/offers/"+offerID+"/"+action, payload)
		if err != nil {
			// Phoenix enforces the rules here — an offer already accepted, declined or
			// past its expiry is refused, and its reason is the useful message.
			respondPhoenixErr(w, r, err, map[string]string{
				"accept":  "record the acceptance",
				"decline": "record the decline",
			}[action])
			return
		}

		var o struct {
			Reference string `json:"reference"`
		}
		_ = json.Unmarshal(raw, &o)
		ref := o.Reference
		if ref == "" {
			ref = "offer"
		}
		note := "Customer accepted " + ref
		if action == "decline" {
			note = "Customer declined " + ref + ": " + reason
		}
		var uid int64
		if user != nil {
			uid = user.ID
		}
		phoenixLogWorkspaceAction(r.Context(), db, id, uid, "offer."+action+"ed", note)

		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":`)) //nolint:errcheck
		w.Write(raw)                //nolint:errcheck
		w.Write([]byte(`}`))        //nolint:errcheck
	}
}

// losOfferPDF streams the offer letter Phoenix renders for one offer — the document
// the customer was sent, drawn by Phoenix from the frozen terms. The workspace shows
// Phoenix's PDF rather than drawing its own for the reason it shows Phoenix's offer
// rather than keeping one: two renderings of "the offer" drift apart.
//
// The offer must belong to this application's credit request. Without that check any
// offer id in the tenant could be read through any application the caller can open.
//
// Phoenix currently serves this PDF only to someone signed in to Phoenix: offerPDF
// takes the tenant from a staff login and never consults the API key, so the
// workspace's key is answered 401. The same key has just read the offer list, so a
// 401 here is that rule and not a bad key, and it is reported as such. The fix is
// Phoenix's (offer_pdf.go); this starts working the moment it lands.
func losOfferPDF(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := losParseID(r)
		if err != nil {
			respondErr(w, 400, "Invalid application ID")
			return
		}
		offerID := strings.TrimSpace(chi.URLParam(r, "offer_id"))
		if !phoenixUUID(offerID) {
			respondErr(w, 400, "offer_id is not a Phoenix offer id")
			return
		}
		c, err := phoenixLoadAppContext(r.Context(), db, id)
		if err != nil {
			respondErr(w, 422, err.Error())
			return
		}
		raw, err := phoenixCall(r.Context(), http.MethodGet, "/credit-requests/"+c.PhoenixID+"/offers", nil)
		if err != nil {
			respondPhoenixErr(w, r, err, "check the offer belongs to this application")
			return
		}
		var offers []struct {
			ID        string `json:"id"`
			Reference string `json:"reference"`
		}
		_ = json.Unmarshal(raw, &offers)
		ref := ""
		for _, o := range offers {
			if strings.EqualFold(o.ID, offerID) {
				ref = o.Reference
				if ref == "" {
					ref = offerID
				}
				break
			}
		}
		if ref == "" {
			respondErr(w, 404, "That offer is not one of this application's offers")
			return
		}

		pdf, err := phoenixCall(r.Context(), http.MethodGet, "/offers/"+offerID+"/pdf", nil)
		if err != nil {
			var ce phoenixCallError
			if errors.As(err, &ce) && ce.Status == http.StatusUnauthorized {
				writePhoenixFailure(w, phoenixFailure{http.StatusBadGateway, "PHOENIX_PDF_STAFF_ONLY",
					"Phoenix only hands out the offer letter PDF to someone signed in to Phoenix, not to the workspace's API key. The Phoenix team needs to let the API key read it (offer_pdf.go). Until then, open the letter from the application in Phoenix."}, err)
				return
			}
			respondPhoenixErr(w, r, err, "produce the offer letter")
			return
		}
		if !bytes.HasPrefix(pdf, []byte("%PDF")) {
			writePhoenixFailure(w, phoenixFailure{http.StatusBadGateway, "PHOENIX_ERROR",
				"Phoenix answered, but not with a PDF, so the offer letter cannot be shown."},
				fmt.Errorf("offer %s pdf: %d bytes, not a PDF", offerID, len(pdf)))
			return
		}
		// The reference comes from Phoenix; keep only what is safe in a header.
		name := strings.Map(func(c rune) rune {
			if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' {
				return c
			}
			return -1
		}, ref)
		w.Header().Set("Content-Type", "application/pdf")
		w.Header().Set("Content-Disposition", `inline; filename="offer-`+name+`.pdf"`)
		w.Header().Set("Cache-Control", "private, no-store")
		w.Write(pdf) //nolint:errcheck
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
		if !phoenixUUID(mandateID) {
			respondErr(w, 400, "mandate_id is not a Phoenix mandate id")
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
			respondPhoenixErr(w, r, err, "cancel the mandate")
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
		if !phoenixUUID(mandateID) {
			respondErr(w, 400, "mandate_id is not a Phoenix mandate id")
			return
		}
		raw, err := phoenixCall(r.Context(), http.MethodGet,
			"/open-banking/collections?mandate_id="+mandateID, nil)
		if err != nil {
			respondPhoenixErr(w, r, err, "read the debits on this mandate")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":{"collections":`)) //nolint:errcheck
		w.Write(raw)                               //nolint:errcheck
		w.Write([]byte(`}}`))                      //nolint:errcheck
	}
}

// ── Consent ──────────────────────────────────────────────────────────────────

// losConsentTrail reports NDPA consent for this application from both sides.
//
// Phoenix is the system of record and is asked first: GET /v1/customers/{id}/
// consent-records returns its ledger newest-first, so the first row of a consent
// type is the one that decides whether that consent currently holds — the same rule
// Phoenix's own HasActiveConsent applies. That endpoint did not exist until the
// consent read-back landed; before it, consent could be written machine-to-machine
// but only read as a console super-admin, so the workspace was flying blind on
// something that gates bureau lookups.
//
// The workspace's own activity rows are returned alongside, because Phoenix's ledger
// records that consent exists but not which officer captured it from here.
func losConsentTrail(db *core.DB) http.HandlerFunc {
	type consentRec struct {
		ConsentType string  `json:"consent_type"`
		Granted     bool    `json:"granted"`
		GrantedAt   string  `json:"granted_at"`
		RevokedAt   *string `json:"revoked_at"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := losParseID(r)
		if err != nil {
			respondErr(w, 400, "Invalid application ID")
			return
		}

		// Phoenix's ledger. A failure here is reported rather than fatal: the
		// workspace's own trail below is still worth showing, and an application
		// that never reached Phoenix has no customer to ask about.
		var phoenixRecords []consentRec
		var phoenixNote string
		granted := false
		if c, cerr := phoenixLoadAppContext(r.Context(), db, id); cerr != nil {
			phoenixNote = cerr.Error()
		} else if c.CustomerID == "" {
			phoenixNote = "Phoenix has no customer id for this application yet"
		} else if raw, perr := phoenixCall(r.Context(), http.MethodGet,
			"/customers/"+c.CustomerID+"/consent-records", nil); perr != nil {
			phoenixNote = classifyPhoenixErr(perr, "read Phoenix's consent ledger", false).Message
		} else if jerr := json.Unmarshal(raw, &phoenixRecords); jerr != nil {
			phoenixNote = "Phoenix returned consent records the workspace could not read"
		} else {
			// Newest first, so the first NDPA row decides.
			for _, rec := range phoenixRecords {
				if strings.EqualFold(rec.ConsentType, "NDPA") {
					granted = rec.Granted && rec.RevokedAt == nil
					break
				}
			}
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
			// Phoenix decides. granted reflects its newest NDPA row, not ours — a
			// consent captured in Phoenix's own intake wizard counts just as much as
			// one recorded from here, and only Phoenix sees both.
			"granted":         granted,
			"phoenix_records": phoenixRecords,
			"phoenix_note":    phoenixNote,
			// Our rows say who captured it from the workspace, which Phoenix's
			// ledger does not record.
			"workspace_events": rows,
		}, "")
	}
}

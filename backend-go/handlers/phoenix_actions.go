package handlers

// Phoenix lifecycle actions, performed from the workspace.
//
// Phoenix owns the customer journey — offer, amount confirmation, NDPA consent,
// direct-debit mandate, card issuance — and until now every one of those could
// only be done in Phoenix's own UI. Staff working an application in the workspace
// had to switch systems to move it forward, and the workspace could not even show
// where the journey had got to.
//
// Each action here does three things: call Phoenix (which stays the system of
// record), record the result on the application's activity trail attributed to the
// workspace user who took it, and return Phoenix's own response so the caller sees
// what actually happened rather than an optimistic assumption.
//
// Nothing here duplicates state locally. If Phoenix rejects an action the workspace
// records nothing and surfaces Phoenix's reason — a mandate that exists in one
// system and not the other is worse than an error message.

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

// phoenixAppContext is everything an action needs about an application: our id,
// Phoenix's credit request id, and the applicant details Phoenix asks for when
// registering a mandate against a Mono-flavoured connection.
type phoenixAppContext struct {
	AppID      int64
	PhoenixID  string
	CustomerID string
	Name       string
	Phone      string
	Email      string
	BVN        string
	Address    string
}

// phoenixLoadAppContext resolves an application and its Phoenix identifiers.
//
// The customer id is read from Phoenix's prequalification report rather than
// stored locally: the workspace learns a credit request id at submission and never
// a customer id, and duplicating an id we do not own is how the two systems drift.
func phoenixLoadAppContext(ctx context.Context, db *core.DB, appID int64) (*phoenixAppContext, error) {
	rows, err := db.PGQuery(ctx, `
		SELECT COALESCE(phoenix_id,'')          AS phoenix_id,
		       COALESCE(applicant_name,'')      AS applicant_name,
		       COALESCE(applicant_phone,'')     AS applicant_phone,
		       COALESCE(applicant_email,'')     AS applicant_email,
		       COALESCE(bvn,'')                 AS bvn,
		       COALESCE(residential_address,'') AS residential_address
		  FROM app.loan_applications WHERE id=$1`, appID)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("application not found")
	}
	r := rows[0]
	c := &phoenixAppContext{
		AppID:     appID,
		PhoenixID: str(r["phoenix_id"]),
		Name:      str(r["applicant_name"]),
		Phone:     str(r["applicant_phone"]),
		Email:     str(r["applicant_email"]),
		BVN:       str(r["bvn"]),
		Address:   str(r["residential_address"]),
	}
	if c.PhoenixID == "" {
		return nil, fmt.Errorf("this application has not been submitted to Phoenix")
	}

	raw, err := phoenixCall(ctx, http.MethodGet,
		"/credit-requests/"+c.PhoenixID+"/prequalification-report", nil)
	if err != nil {
		return nil, err
	}
	var rep struct {
		CustomerID string `json:"customer_id"`
	}
	if err := json.Unmarshal(raw, &rep); err == nil {
		c.CustomerID = rep.CustomerID
	}
	return c, nil
}

// phoenixLogWorkspaceAction records an action a workspace user took against
// Phoenix. Attribution matters as much as the fact: "mandate reminder sent" is a
// different entry depending on whether an officer sent it or Phoenix's scheduler
// did, and migration 223 exists so the trail can say which.
func phoenixLogWorkspaceAction(ctx context.Context, db *core.DB, appID int64, userID int64, eventType, notes string) {
	if _, err := db.PGExec(ctx, `
		INSERT INTO app.application_events
			(application_id, event_type, actor_user_id, actor_source, notes, created_at)
		VALUES ($1, $2, $3, 'workspace', NULLIF($4,''), NOW())`,
		appID, eventType, userID, notes); err != nil {
		// Never fail the action because its audit line could not be written — the
		// action already happened in Phoenix. Log loudly instead.
		slog.Error("phoenix action: could not record activity", "application_id", appID, "event", eventType, "err", err)
	}
}

// ── Mandate ──────────────────────────────────────────────────────────────────

// phoenixDirectDebitProvider reports whether Phoenix has a direct-debit provider it
// can actually register a mandate with, and if not, why not.
//
// This has to be asked BEFORE registering. Phoenix creates the mandate row first and
// only then looks for a NIBSS, Mono or Remita connection — and when it finds none it
// still returns success. The result is a PENDING mandate no bank has ever seen, which
// Phoenix's mandate-reminders job then texts the customer about every four hours. The
// workspace cannot fix that inside Phoenix, but it can refuse to set it in motion.
//
// "Could not check" is reported as unavailable rather than guessed at: a retry costs
// the officer a minute, a phantom mandate costs the customer a stream of SMS.
func phoenixDirectDebitProvider(ctx context.Context) (bool, string) {
	raw, err := phoenixCall(ctx, http.MethodGet, "/provider-connections", nil)
	if err != nil {
		return false, "Could not confirm a direct-debit provider with Phoenix: " + err.Error()
	}
	var conns []struct {
		ProviderType string `json:"provider_type"`
		Status       string `json:"status"`
	}
	if err := json.Unmarshal(raw, &conns); err != nil {
		return false, "Phoenix returned a provider list the workspace could not read."
	}
	for _, c := range conns {
		if strings.Contains(strings.ToUpper(c.ProviderType), "DEBIT") && strings.EqualFold(c.Status, "ACTIVE") {
			return true, ""
		}
	}
	return false, "No direct-debit provider (NIBSS, Mono or Remita) is configured in Phoenix, so a mandate cannot be registered with any bank yet."
}

// losMandate returns the direct-debit mandates Phoenix holds for this applicant,
// and whether a new one could be registered at all.
// Read-only, so it is safe for anyone who can open the application.
func losMandate(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := losParseID(r)
		if err != nil {
			respondErr(w, 400, "Invalid application ID")
			return
		}
		c, err := phoenixLoadAppContext(r.Context(), db, id)
		if err != nil {
			respond(w, map[string]any{"mandates": nil, "reason": err.Error()}, "phoenix")
			return
		}
		raw, err := phoenixCall(r.Context(), http.MethodGet, "/open-banking/mandates?customer_id="+c.CustomerID, nil)
		if err != nil {
			respondPhoenixErr(w, r, err, "read the mandates")
			return
		}
		// Carried alongside the list so the page can explain a disabled button up
		// front, instead of letting the officer fill in a form that can only fail.
		available, note := phoenixDirectDebitProvider(r.Context())
		respond(w, map[string]any{
			"mandates":           raw,
			"provider_available": available,
			"provider_note":      note,
		}, "phoenix")
	}
}

// losMandateSetup registers a direct-debit mandate for the applicant's account.
//
// The identity fields are sent unconditionally. Phoenix only requires them when the
// tenant's DIRECT_DEBIT connection is Mono-flavoured, but which provider answers is
// decided inside Phoenix at call time — so omitting them "because NIBSS does not
// need them" produces a failure the workspace cannot predict or explain.
func losMandateSetup(db *core.DB) http.HandlerFunc {
	type body struct {
		AccountNumber     string `json:"account_number"`
		AccountName       string `json:"account_name"`
		InstitutionCode   string `json:"institution_code"`
		MaximumAmountKobo int64  `json:"maximum_amount_kobo"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := losParseID(r)
		if err != nil {
			respondErr(w, 400, "Invalid application ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if strings.TrimSpace(b.AccountNumber) == "" {
			respondErr(w, 422, "account_number is required")
			return
		}
		c, err := phoenixLoadAppContext(r.Context(), db, id)
		if err != nil {
			respondErr(w, 422, err.Error())
			return
		}
		// Refuse before Phoenix creates anything — see phoenixDirectDebitProvider.
		if ok, note := phoenixDirectDebitProvider(r.Context()); !ok {
			respondErr(w, 422, note)
			return
		}

		payload := map[string]any{
			"customer_id":    c.CustomerID,
			"account_number": b.AccountNumber,
			"currency":       "NGN",
		}
		if v := strings.TrimSpace(b.AccountName); v != "" {
			payload["account_name"] = v
		} else if c.Name != "" {
			payload["account_name"] = c.Name
		}
		if v := strings.TrimSpace(b.InstitutionCode); v != "" {
			payload["institution_code"] = v
		}
		if b.MaximumAmountKobo > 0 {
			payload["maximum_amount_minor"] = b.MaximumAmountKobo
		}
		// Mono-flavoured connections need a customer profile to exist first.
		if c.BVN != "" {
			payload["customer_bvn"] = c.BVN
		}
		if c.Email != "" {
			payload["customer_email"] = c.Email
		}
		if c.Phone != "" {
			payload["customer_phone"] = c.Phone
		}
		if c.Address != "" {
			payload["customer_address"] = c.Address
		}
		if first, last, ok := splitName(c.Name); ok {
			payload["customer_first_name"] = first
			payload["customer_last_name"] = last
		}

		raw, err := phoenixCall(r.Context(), http.MethodPost, "/open-banking/mandates", payload)
		if err != nil {
			respondPhoenixErr(w, r, err, "register the mandate")
			return
		}
		// Belt and braces for the check above. A mandate that comes back without a
		// provider reference was never registered with a bank, whatever its status
		// says — the provider could have been removed between the two calls. Cancel
		// it at once so the reminder job never texts the customer about it. That is
		// safe: Phoenix only calls a provider's cancel API when a reference exists.
		var made struct {
			ID                string  `json:"id"`
			ProviderReference *string `json:"provider_reference"`
		}
		if json.Unmarshal(raw, &made) == nil && made.ID != "" &&
			(made.ProviderReference == nil || strings.TrimSpace(*made.ProviderReference) == "") {
			if _, cerr := phoenixCall(r.Context(), http.MethodPost, "/open-banking/mandates/"+made.ID+"/status", map[string]any{
				"status":         "CANCELLED",
				"failure_reason": "Never registered with a bank: no direct-debit provider answered. Cancelled by the workspace before it could be collected against or reminded about.",
			}); cerr != nil {
				slog.Error("mandate setup: could not cancel an unregistered mandate", "application_id", id, "mandate_id", made.ID, "err", cerr)
			}
			// Not respondErr: its 5xx scrubbing would turn this into "Internal server error".
			writePhoenixFailure(w, phoenixFailure{http.StatusBadGateway, "PHOENIX_MANDATE_UNREGISTERED",
				"Phoenix accepted the mandate but did not register it with any bank, so the workspace cancelled it straight away. Check that a direct-debit provider is configured in Phoenix."},
				fmt.Errorf("mandate %s came back with no provider reference", made.ID))
			return
		}
		user := core.UserFromCtx(r.Context())
		phoenixLogWorkspaceAction(r.Context(), db, id, user.ID, "mandate.setup",
			"Direct debit mandate registered on "+maskAccount(b.AccountNumber))
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":`)) //nolint:errcheck
		w.Write(raw)                //nolint:errcheck
		w.Write([]byte(`}`))        //nolint:errcheck
	}
}

// losMandateAction covers the per-mandate operations that take no body beyond the
// tenant: remind the customer, and re-check status with the provider.
func losMandateAction(db *core.DB, action string) http.HandlerFunc {
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
		raw, err := phoenixCall(r.Context(), http.MethodPost,
			"/open-banking/mandates/"+mandateID+"/"+action, map[string]any{})
		if err != nil {
			respondPhoenixErr(w, r, err, map[string]string{
				"remind":       "send the mandate reminder",
				"check-status": "re-check the mandate with the bank",
			}[action])
			return
		}
		user := core.UserFromCtx(r.Context())
		label := map[string]string{
			"remind":       "Mandate reminder sent to the customer",
			"check-status": "Mandate status re-checked with the provider",
		}[action]
		phoenixLogWorkspaceAction(r.Context(), db, id, user.ID, "mandate."+action, label)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":`)) //nolint:errcheck
		w.Write(raw)                //nolint:errcheck
		w.Write([]byte(`}`))        //nolint:errcheck
	}
}

// ── Amount confirmation ──────────────────────────────────────────────────────

// losConfirmAmount records the amount the customer actually accepted.
//
// Phoenix approves a CEILING; the customer then chooses what to draw. Until this
// existed the workspace could see the approval but not the customer's choice, so an
// application sat looking "approved, nothing happening" with no way to move it on
// from this side.
func losConfirmAmount(db *core.DB) http.HandlerFunc {
	type body struct {
		ChosenAmountKobo int64  `json:"chosen_amount_kobo"`
		ChosenLimitKobo  int64  `json:"chosen_limit_kobo"`
		Override         bool   `json:"override"`
		OverrideReason   string `json:"override_reason"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := losParseID(r)
		if err != nil {
			respondErr(w, 400, "Invalid application ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.ChosenAmountKobo <= 0 && b.ChosenLimitKobo <= 0 {
			respondErr(w, 422, "Enter the amount or limit the customer accepted")
			return
		}
		// An override bypasses Phoenix's own affordability guard, so it must carry a
		// reason. Recording WHY someone overrode a credit guard is the entire point
		// of allowing it.
		if b.Override && strings.TrimSpace(b.OverrideReason) == "" {
			respondErr(w, 422, "An override needs a reason")
			return
		}
		c, err := phoenixLoadAppContext(r.Context(), db, id)
		if err != nil {
			respondErr(w, 422, err.Error())
			return
		}

		payload := map[string]any{}
		if b.ChosenAmountKobo > 0 {
			payload["chosen_amount_minor"] = b.ChosenAmountKobo
		}
		if b.ChosenLimitKobo > 0 {
			payload["chosen_limit_minor"] = b.ChosenLimitKobo
		}
		if b.Override {
			payload["override"] = true
			payload["override_reason"] = strings.TrimSpace(b.OverrideReason)
		}

		raw, err := phoenixCall(r.Context(), http.MethodPost,
			"/credit-requests/"+c.PhoenixID+"/confirm-amount", payload)
		if err != nil {
			respondPhoenixErr(w, r, err, "confirm the amount")
			return
		}
		chosen := b.ChosenAmountKobo
		if chosen == 0 {
			chosen = b.ChosenLimitKobo
		}
		note := fmt.Sprintf("Customer confirmed %s", fmtKoboServer(chosen))
		if b.Override {
			note += " (override: " + strings.TrimSpace(b.OverrideReason) + ")"
		}
		user := core.UserFromCtx(r.Context())
		phoenixLogWorkspaceAction(r.Context(), db, id, user.ID, "credit_request.amount_confirmed", note)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":`)) //nolint:errcheck
		w.Write(raw)                //nolint:errcheck
		w.Write([]byte(`}`))        //nolint:errcheck
	}
}

// ── Consent ──────────────────────────────────────────────────────────────────

// losRecordConsent records NDPA consent for the applicant.
//
// Phoenix gates scoring on consent being on file. Capturing it from the workspace
// means an officer taking consent over the phone does not have to open Phoenix to
// write it down — which, in practice, meant it was written down late or not at all.
func losRecordConsent(db *core.DB) http.HandlerFunc {
	type body struct {
		Channel string `json:"channel"`
		Note    string `json:"note"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := losParseID(r)
		if err != nil {
			respondErr(w, 400, "Invalid application ID")
			return
		}
		var b body
		_ = json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck
		c, err := phoenixLoadAppContext(r.Context(), db, id)
		if err != nil {
			respondErr(w, 422, err.Error())
			return
		}
		channel := strings.TrimSpace(b.Channel)
		if channel == "" {
			channel = "phone"
		}
		payload := map[string]any{
			"purpose": "CREDIT_ASSESSMENT",
			"channel": channel,
			"granted": true,
		}
		if v := strings.TrimSpace(b.Note); v != "" {
			payload["note"] = v
		}
		raw, err := phoenixCall(r.Context(), http.MethodPost,
			"/portal/customers/"+c.CustomerID+"/consent-records", payload)
		if err != nil {
			respondPhoenixErr(w, r, err, "record consent")
			return
		}
		user := core.UserFromCtx(r.Context())
		phoenixLogWorkspaceAction(r.Context(), db, id, user.ID, "consent.recorded",
			"Consent captured over "+channel)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":`)) //nolint:errcheck
		w.Write(raw)                //nolint:errcheck
		w.Write([]byte(`}`))        //nolint:errcheck
	}
}

// ── small helpers ────────────────────────────────────────────────────────────

func splitName(full string) (string, string, bool) {
	parts := strings.Fields(strings.TrimSpace(full))
	if len(parts) < 2 {
		return "", "", false
	}
	return parts[0], strings.Join(parts[1:], " "), true
}

// maskAccount keeps the last four digits. Account numbers land in the activity
// trail, which is read far more widely than the application itself.
func maskAccount(v string) string {
	s := strings.TrimSpace(v)
	if len(s) <= 4 {
		return s
	}
	return strings.Repeat("•", len(s)-4) + s[len(s)-4:]
}

// ── Cards ────────────────────────────────────────────────────────────────────
//
// A card is the end of the journey for a revolving product: Phoenix issues it once
// the mandate is live, and from then on it can be frozen, unfrozen or cancelled.
// Those are customer-service actions, and the people who take them work in the
// workspace — so having them only in Phoenix meant a caller asking to freeze a card
// waited while someone opened another system.

// losCards lists the cards Phoenix holds for this applicant.
func losCards(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := losParseID(r)
		if err != nil {
			respondErr(w, 400, "Invalid application ID")
			return
		}
		c, err := phoenixLoadAppContext(r.Context(), db, id)
		if err != nil {
			respond(w, map[string]any{"cards": nil, "reason": err.Error()}, "phoenix")
			return
		}
		raw, err := phoenixCall(r.Context(), http.MethodGet, "/card-accounts?customer_id="+c.CustomerID, nil)
		if err != nil {
			respondPhoenixErr(w, r, err, "read the cards")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":{"cards":`)) //nolint:errcheck
		w.Write(raw)                         //nolint:errcheck
		w.Write([]byte(`}}`))                //nolint:errcheck
	}
}

// losCardAction performs one of Phoenix's per-card operations.
//
// A reason is required for freeze and cancel. Both restrict a customer's access to
// credit they have been granted, and "who froze this and why" is the first question
// asked when the customer rings back — a trail that cannot answer it is not worth
// keeping.
func losCardAction(db *core.DB, action string) http.HandlerFunc {
	type body struct {
		Reason string `json:"reason"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := losParseID(r)
		if err != nil {
			respondErr(w, 400, "Invalid application ID")
			return
		}
		cardID := strings.TrimSpace(chi.URLParam(r, "card_id"))
		if !phoenixUUID(cardID) {
			respondErr(w, 400, "card_id is not a Phoenix card id")
			return
		}
		var b body
		_ = json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck
		reason := strings.TrimSpace(b.Reason)
		if (action == "freeze" || action == "cancel") && reason == "" {
			respondErr(w, 422, "A reason is required to "+action+" a card")
			return
		}

		payload := map[string]any{}
		if reason != "" {
			payload["reason"] = reason
		}
		raw, err := phoenixCall(r.Context(), http.MethodPost, "/card-accounts/"+cardID+"/"+action, payload)
		if err != nil {
			respondPhoenixErr(w, r, err, action+" the card")
			return
		}
		label := map[string]string{
			"activate": "Card activated",
			"freeze":   "Card frozen",
			"unfreeze": "Card unfrozen",
			"cancel":   "Card cancelled",
		}[action]
		if reason != "" {
			label += " — " + reason
		}
		user := core.UserFromCtx(r.Context())
		phoenixLogWorkspaceAction(r.Context(), db, id, user.ID, "card."+action, label)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":`)) //nolint:errcheck
		w.Write(raw)                //nolint:errcheck
		w.Write([]byte(`}`))        //nolint:errcheck
	}
}

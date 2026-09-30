package handlers

// The consent register — where permission to contact a customer is recorded.
//
// WHY THIS FILE EXISTS. app.party_contact_consent has been read by four subsystems
// (audience resolution, arrears reminders, retention routing, customer dispatch) since
// the day it was created, and written by none of them. There was no endpoint, no
// screen, and no import: the only rows in it were 17,890 servicing rows inserted by a
// migration with basis 'inferred_active_product'. Marketing consent stood at zero rows
// on every channel, which is why the retention call queue resolved an audience of
// nobody and logged that it was empty "as a matter of law rather than of filtering".
//
// So the blocker was never the routing. It was that nothing in the building could
// record a yes.
//
// THE RULE THIS FILE ENFORCES, AND WHY IT IS NOT NEGOTIABLE. Marketing is opt-in
// (consentIsOptIn in audience.go). An opt-in regime where the opt-in can be created
// without saying where it came from is an opt-out regime with extra steps. So:
//
//	state='granted' AND purpose='marketing'  =>  basis and evidence are both REQUIRED.
//
// A withdrawal needs neither: someone saying stop is always allowed to say stop, and
// making them justify it is how you end up ignoring them. That asymmetry is the whole
// design.
//
// Nothing here sends anything. Recording consent is a prerequisite for contact, never
// an instruction to make it.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

// consentChannels are the channels a person can be contacted on. Mirrors the CHECK
// constraint on the table; 'voice' here is 'call' in AudienceSpec, which is a wart
// worth knowing about rather than papering over.
var consentChannels = map[string]bool{"sms": true, "email": true, "whatsapp": true, "voice": true}

var consentPurposes = map[string]bool{purposeServicing: true, purposeMarketing: true}

var consentStates = map[string]bool{"pending": true, "granted": true, "withdrawn": true}

// consentValidate checks one consent decision before it is written. It returns a
// message suitable for showing to the person who tried to record it, or "" if the
// decision is recordable.
//
// The evidence rule is deliberately strict about what counts. "Yes", "ok", "consent"
// and "granted" describe the decision, not its source, and a register full of those is
// a register that cannot answer the only question ever asked of it: who agreed, and
// where can I see them agreeing.
func consentValidate(partyID int64, channel, purpose, state, basis, evidence string) string {
	if partyID <= 0 {
		return "A customer must be named."
	}
	if !consentChannels[channel] {
		return "Channel must be one of sms, email, whatsapp or voice."
	}
	if !consentPurposes[purpose] {
		return "Purpose must be either servicing or marketing."
	}
	if !consentStates[state] {
		return "State must be pending, granted or withdrawn."
	}
	if state == "granted" && purpose == purposeMarketing {
		if strings.TrimSpace(basis) == "" {
			return "Marketing consent needs a basis: say how this customer gave it."
		}
		if len(strings.TrimSpace(evidence)) < 8 {
			return "Marketing consent needs evidence: name the form, call, or document it came from."
		}
		if consentEvidenceIsEmpty(evidence) {
			return "That evidence only restates the answer. Name where the agreement is recorded."
		}
	}
	return ""
}

// orDash keeps an empty basis or evidence legible in an activity line, where a blank
// reads as a rendering fault rather than as an absence.
func orDash(s string) string {
	if strings.TrimSpace(s) == "" {
		return "not stated"
	}
	return s
}

// consentEvidenceIsEmpty catches evidence that says a customer agreed without saying
// how anyone would check.
func consentEvidenceIsEmpty(evidence string) bool {
	e := strings.ToLower(strings.TrimSpace(strings.Trim(evidence, ".!\"' ")))
	switch e {
	case "yes", "ok", "okay", "consent", "consented", "granted", "agreed", "approved",
		"he agreed", "she agreed", "they agreed", "customer agreed", "customer consented",
		"n/a", "na", "none", "verbal", "confirmed":
		return true
	}
	return false
}

// consentCoverage answers the question every campaign starts with and few systems can
// answer honestly: how many people may we actually contact, and how many have simply
// never been asked. "Never asked" is reported as its own number rather than folded into
// a refusal, because the two call for completely different work.
func consentCoverage(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			WITH people AS (SELECT party_id FROM app.parties),
			grid AS (
			  SELECT p.party_id, pu.purpose, ch.channel
			    FROM people p
			    CROSS JOIN (VALUES ('servicing'),('marketing')) AS pu(purpose)
			    CROSS JOIN (VALUES ('email'),('sms'),('whatsapp'),('voice')) AS ch(channel)
			)
			SELECT g.purpose, g.channel,
			       COUNT(*) FILTER (WHERE c.state = 'granted'
			                          AND (c.expires_at IS NULL OR c.expires_at > NOW())) AS granted,
			       COUNT(*) FILTER (WHERE c.state = 'granted'
			                          AND c.expires_at IS NOT NULL AND c.expires_at <= NOW()) AS expired,
			       COUNT(*) FILTER (WHERE c.state = 'withdrawn')                            AS withdrawn,
			       COUNT(*) FILTER (WHERE c.state = 'pending')                              AS pending,
			       COUNT(*) FILTER (WHERE c.party_id IS NULL)                               AS never_asked,
			       COUNT(*)                                                                 AS population
			  FROM grid g
			  LEFT JOIN app.party_contact_consent c
			         ON c.party_id = g.party_id AND c.purpose = g.purpose AND c.channel = g.channel
			 GROUP BY g.purpose, g.channel
			 ORDER BY g.purpose, g.channel`)
		if err != nil {
			respondErr(w, 500, "Could not read the consent register")
			return
		}
		// The bases in use, so a reviewer can see what the register is actually built on
		// rather than trusting that 'granted' means somebody asked.
		bases, _ := db.PGQuery(r.Context(), `
			SELECT purpose, COALESCE(NULLIF(TRIM(basis),''),'(none recorded)') AS basis,
			       COUNT(*) AS rows_recorded, MIN(recorded_at) AS first_recorded,
			       MAX(recorded_at) AS last_recorded
			  FROM app.party_contact_consent
			 GROUP BY 1,2 ORDER BY 1, 3 DESC`)
		respond(w, map[string]any{"coverage": rows, "bases": bases}, "pg")
	}
}

// consentForParty is the individual record, for a customer asking what we hold.
func consentForParty(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		pid := toInt64(chi.URLParam(r, "party_id"))
		if pid <= 0 {
			respondErr(w, 400, "A customer must be named.")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT c.id, c.channel, c.purpose, c.state, c.basis, c.evidence,
			       c.recorded_at, c.expires_at, u.full_name AS recorded_by_name
			  FROM app.party_contact_consent c
			  LEFT JOIN app.o3c_users u ON u.id = c.recorded_by
			 WHERE c.party_id = $1
			 ORDER BY c.purpose, c.channel`, pid)
		if err != nil {
			respondErr(w, 500, "Could not read this customer's consent")
			return
		}
		respond(w, rows, "pg")
	}
}

// consentRecord writes one decision. Upserts on (party_id, channel, purpose), which is
// the table's own unique key: a person's answer on a channel is current or it is
// history, and the register holds the current one.
func consentRecord(db *core.DB) http.HandlerFunc {
	type body struct {
		PartyID  int64  `json:"party_id"`
		Channel  string `json:"channel"`
		Purpose  string `json:"purpose"`
		State    string `json:"state"`
		Basis    string `json:"basis"`
		Evidence string `json:"evidence"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		b.Channel = strings.ToLower(strings.TrimSpace(b.Channel))
		b.Purpose = strings.ToLower(strings.TrimSpace(b.Purpose))
		b.State = strings.ToLower(strings.TrimSpace(b.State))
		b.Basis = strings.TrimSpace(b.Basis)
		b.Evidence = strings.TrimSpace(b.Evidence)
		if msg := consentValidate(b.PartyID, b.Channel, b.Purpose, b.State, b.Basis, b.Evidence); msg != "" {
			respondErr(w, 422, msg)
			return
		}
		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO app.party_contact_consent
			       (party_id, channel, purpose, state, basis, evidence, recorded_by, recorded_at)
			VALUES ($1,$2,$3,$4,NULLIF($5,''),NULLIF($6,''),$7,NOW())
			ON CONFLICT (party_id, channel, purpose) DO UPDATE
			   SET state = EXCLUDED.state, basis = EXCLUDED.basis,
			       evidence = EXCLUDED.evidence, recorded_by = EXCLUDED.recorded_by,
			       recorded_at = NOW()
			RETURNING id, party_id, channel, purpose, state, basis, evidence, recorded_at`,
			b.PartyID, b.Channel, b.Purpose, b.State, b.Basis, b.Evidence, nullableInt64(user.ID))
		if err != nil {
			respondErr(w, 500, "Could not record this consent")
			return
		}
		aid, aname, ateam := actorOf(user)
		//nolint:errcheck // the consent is already recorded; a failed log must not undo it
		LogActivity(r.Context(), db, Activity{
			ActorUserID: aid, ActorName: aname, ActorTeam: ateam,
			Type: "note", Source: "manual",
			Subject: fmt.Sprintf("%s consent for %s set to %s", b.Purpose, b.Channel, b.State),
			Body: fmt.Sprintf("Basis: %s. Evidence: %s.",
				orDash(b.Basis), orDash(b.Evidence)),
			EntityType: "party_contact_consent",
			EntityID:   fmt.Sprintf("%d", b.PartyID),
		})
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

// consentImport records the same decision for many people at once, which is how a
// consent register is actually populated: a signed form campaign, a call-centre
// confirmation drive, a migration from a previous system.
//
// It takes ONE basis and ONE evidence string for the whole batch, deliberately. A bulk
// import where every row can carry its own justification is an import nobody reads. If
// these people did not all say yes in the same way, they belong in different batches.
func consentImport(db *core.DB) http.HandlerFunc {
	type body struct {
		PartyIDs []int64 `json:"party_ids"`
		Channel  string `json:"channel"`
		Purpose  string `json:"purpose"`
		State    string `json:"state"`
		Basis    string `json:"basis"`
		Evidence string `json:"evidence"`
		Confirm  string `json:"confirm"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		b.Channel = strings.ToLower(strings.TrimSpace(b.Channel))
		b.Purpose = strings.ToLower(strings.TrimSpace(b.Purpose))
		b.State = strings.ToLower(strings.TrimSpace(b.State))
		b.Basis = strings.TrimSpace(b.Basis)
		b.Evidence = strings.TrimSpace(b.Evidence)

		if len(b.PartyIDs) == 0 {
			respondErr(w, 422, "No customers were listed.")
			return
		}
		if len(b.PartyIDs) > 50000 {
			respondErr(w, 422, "That is more than 50,000 customers in one batch. Split it.")
			return
		}
		// Validate the decision once, against the first id, since every row shares it.
		if msg := consentValidate(b.PartyIDs[0], b.Channel, b.Purpose, b.State, b.Basis, b.Evidence); msg != "" {
			respondErr(w, 422, msg)
			return
		}
		// Recording that thousands of people agreed to marketing is a compliance act and
		// is not undone by an UPDATE. It gets the same deliberate friction as going live.
		if b.State == "granted" && b.Purpose == purposeMarketing &&
			strings.TrimSpace(b.Confirm) != "I HAVE THE EVIDENCE" {
			respondErr(w, 428, "To record marketing consent in bulk, confirm you hold the evidence.")
			return
		}
		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(), `
			WITH input AS (SELECT UNNEST($1::bigint[]) AS party_id),
			-- Only people who exist. A consent row for a party_id that is not a customer
			-- is not evidence of anything, and the FK would reject it one row at a time.
			valid AS (SELECT i.party_id FROM input i JOIN app.parties p USING (party_id))
			INSERT INTO app.party_contact_consent
			       (party_id, channel, purpose, state, basis, evidence, recorded_by, recorded_at)
			SELECT v.party_id, $2, $3, $4, NULLIF($5,''), NULLIF($6,''), $7, NOW()
			  FROM valid v
			ON CONFLICT (party_id, channel, purpose) DO UPDATE
			   SET state = EXCLUDED.state, basis = EXCLUDED.basis,
			       evidence = EXCLUDED.evidence, recorded_by = EXCLUDED.recorded_by,
			       recorded_at = NOW()
			RETURNING party_id`,
			b.PartyIDs, b.Channel, b.Purpose, b.State, b.Basis, b.Evidence, nullableInt64(user.ID))
		if err != nil {
			respondErr(w, 500, "Could not record this batch")
			return
		}
		recorded := int64(len(rows))
		skipped := int64(len(b.PartyIDs)) - recorded
		aid, aname, ateam := actorOf(user)
		//nolint:errcheck // the batch is already recorded; a failed log must not undo it
		LogActivity(r.Context(), db, Activity{
			ActorUserID: aid, ActorName: aname, ActorTeam: ateam,
			Type: "note", Source: "manual",
			Subject: fmt.Sprintf("%s consent for %s set to %s for %d customers",
				b.Purpose, b.Channel, b.State, recorded),
			Body: fmt.Sprintf("%d recorded, %d listed ids were not customers. Basis: %s. Evidence: %s.",
				recorded, skipped, orDash(b.Basis), orDash(b.Evidence)),
			EntityType: "party_contact_consent", EntityID: b.Purpose + ":" + b.Channel,
		})
		respond(w, map[string]any{
			"recorded":       recorded,
			"not_a_customer": skipped,
			"purpose":        b.Purpose,
			"channel":        b.Channel,
			"state":          b.State,
		}, "pg")
	}
}

// RegisterConsent mounts the register under /api/compliance.
//
// Reading is open to anyone who can see compliance; writing needs the head-level
// permission, because a consent row is the document that makes a marketing message
// lawful and it should be as hard to forge as it is to honour.
func RegisterConsent(r chi.Router, db *core.DB, read, write func(http.Handler) http.Handler) {
	r.With(read).Get("/consent/coverage", consentCoverage(db))
	r.With(read).Get("/consent/party/{party_id}", consentForParty(db))
	r.With(write).Post("/consent/record", consentRecord(db))
	r.With(write).Post("/consent/import", consentImport(db))
}
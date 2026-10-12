package handlers

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"

	"github.com/o3c/workspace/core"
)

// ─────────────────────────────────────────────────────────────────────────────
// Where a lead is — captured when it becomes interesting, carried to Sales.
//
// Sales plans its week geographically: a Lagos officer visits Lagos, an Abuja officer
// visits Abuja, and migration 353 maps every Nigerian state to one of those two offices.
// None of that works on a lead with no location, and on 2026-10-12 that was nearly all
// of them — city blank on 36,499 of 36,499 crm_contacts, state blank on 36,319.
//
// The cause was not the capture form. It was this: crmLinkLeadToContact creates the
// crm_contacts row Sales actually reads, and it never copied address, state or city off
// the call_center_leads row it was created from. An agent could type a state into the
// lead and Sales would still see nothing, because the two books are different tables and
// only name, phone, email and campaign lineage ever crossed between them. Migration 317
// had to reconstruct the state for the 185 leads already in Sales from their CAMPAIGN
// NAME for exactly this reason — the lead's own field was empty by the time it arrived.
//
// So there are three parts, and the middle one is the bug:
//   1. capture      — call_center_leads gains a city (353), and the create/update
//                     handlers accept it.
//   2. propagation   — linking or forwarding a lead copies its location onto the CRM
//                     contact. COALESCE-only: Sales may have corrected a state by hand
//                     and the call centre must never overwrite that.
//   3. the guard     — a lead cannot be marked Interested without a city and state.
//
// WHY THE GUARD IS HERE AND NOT ONLY IN THE FORM. Interested is the one disposition that
// qualifies a lead and hands it to Sales (see the qualification rule: a callback is not
// interest). It is also reachable from more than one screen, and the call-logging
// endpoint is shared with the Outbound Queue and the help desk. A rule enforced only in
// the Leads page would be silently skipped by every other caller, which is how the
// outbound queue came to produce "Interested" calls that never reached Sales at all.
// ─────────────────────────────────────────────────────────────────────────────

// dispositionInterested is the one disposition that qualifies a lead. Kept as a named
// constant so the guard and the stage machinery cannot drift apart over a typo.
const dispositionInterested = "answered_interested"

// leadLocationRequired reports whether this disposition is the qualifying one, and so
// demands a location. Takes the raw disposition the client sent and canonicalises it
// through the same helper the rest of the call path uses — the client sends labels
// ("Answered — Interested") as often as codes.
func leadLocationRequired(disposition string) bool {
	return ccDispositionCode(disposition) == dispositionInterested
}

// leadLocation is what the lead book knows about where someone is.
type leadLocation struct {
	City    string
	State   string
	Address string
}

func (l leadLocation) missing() []string {
	var out []string
	if strings.TrimSpace(l.City) == "" {
		out = append(out, "city")
	}
	if strings.TrimSpace(l.State) == "" {
		out = append(out, "state")
	}
	return out
}

// leadLocationFor reads the lead's own location, falling back to the CRM contact it is
// linked to. The fallback matters for the leads migration 317 backfilled: their state
// lives on the contact, not on the lead, so without it this guard would demand a state
// an agent can plainly see on screen.
func leadLocationFor(ctx context.Context, db *core.DB, leadID int64) leadLocation {
	rows, err := db.PGQuery(ctx, `
		SELECT COALESCE(NULLIF(btrim(l.city), ''),    NULLIF(btrim(c.city), ''),    '') AS city,
		       COALESCE(NULLIF(btrim(l.state), ''),   NULLIF(btrim(c.state), ''),   '') AS state,
		       COALESCE(NULLIF(btrim(l.address), ''), NULLIF(btrim(c.address), ''), '') AS address
		  FROM call_center_leads l
		  LEFT JOIN crm_contacts c ON c.id = l.contact_id
		 WHERE l.id = $1`, leadID)
	if err != nil || len(rows) == 0 {
		return leadLocation{}
	}
	return leadLocation{
		City:    str(rows[0]["city"]),
		State:   str(rows[0]["state"]),
		Address: str(rows[0]["address"]),
	}
}

// saveLeadLocation writes a location onto the lead and, when it is already linked, onto
// the CRM contact as well. Blank fields are left alone rather than blanked — the agent is
// supplying what they just learned on the call, not replacing the record.
func saveLeadLocation(ctx context.Context, db *core.DB, leadID int64, city, state, address string) {
	city, state, address = strings.TrimSpace(city), strings.TrimSpace(state), strings.TrimSpace(address)
	if city == "" && state == "" && address == "" {
		return
	}
	if _, err := db.PGExec(ctx, `
		UPDATE call_center_leads
		   SET city       = COALESCE(NULLIF($2, ''), city),
		       state      = COALESCE(NULLIF($3, ''), state),
		       address    = COALESCE(NULLIF($4, ''), address),
		       updated_at = NOW()
		 WHERE id = $1`, leadID, city, state, address); err != nil {
		slog.Error("saveLeadLocation: lead", "lead", leadID, "err", err)
		return
	}
	propagateLeadLocation(ctx, db, leadID)
}

// propagateLeadLocation copies a lead's location onto the CRM contact Sales reads.
//
// COALESCE in the contact's favour, in both directions of thinking: a value the contact
// already holds is never overwritten (Sales may have corrected it, and migration 317's
// campaign-derived states are deliberate), and a value only the lead holds is filled in.
// Safe to call repeatedly; it is called at link time, at forward time, and whenever an
// agent saves a location.
func propagateLeadLocation(ctx context.Context, db *core.DB, leadID int64) {
	if _, err := db.PGExec(ctx, `
		UPDATE crm_contacts c
		   SET city       = COALESCE(NULLIF(btrim(c.city), ''),    NULLIF(btrim(l.city), '')),
		       state      = COALESCE(NULLIF(btrim(c.state), ''),   NULLIF(btrim(l.state), '')),
		       address    = COALESCE(NULLIF(btrim(c.address), ''), NULLIF(btrim(l.address), '')),
		       updated_at = NOW()
		  FROM call_center_leads l
		 WHERE l.id = $1
		   AND c.id = l.contact_id`, leadID); err != nil {
		slog.Error("propagateLeadLocation", "lead", leadID, "err", err)
	}
}

// respondLeadLocationRequired is the 422 the Leads page turns into a prompt.
//
// A plain 400 would reach the agent as a red line of text they cannot act on. This
// carries a machine-readable error_code and the list of fields still missing, so the
// form can open the location prompt with exactly the right boxes focused and the
// agent's disposition still in hand — they fill in two fields and press save again,
// rather than losing the write-up.
func respondLeadLocationRequired(w http.ResponseWriter, missing []string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(422)
	json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
		"detail": "Add the lead's city and state before marking them Interested — " +
			"Sales plans visits off the location.",
		"error_code": "lead_location_required",
		"missing":    missing,
	})
}

// guardLeadLocation is the whole rule in one call, for the call-logging handler.
//
// Returns true when it has already written a response and the caller must stop. The
// supplied city/state are saved first, so an agent who sends them along with the
// disposition passes on the first attempt and nothing is lost.
func guardLeadLocation(ctx context.Context, db *core.DB, w http.ResponseWriter,
	leadID *int64, disposition, city, state, address string) bool {
	if leadID == nil || *leadID == 0 {
		return false
	}
	// Whatever the agent sent is worth keeping even on a disposition that does not
	// require it — a city learned during a callback is still a city.
	saveLeadLocation(ctx, db, *leadID, city, state, address)
	if !leadLocationRequired(disposition) {
		return false
	}
	if missing := leadLocationFor(ctx, db, *leadID).missing(); len(missing) > 0 {
		respondLeadLocationRequired(w, missing)
		return true
	}
	return false
}

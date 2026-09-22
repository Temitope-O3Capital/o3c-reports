package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

// ── Identity masking & reveal ────────────────────────────────────────────────
//
// The rule, as the business owner set it: every sensitive identity value is
// MASKED FOR EVERYONE by default; a click reveals the full value and writes an
// audit row naming who looked, at what, and when. Nobody is blocked from doing
// their job — a call-centre agent verifying a caller's date of birth still
// reveals it — but every reveal is on the record.
//
// Both halves are server-side, and that is the whole point:
//
//  1. c360IdentityGroups (customer360.go) never serialises a sensitive value.
//     It emits the MASK in c360IDField.Value. Masking in the browser would not
//     be masking at all — the full value would still sit in the JSON payload,
//     in devtools, in the HAR file and in any proxy log.
//
//  2. c360IdentityReveal below returns exactly ONE field, and only after the
//     audit row has been committed. If the audit write fails the reveal fails:
//     a value is never disclosed without a record of the disclosure.
//
// Keyed on party_id. app.customers.cif is a CARDS identifier and
// cbs_customer_id is Udara-only; those namespaces collide on real people, so an
// audit row keyed on either would frequently name the wrong customer.

// c360MaskChar is the single character every mask is built from, so a masked
// value is recognisable as masked at a glance anywhere on the page.
const c360MaskChar = "•"

// c360MaskTail decides how much of a sensitive value survives masking. Enough to
// confirm a value someone is reading back to you, never enough to disclose it:
//
//	>= 8 characters -> last 4   (BVN, NIN, TIN, ID and phone numbers)
//	6-7 characters  -> last 2   (a short value would otherwise be mostly given away)
//	<= 5 characters -> none
func c360MaskTail(n int) int {
	switch {
	case n >= 8:
		return 4
	case n >= 6:
		return 2
	}
	return 0
}

// c360MaskValue masks one sensitive field value for the list payload.
func c360MaskValue(key, v string) string {
	if v == "" {
		return v
	}
	if key == "date_of_birth" {
		return c360MaskDOB(v)
	}
	return c360MaskTailOnly(v)
}

// c360MaskTailOnly applies the generic rule: dots for everything but the tail.
func c360MaskTailOnly(v string) string {
	r := []rune(v)
	tail := c360MaskTail(len(r))
	return strings.Repeat(c360MaskChar, len(r)-tail) + string(r[len(r)-tail:])
}

// c360MaskDOB keeps the YEAR and hides the day and month: "19 Nov 1990" reads as
// "•• ••• 1990". The year alone is useful (age bracket, telling two namesakes
// apart) and is not the secret — the full date is what gets used as a
// verification answer, so the full date is what is withheld.
func c360MaskDOB(v string) string {
	parts := strings.Fields(v)
	if len(parts) == 3 && len(parts[2]) == 4 && c360AllDigits(parts[2]) {
		return "•• ••• " + parts[2]
	}
	// ISO 8601 (1990-11-19). /api/contacts/{key} serves the date in this shape, and the
	// generic tail rule is actively WRONG for it: the last 4 characters of "1990-11-19"
	// are "1-19", so it would hide the year — the harmless part — and disclose the day
	// and month, which are exactly the verification answer. Handled explicitly.
	if len(v) >= 10 && v[4] == '-' && v[7] == '-' && c360AllDigits(v[:4]) {
		return v[:4] + "-••-••"
	}
	// Unexpected format — fall back to the generic rule rather than risk
	// disclosing a date that happened to be formatted differently.
	return c360MaskTailOnly(v)
}

func c360AllDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// c360RevealLabels is the whitelist of revealable field keys -> label. It is
// derived from the single field declaration in c360IdentityLayout, so a field
// marked sensitive there becomes revealable here automatically and the two can
// never drift apart. "pep" is added by hand because the PEP determination travels
// beside the groups on the response rather than inside one.
var c360RevealLabels = func() map[string]string {
	m := map[string]string{"pep": "PEP Status"}
	for _, g := range c360IdentityLayout {
		for _, f := range g.fields {
			if f.sensitive {
				m[f.col] = f.label
			}
		}
	}
	return m
}()

// c360RevealSQL reads ONLY the sensitive columns, for the one PERSON behind the
// route key, collapsed across every app.customers row that person holds — the
// same blank-collapsing max(NULLIF(btrim(col), empty)) aggregation c360Identity
// uses, so a revealed value is always the value the masked row was built from.
//
// No column name is ever interpolated: the query is fixed, and the requested
// field picks a column out of the result map after the whitelist check above.
const c360RevealSQL = `
	WITH k AS (
	    SELECT party_id, contact_id
	      FROM app.customers
	     WHERE COALESCE(NULLIF(cif,''), contact_id) = $1
	     LIMIT 1
	)
	SELECT max(NULLIF(btrim(c.bvn),''))              AS bvn,
	       max(NULLIF(btrim(c.nin),''))              AS nin,
	       max(NULLIF(btrim(c.tin),''))              AS tin,
	       max(NULLIF(btrim(c.id_number),''))        AS id_number,
	       max(NULLIF(btrim(c.nok_phone),''))        AS nok_phone,
	       to_char(max(c.birthday),'DD Mon YYYY')    AS date_of_birth,
	       bool_or(COALESCE(c.pep,false))            AS pep,
	       count(*) FILTER (WHERE c.pep IS NOT NULL) AS pep_known,
	       max(k.party_id)                           AS party_id,
	       max(k.contact_id)                         AS contact_id
	  FROM app.customers c, k
	 WHERE (k.party_id IS NOT NULL AND c.party_id = k.party_id)
	    OR (k.party_id IS NULL AND c.contact_id = k.contact_id)`

// c360IdentityReveal discloses ONE sensitive identity field, after recording the
// disclosure. One field per call, never the whole record, so the audit trail says
// precisely what was seen rather than "someone opened the customer".
//
// Authorisation is the same page grant that opens the Identity block itself
// (RequirePages("customer360")) plus an authenticated actor — deliberately: the
// rule is "on the record", not "behind another door". A reveal nobody can perform
// is a reveal people work around.
func c360IdentityReveal(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		if user == nil {
			// Belt and braces: AuthMiddleware already rejects anonymous requests.
			// Without an actor there is nobody to name in the audit row, so there
			// is nobody to disclose to either.
			respondErr(w, 401, "Unauthorized")
			return
		}

		key := chi.URLParam(r, "cif")
		var body struct {
			Field string `json:"field"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
			respondErr(w, 400, "Invalid request body")
			return
		}
		field := strings.ToLower(strings.TrimSpace(body.Field))
		label, ok := c360RevealLabels[field]
		if !ok {
			respondErr(w, 400, "Not a revealable identity field")
			return
		}

		rows, err := db.PGQuery(ctx, c360RevealSQL, key)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		if len(rows) == 0 {
			respondErr(w, 404, "Customer not found")
			return
		}
		row := rows[0]

		partyID := strings.TrimSpace(rowStr(row["party_id"]))
		contactID := strings.TrimSpace(rowStr(row["contact_id"]))
		if partyID == "" && contactID == "" {
			respondErr(w, 404, "Customer not found")
			return
		}

		// The audit row keys on party_id — the workspace Customer ID, the only id
		// that means the same person everywhere. A customer with no party row yet
		// is keyed on its workspace contact_id and prefixed so the trail never
		// reads as though a party id were present.
		entityID := partyID
		if entityID == "" {
			entityID = "contact:" + contactID
		}

		var value string
		var pepFlag *bool
		if field == "pep" {
			// Tri-state: a determination that was never made is not a "no".
			if toInt64(row["pep_known"]) == 0 {
				respondErr(w, 404, "No PEP determination on record")
				return
			}
			b := toBool(row["pep"])
			pepFlag = &b
			value = "Not Politically Exposed"
			if b {
				value = "Politically Exposed Person"
			}
		} else {
			value = strings.TrimSpace(rowStr(row[field]))
			if value == "" {
				respondErr(w, 404, "No value on record for this field")
				return
			}
		}

		// THE RECORD COMES FIRST. If this write fails the reveal fails — the rule
		// is that no full value leaves the server without a row naming who looked,
		// so a broken audit path closes the door rather than quietly opening it.
		// (logCreditEvent, by contrast, is best-effort and swallows its error;
		// that is right for an activity feed and wrong here.)
		if err := c360AuditIdentityReveal(ctx, db, r, user, entityID, partyID, key, field, label); err != nil {
			respondErrLog(w, 500, "Reveal not recorded — value withheld", err)
			return
		}

		out := map[string]any{"key": field, "label": label, "value": value}
		if pepFlag != nil {
			out["pep"] = *pepFlag
		}
		respond(w, out, "pg")
	}
}

// c360AuditIdentityReveal writes the disclosure to app.audit_logs — the workspace's
// existing append-only compliance trail, already read by the Compliance > Audit
// Trail screen and already retained for five years under the CBN policy. A new
// table would only have been a second trail nobody reads.
//
// entity_type 'customer360' matches the page tag the audit middleware already
// writes for this module, so these rows land under the filter compliance uses;
// action 'identity_field_revealed' is what makes them findable as disclosures.
//
// The revealed VALUE is deliberately not stored. The trail records that a
// disclosure happened; it must not become a second copy of the BVN.
func c360AuditIdentityReveal(ctx context.Context, db *core.DB, r *http.Request, user *core.Claims,
	entityID, partyID, customerKey, field, label string) error {

	changes, err := json.Marshal(map[string]any{
		"surface":      "customer360.identity",
		"field":        field,
		"label":        label,
		"party_id":     partyID,
		"customer_key": customerKey,
		"value_stored": false,
	})
	if err != nil {
		return err
	}
	_, err = db.PGExec(ctx, `
		INSERT INTO audit_logs (actor_id, actor_role, actor_name, action, entity_type,
			entity_id, changes, ip_address, created_at)
		VALUES ($1,$2,$3,'identity_field_revealed','customer360',$4,$5,$6,NOW())`,
		user.ID, user.Role, user.FullName, entityID, string(changes), clientIP(r))
	return err
}

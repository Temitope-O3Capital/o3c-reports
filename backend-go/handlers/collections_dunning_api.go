package handlers

// The arrears-reminder review surface.
//
// WHY THIS EXISTS. The pipeline in collections_dunning.go resolves a real recipient,
// renders real copy, checks consent and suppression, and writes every attempt to
// app.dunning_sends — and none of that was visible anywhere. dunning_sends was
// referenced in exactly two places in the whole backend: the insert, and the throttle
// check. No endpoint, no page.
//
// So the first customer messaging this company has ever generated would have been
// reviewed by reading a shared mailbox, and the decision to start writing to borrowers
// about their debts would have been taken by editing a row in api_credentials by hand.
// That is a strange way to authorise a thing this consequential, and it leaves no record
// of who authorised it.
//
// This puts the evidence and the switch in the same place: what would be sent, to whom,
// on which channel, what was suppressed and why — and the go-live control next to it,
// requiring the elevated collections permission and writing an activity log entry.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

// RegisterCollectionsDunning mounts the review endpoints. Mounted inside
// RegisterCollections, so the "collections" page gate already applies; `head` is the
// elevated gate (collections_assign) used for the switch.
func RegisterCollectionsDunning(r chi.Router, db *core.DB, head func(http.Handler) http.Handler) {
	r.Get("/dunning/status", dunningStatus(db))
	r.Get("/dunning/sends", dunningSends(db))
	r.With(head).Post("/dunning/mode", dunningSetMode(db))
}

// dunningStatus is everything needed to judge whether this is safe to turn on: the mode,
// where previews are going, the policy thresholds actually in force, the worker's last
// word, and what the book looks like underneath.
func dunningStatus(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		out := map[string]any{
			"mode":  dunningMode(ctx, db),
			"inbox": resolveCredKey(ctx, db, "COLLECTIONS_DUNNING_INBOX"),
			"policy": map[string]any{
				"max_per_run":   dunningMaxPerRun(ctx, db),
				"min_kobo":      dunningMinKobo(ctx, db),
				"fresh_days":    dunningFreshDays(ctx, db),
				"max_dpd":       dunningMaxDPD(ctx, db),
				"throttle_days": dunningThrottleDays,
			},
		}
		// The worker's own last word, so the page does not have to infer whether the
		// nightly run happened from the absence of rows.
		if rows, _ := db.PGQuery(ctx, `
			SELECT status, detail, last_error, runs_total, last_ok_at, updated_at
			  FROM app.worker_heartbeats WHERE worker_key = 'collections_dunning'`); len(rows) > 0 {
			out["worker"] = rows[0]
		}
		// What the reminder would be chasing, under the thresholds above. Shown so the
		// reviewer can see the shape of the book, not just the five rows that ran.
		if rows, _ := db.PGQuery(ctx, `
			SELECT COUNT(*) AS facilities, COUNT(DISTINCT party_id) AS people,
			       COALESCE(SUM(outstanding_kobo),0) AS outstanding_kobo
			  FROM app.collections_delinquent_unified
			 WHERE dpd > 0 AND outstanding_kobo >= $1
			   AND ($2 = 0 OR dpd <= $2)`,
			dunningMinKobo(ctx, db), dunningMaxDPD(ctx, db)); len(rows) > 0 {
			out["eligible_book"] = rows[0]
		}
		// Everything below the materiality floor, so the floor's effect is visible
		// rather than silently applied.
		if rows, _ := db.PGQuery(ctx, `
			SELECT COUNT(*) AS facilities, COALESCE(SUM(outstanding_kobo),0) AS outstanding_kobo
			  FROM app.collections_delinquent_unified
			 WHERE dpd > 0 AND outstanding_kobo > 0 AND outstanding_kobo < $1`,
			dunningMinKobo(ctx, db)); len(rows) > 0 {
			out["below_floor"] = rows[0]
		}
		// Borrowers above the floor with no email and no phone. The run cannot reach
		// them and no longer spends its nightly cap trying, so this is the only place
		// their debt appears — and it is a work item, not a statistic: somebody has to
		// go and find a contact detail before any reminder can ever be written.
		if rows, _ := db.PGQuery(ctx, `
			SELECT COUNT(*) AS people, COALESCE(SUM(outstanding_kobo),0) AS outstanding_kobo
			  FROM (
				SELECT DISTINCT ON (COALESCE('p'||d.party_id::text, 'c'||d.key_cif))
				       d.outstanding_kobo,
				       COALESCE(NULLIF(v.email,''), NULLIF(c.email,'')) AS email,
				       COALESCE(NULLIF(v.phone,''), NULLIF(c.phone,'')) AS phone
				  FROM app.collections_delinquent_unified d
				  LEFT JOIN app.v_contact_identity v ON v.party_id = d.party_id
				  LEFT JOIN app.customers c ON d.arm = 'cards' AND c.cif = d.raw_cif
				 WHERE d.dpd > 0 AND d.outstanding_kobo >= $1
				   AND ($2 = 0 OR d.dpd <= $2)
				 ORDER BY COALESCE('p'||d.party_id::text, 'c'||d.key_cif), d.outstanding_kobo DESC
			  ) x
			 WHERE COALESCE(x.email,'') = '' AND COALESCE(x.phone,'') = ''`,
			dunningMinKobo(ctx, db), dunningMaxDPD(ctx, db)); len(rows) > 0 {
			out["unreachable"] = rows[0]
		}
		// Held back because somebody is already on the case. Split by status, because
		// the two are not the same decision: 'legal' is excluded because writing to a
		// borrower whose case is with solicitors is a risk nobody should be able to
		// switch on, and 'active' is excluded by a setting Collections owns.
		if rows, _ := db.PGQuery(ctx, `
			SELECT rc.status,
			       COUNT(DISTINCT d.key_cif) AS facilities,
			       COALESCE(SUM(DISTINCT d.outstanding_kobo),0) AS outstanding_kobo
			  FROM app.collections_delinquent_unified d
			  JOIN app.recovery_cases rc ON rc.party_id = d.party_id
			 WHERE d.dpd > 0 AND d.outstanding_kobo >= $1
			   AND ($2 = 0 OR d.dpd <= $2)
			   AND rc.status IN ('active','legal')
			 GROUP BY rc.status ORDER BY rc.status`,
			dunningMinKobo(ctx, db), dunningMaxDPD(ctx, db)); len(rows) > 0 {
			out["with_recovery"] = rows
		}
		out["skip_recovery"] = dunningSkipRecovery(ctx, db)
		respond(w, out, "pg")
	}
}

// dunningSends lists attempts, newest first. Every outcome is included — a suppressed
// or failed attempt is as much a part of the review as a rendered message.
func dunningSends(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		where, args := "WHERE 1=1", []any{}
		if v := strings.TrimSpace(qstr(r, "outcome")); v != "" {
			where += fmt.Sprintf(" AND outcome = $%d", len(args)+1)
			args = append(args, v)
		}
		if v := strings.TrimSpace(qstr(r, "channel")); v != "" {
			where += fmt.Sprintf(" AND channel = $%d", len(args)+1)
			args = append(args, v)
		}
		limit := qint(r, "limit", 200, 1, 1000)
		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT id, party_id, account_cif, facility, channel, dpd, dpd_bucket,
			       outstanding_kobo, recipient, subject, body, outcome, outcome_detail, sent_at
			  FROM app.dunning_sends %s
			 ORDER BY sent_at DESC, id DESC
			 LIMIT %d`, where, limit), args...)
		if err != nil {
			respondErrLog(w, 500, "Could not read the reminder log", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		// A per-outcome tally over the whole log, not just this page: "12 sent" is a
		// different statement from "12 on screen".
		totals, _ := db.PGQuery(r.Context(),
			`SELECT outcome, COUNT(*) AS n FROM app.dunning_sends GROUP BY outcome`)
		respond(w, map[string]any{"sends": rows, "totals": totals}, "pg")
	}
}

// dunningSetMode is the go-live switch.
//
// Two states only. Going live is the moment real borrowers start receiving written
// demands, so it requires the elevated collections permission, refuses without an
// explicit confirmation string, and records who did it — there was previously no trace
// of such a decision at all, because it was an UPDATE on api_credentials.
func dunningSetMode(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Mode    string `json:"mode"`
			Confirm string `json:"confirm"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		mode := strings.ToLower(strings.TrimSpace(body.Mode))
		if mode != "live" && mode != "staff_preview" {
			respondErr(w, 422, `Mode must be "live" or "staff_preview".`)
			return
		}
		// Typing the word is the point: this is not a toggle to flick past. Nobody
		// turns on messaging about debt by mis-clicking.
		if mode == "live" && !strings.EqualFold(strings.TrimSpace(body.Confirm), "SEND TO CUSTOMERS") {
			respondErr(w, 422,
				`Going live means real borrowers receive these messages. Type "SEND TO CUSTOMERS" to confirm.`)
			return
		}
		if mode == "live" {
			// Refuse to go live with nothing reviewed. The whole design is that a batch
			// is read before a customer receives one, and an empty log means no batch
			// has ever been produced.
			if rows, _ := db.PGQuery(r.Context(),
				`SELECT COUNT(*) AS n FROM app.dunning_sends WHERE outcome = 'staff_preview'`); len(rows) > 0 &&
				toInt64(rows[0]["n"]) == 0 {
				respondErr(w, 409,
					"No preview has ever been produced, so there is nothing to have reviewed. "+
						"Let the nightly run generate a batch first.")
				return
			}
		}
		if _, err := db.PGExec(r.Context(), `
			INSERT INTO app.api_credentials (key_name, encrypted_value, description, category,
			                                 is_active, is_secret, updated_at)
			VALUES ('COLLECTIONS_DUNNING_MODE', $1,
			        'staff_preview delivers rendered reminders to the staff inbox; live sends them to borrowers.',
			        'messaging', true, false, NOW())
			ON CONFLICT (key_name) DO UPDATE
			  SET encrypted_value = EXCLUDED.encrypted_value, is_active = true, updated_at = NOW()`,
			mode); err != nil {
			respondErrLog(w, 500, "Could not change the mode", err)
			return
		}
		u := core.UserFromCtx(r.Context())
		aid, aname, ateam := actorOf(u)
		//nolint:errcheck // the mode change already succeeded; a failed log must not undo it
		LogActivity(r.Context(), db, Activity{
			ActorUserID: aid, ActorName: aname, ActorTeam: ateam,
			Type: "note", Source: "manual",
			Subject: "Arrears reminders set to " + mode,
			Body: fmt.Sprintf("Collections arrears reminders switched to %q. "+
				"In staff_preview, rendered messages go to the staff inbox; in live they go to borrowers.", mode),
			EntityType: "collections_dunning", EntityID: mode,
		})
		respond(w, map[string]any{"ok": true, "mode": mode}, "pg")
	}
}

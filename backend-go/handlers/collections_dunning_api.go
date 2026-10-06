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
	"context"
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
		out["channels"] = dunningChannelReadiness(ctx, db)
		out["coverage"] = dunningTemplateCoverage(ctx, db)
		respond(w, out, "pg")
	}
}

// dunningTemplateCoverage answers, bucket by bucket, "who would this wording actually
// reach, and has it ever been seen?".
//
// WHY. Six templates were written, one per DPD band, the oldest three carrying the
// firmest language in the system — recovery referral, and for 360+ the solicitors. Three
// of them cannot fire. On 2026-10-06 the 91-180 band held 56 delinquent facilities of
// which 55 were already with recovery, 181-360 held 4 of which 4 were, and 360+ held 401
// of which 401 were. So the strongest letters this company has ever drafted have never
// rendered once, not even to the staff inbox, and nobody had reviewed them in situ
// because there was no way to notice.
//
// That matters twice over. Unreviewed copy is the smaller half. The larger half is that
// COLLECTIONS_DUNNING_SKIP_RECOVERY=off releases exactly those held rows into exactly
// those templates — around 460 borrowers whose cases are already being worked, some with
// solicitors instructed, would begin receiving automated demands inviting them to ring in
// and arrange repayment. The setting reads like a filter. It is closer to a floodgate,
// and the page should say so before anyone touches it rather than after.
//
// The candidate shape here deliberately mirrors batchDunningRun: one row per PERSON
// (DISTINCT ON the namespaced key, highest balance first), the same materiality floor and
// age bound, the same recovery exclusion with 'legal' unconditional, and reachability
// counted the way the run counts it. A coverage figure derived from a different
// population would be worse than none, because it would be believed.
func dunningTemplateCoverage(ctx context.Context, db *core.DB) map[string]any {
	tplRows, err := db.PGQuery(ctx, `
		SELECT id, name FROM app.message_templates
		 WHERE category = 'collections' ORDER BY id`)
	if err != nil || len(tplRows) == 0 {
		return nil
	}

	bucketRows, err := db.PGQuery(ctx, `
		WITH cand AS (
		  SELECT DISTINCT ON (COALESCE('p'||d.party_id::text, 'c'||d.key_cif))
		         d.dpd_bucket, d.dpd, d.outstanding_kobo,
		         COALESCE(NULLIF(v.email,''), NULLIF(c.email,'')) AS email,
		         COALESCE(NULLIF(v.phone,''), NULLIF(c.phone,'')) AS phone,
		         -- Kept apart because they are two different decisions. 'legal' is held no
		         -- matter what any setting says; 'active' is held only while SKIP_RECOVERY
		         -- is on, which is what makes eligible_if_off below answerable.
		         EXISTS (SELECT 1 FROM app.recovery_cases rc
		                  WHERE rc.party_id = d.party_id AND rc.status = 'legal') AS legal_held,
		         EXISTS (SELECT 1 FROM app.recovery_cases rc
		                  WHERE rc.party_id = d.party_id AND rc.status = 'active') AS active_held
		    FROM app.collections_delinquent_unified d
		    LEFT JOIN app.v_contact_identity v ON v.party_id = d.party_id
		    LEFT JOIN app.customers c ON d.arm = 'cards' AND c.cif = d.raw_cif
		   WHERE d.dpd > 0 AND d.outstanding_kobo >= $1 AND ($2 = 0 OR d.dpd <= $2)
		   ORDER BY COALESCE('p'||d.party_id::text, 'c'||d.key_cif), d.outstanding_kobo DESC
		), m AS (
		  SELECT *,
		         (COALESCE(email,'') <> '' OR COALESCE(phone,'') <> '') AS reachable,
		         (legal_held OR ($3 AND active_held))                   AS held
		    FROM cand
		)
		SELECT dpd_bucket,
		       COUNT(*)                                               AS people,
		       COUNT(*) FILTER (WHERE held)                            AS held_recovery,
		       COALESCE(SUM(outstanding_kobo) FILTER (WHERE held), 0)  AS held_kobo,
		       COUNT(*) FILTER (WHERE NOT held AND reachable)          AS eligible,
		       COUNT(*) FILTER (WHERE NOT held AND NOT reachable)      AS unreachable,
		       -- Per CHANNEL, not per person, because choosing the first live channel is a
		       -- decision and "reachable" does not answer it. A borrower with a phone and
		       -- no email counts as reachable and is still invisible to an email-only run.
		       COUNT(*) FILTER (WHERE NOT held AND COALESCE(email,'') <> '') AS can_email,
		       COUNT(*) FILTER (WHERE NOT held AND COALESCE(phone,'') <> '') AS can_sms,
		       -- What SKIP_RECOVERY=off would make reachable by this wording. Independent
		       -- of the current setting on purpose: the page has to be able to state the
		       -- consequence of flipping it BEFORE it is flipped.
		       COUNT(*) FILTER (WHERE NOT legal_held AND reachable)    AS eligible_if_off
		  FROM m
		 GROUP BY dpd_bucket
		 ORDER BY MIN(dpd)`,
		dunningMinKobo(ctx, db), dunningMaxDPD(ctx, db), dunningSkipRecovery(ctx, db))
	if err != nil {
		return nil
	}

	// What has actually been produced, per bucket, so "never rendered" is a fact from
	// the log rather than an inference from the population.
	rendered := map[string]int64{}
	if rows, _ := db.PGQuery(ctx, `
		SELECT dpd_bucket, COUNT(*) AS n FROM app.dunning_sends
		 WHERE outcome IN ('sent','staff_preview') GROUP BY dpd_bucket`); rows != nil {
		for _, r := range rows {
			rendered[str(r["dpd_bucket"])] = toInt64(r["n"])
		}
	}

	used := map[int64]bool{}
	buckets := make([]map[string]any, 0, len(bucketRows))
	for _, b := range bucketRows {
		bucket := str(b["dpd_bucket"])
		tpl := dunningTemplateFor(tplRows, bucket)
		tplID := toInt64(tpl["id"])
		used[tplID] = true
		buckets = append(buckets, map[string]any{
			"bucket":        bucket,
			"people":        toInt64(b["people"]),
			"held_recovery": toInt64(b["held_recovery"]),
			"held_kobo":     toInt64(b["held_kobo"]),
			"eligible":        toInt64(b["eligible"]),
			"eligible_if_off": toInt64(b["eligible_if_off"]),
			"unreachable":     toInt64(b["unreachable"]),
			"can_email":       toInt64(b["can_email"]),
			"can_sms":         toInt64(b["can_sms"]),
			"rendered":        rendered[bucket],
			"template_id":     tplID,
			"template_name":   str(tpl["name"]),
			// False means this bucket has no template of its own and is borrowing the
			// lowest-numbered one — the 1-30 wording on a debt of any age.
			"template_matches": dunningTemplateMatches(str(tpl["name"]), bucket),
		})
	}

	// A template no bucket maps to. Distinct from one whose bucket exists but is empty:
	// this wording cannot be reached by any debt currently on the book at all.
	orphans := make([]map[string]any, 0)
	for _, t := range tplRows {
		if id := toInt64(t["id"]); !used[id] {
			orphans = append(orphans, map[string]any{"id": id, "name": str(t["name"])})
		}
	}
	return map[string]any{"buckets": buckets, "templates_unreachable": orphans}
}

// dunningChannelReadiness answers "if this went live tonight, would it actually leave
// the building" for each channel, and names the missing piece when it would not.
//
// This exists because the answer was not knowable from the app. On 2026-09-30 the
// credentials table showed TERMII_API_KEY and SENDGRID_API_KEY both EMPTY, which looked
// like neither channel worked — but resolveCredKey reads the environment first and
// backend-go/.env holds both, so email had in fact been delivering for months and SMS
// was one setting away. Meanwhile WhatsApp genuinely had nothing, on any channel,
// anywhere. Three different states, all presenting identically as a blank row.
//
// Configuration only: no call leaves the process here, so opening this page cannot cost
// money or hang on a provider. A funded balance and an approved sender ID are separate
// facts, and the Termii status endpoint is where those live.
func dunningChannelReadiness(ctx context.Context, db *core.DB) []map[string]any {
	type chk struct {
		channel string
		ready   bool
		sender  string
		reason  string
	}
	var out []chk

	sgKey := resolveCredKey(ctx, db, "SENDGRID_API_KEY")
	from := coalesce(resolveCredKey(ctx, db, "EMAIL_FROM_ADDRESS"), resolveCredKey(ctx, db, "SENDGRID_FROM_EMAIL"))
	switch {
	case sgKey == "":
		out = append(out, chk{"email", false, "", "No SendGrid API key. Set SENDGRID_API_KEY."})
	case from == "":
		out = append(out, chk{"email", false, "", "No sender address. Set EMAIL_FROM_ADDRESS."})
	default:
		out = append(out, chk{"email", true, from, "SendGrid is configured and has delivered."})
	}

	termii := resolveCredKey(ctx, db, "TERMII_API_KEY")
	sender := coalesce(resolveCredKey(ctx, db, "TERMII_SENDER_ID"), termiiSenderID)
	switch {
	case termii == "":
		out = append(out, chk{"sms", false, "", "No Termii API key. Set TERMII_API_KEY."})
	case sender == "":
		out = append(out, chk{"sms", false, "", "No sender name. Set TERMII_SENDER_ID."})
	default:
		out = append(out, chk{"sms", true, sender,
			"Termii is configured. Check the balance and that this sender name is approved."})
	}

	waToken := resolveCredKey(ctx, db, "WHATSAPP_ACCESS_TOKEN")
	waPhone := resolveCredKey(ctx, db, "WHATSAPP_PHONE_NUMBER_ID")
	switch {
	case waToken == "" && waPhone == "":
		out = append(out, chk{"whatsapp", false, "",
			"No WhatsApp credentials at all. Needs a Meta Business number before anything can be sent."})
	case waToken == "":
		out = append(out, chk{"whatsapp", false, waPhone, "No access token. Set WHATSAPP_ACCESS_TOKEN."})
	case waPhone == "":
		out = append(out, chk{"whatsapp", false, "", "No phone number id. Set WHATSAPP_PHONE_NUMBER_ID."})
	default:
		out = append(out, chk{"whatsapp", true, waPhone, "WhatsApp is configured."})
	}

	rows := make([]map[string]any, 0, len(out))
	for _, c := range out {
		rows = append(rows, map[string]any{
			"channel": c.channel, "ready": c.ready, "sender": c.sender, "reason": c.reason,
		})
	}
	return rows
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

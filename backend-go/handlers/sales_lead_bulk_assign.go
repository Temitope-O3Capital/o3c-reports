package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/o3c/workspace/core"
)

// ─────────────────────────────────────────────────────────────────────────────
// Pick several leads, give them to one person.
//
// The other half of what a head does with a team's share. Distribute spreads a pool
// across everyone; this is the deliberate opposite — "these eleven are all in Ikeja, give
// them to Blessing" — and it was the gap in between. The only way to do it was the
// per-row Assign button, one lead and one dialog at a time, so a head moving a dozen
// leads did twelve dialogs or gave up and left them where they were.
//
// PERMISSIONS ARE transferLead'S, not a new set. A head or management may move any open
// lead; anyone else may move only leads they own. The recipient must be someone the
// caller is allowed to deal to, which for a team head is their own team - the same rule
// distributeLeads applies, so the two routes cannot drift into disagreeing about who may
// receive work.
//
// One transaction for the batch: a partial bulk assign is the worst outcome, because the
// head cannot see which half went and re-running moves the ones that already moved.
// ─────────────────────────────────────────────────────────────────────────────

func bulkAssignLeads(db *core.DB) http.HandlerFunc {
	type body struct {
		LeadIDs   []int64 `json:"lead_ids"`
		OfficerID int64   `json:"officer_id"`
		Note      string  `json:"note"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil || user.ID == 0 {
			respondErr(w, 401, "Not authenticated")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.OfficerID <= 0 {
			respondErr(w, 400, "Choose the officer to assign these leads to")
			return
		}
		if len(b.LeadIDs) == 0 {
			respondErr(w, 400, "Select at least one lead")
			return
		}
		// A cap, because the whole batch is one statement and one notification. Nobody
		// hand-picks more than this; a head wanting to move everything wants Distribute.
		if len(b.LeadIDs) > 500 {
			respondErr(w, 400, "Too many leads in one assignment (max 500) — use Distribute instead")
			return
		}

		// The recipient has to be real and active, for transferLead's reason: a typo'd id
		// parks the leads on nobody, and because it is not NULL they leave every queue
		// AND stay out of the unowned pool.
		var recipient string
		if err := db.PG.QueryRowContext(r.Context(),
			`SELECT full_name FROM o3c_users WHERE id=$1 AND deleted_at IS NULL AND is_active`,
			b.OfficerID).Scan(&recipient); err != nil {
			respondErr(w, 400, "That officer is not an active user")
			return
		}

		// A head deals to their own team and no further. Management deals to anyone.
		if mode, teamIDs := salesLeadScope(r, db, user); mode == scopeTeam {
			allowed := false
			for _, id := range teamIDs {
				if id == b.OfficerID {
					allowed = true
					break
				}
			}
			if !allowed {
				respondErr(w, 403, "You can only assign leads to officers on your own team")
				return
			}
		}

		isHead := core.IsManagement(user.Role) || isSalesHead(user)

		tx, err := db.PG.BeginTx(r.Context(), nil)
		if err != nil {
			respondErr(w, 500, "Could not start transaction")
			return
		}
		defer tx.Rollback() //nolint:errcheck

		// Every gate transferLead applies to one lead, applied to the set in one
		// statement: it has to have reached Sales, it has to still be open, it must not
		// already be theirs, and unless the caller is a head it has to be the caller's.
		//
		// RETURNING tells us which ones actually moved, so the response can say "9 of the
		// 11 you picked" rather than claiming all eleven and leaving the head to notice
		// later that two were already converted.
		rows, err := tx.QueryContext(r.Context(), `
			UPDATE crm_contacts c
			   SET sales_owner_id   = $2,
			       last_activity_at = NOW(),
			       updated_at       = NOW()
			 WHERE c.id = ANY($1::bigint[])
			   AND c.sales_entered_at IS NOT NULL
			   AND c.lead_stage NOT IN ('converted', 'disqualified')
			   AND c.sales_owner_id IS DISTINCT FROM $2
			   AND ($3::boolean OR c.sales_owner_id = $4)
			RETURNING c.id, COALESCE(c.sales_owner_id, 0)`,
			int64Array(b.LeadIDs), b.OfficerID, isHead, user.ID)
		if err != nil {
			respondErrLog(w, 500, "Could not assign those leads", err)
			return
		}
		moved := []int64{}
		for rows.Next() {
			var id, newOwner int64
			if err := rows.Scan(&id, &newOwner); err != nil {
				rows.Close()
				respondErrLog(w, 500, "Could not read the assignment result", err)
				return
			}
			moved = append(moved, id)
		}
		rows.Close()

		if len(moved) == 0 {
			// Not an error: every lead picked was already theirs, already closed, or not
			// the caller's to move. Saying so is more use than a 400.
			respond(w, map[string]any{
				"assigned": 0, "requested": len(b.LeadIDs), "officer": recipient,
				"note": "None of those leads could be assigned — they are already with that officer, closed, or not yours to move.",
			}, "pg")
			return
		}

		note := "Assigned by " + user.FullName
		if b.Note != "" {
			note += ": " + b.Note
		}
		if _, err := tx.ExecContext(r.Context(), `
			INSERT INTO crm_lead_events (contact_id, event, to_owner, note, created_by)
			SELECT unnest($1::bigint[]), 'assigned', $2, $3, $4`,
			int64Array(moved), b.OfficerID, note, user.ID); err != nil {
			respondErrLog(w, 500, "Could not record the assignment", err)
			return
		}
		if err := tx.Commit(); err != nil {
			respondErrLog(w, 500, "Could not save the assignment", err)
			return
		}

		// Same alert the pool distribution sends, so a lead arriving by hand-pick and a
		// lead arriving by Distribute reach the officer the same way.
		notifyLeadsAssigned(context.WithoutCancel(r.Context()), db,
			map[int64]int{b.OfficerID: len(moved)})

		respond(w, map[string]any{
			"assigned":  len(moved),
			"requested": len(b.LeadIDs),
			"officer":   recipient,
			"message":   fmt.Sprintf("%d lead(s) assigned to %s", len(moved), recipient),
		}, "pg")
	}
}

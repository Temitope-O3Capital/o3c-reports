package handlers

import (
	"context"

	"github.com/o3c/workspace/core"
)

// ─────────────────────────────────────────────────────────────────────────────
// A forwarded lead reaches a TEAM, and the team's head decides who works it.
//
// There are four teams: Team Jennifer and Team IK in Lagos, Team Ozioma and Team
// Ikechukwu Okoro in Abuja. The hand-off is two steps, not one — the lead is shared
// evenly between the two teams that cover its state, and then the head of the team that
// got it either deals it round their own officers or picks someone for it. Ten Lagos
// leads forwarded is five to each Lagos team.
//
// WHAT IT USED TO DO. Nothing: recordCallHandoff set sales_entered_at and left
// sales_owner_id NULL, so every automatically forwarded lead landed in one undifferentiated
// pool belonging to nobody. Migration 317 dealt that pool to the heads once, by hand, and
// said the allocation within a team "belongs to them and not to this migration" — but no
// code ever put a NEW lead on a team, so the pool simply refilled behind it.
//
// WHY BALANCE ON THE TEAM'S BOOK rather than keeping a rotation counter. A counter in a
// table is one more thing to be wrong after a restart, a replay or a manual insert, and it
// cannot answer "are the two teams actually even?" — it only knows who it handed to last.
// Ordering by how much each team is currently carrying is self-correcting: if one team is
// behind for any reason at all, including reasons this code never saw, the next leads go
// there until they are level.
//
// There is no team column on crm_contacts, so "the team holds it" is expressed the way
// migration 317 expressed it — sales_owner_id is the head. Everything downstream already
// reads that: the head's own queue, include_mine on Distribute, and the alert that tells
// them a lead arrived.
// ─────────────────────────────────────────────────────────────────────────────

// routeHandoffToTeam puts a newly forwarded lead on whichever of its hub's teams is
// carrying least, and returns the head who now holds it (0 if it could not be routed).
//
// One statement, so two calls racing cannot both read the same "lightest" team and both
// deal to it. Only ever fills a NULL owner: a supervisor who picked a sales owner when
// they forwarded has already made this decision, and re-running must not overturn an
// allocation a head has since made.
//
// A lead whose state does not resolve to a hub is left unowned on purpose. It stays in the
// pool and is reported there as unroutable, which is a number a head can act on; guessing
// an office for it would send someone in Lagos to visit Kano.
func routeHandoffToTeam(ctx context.Context, db *core.DB, contactID int64) int64 {
	if contactID == 0 {
		return 0
	}
	rows, err := db.PGQuery(ctx, `
		UPDATE app.crm_contacts c
		   SET sales_owner_id = (
		         SELECT t.head_user_id
		           FROM app.sales_teams t
		           JOIN app.o3c_users u ON u.id = t.head_user_id
		          WHERE t.is_active
		            AND u.is_active
		            AND u.deleted_at IS NULL
		            AND app.sales_hub_for_office(u.office_location)
		                = app.sales_hub_for_state(c.state)
		          -- The team's whole live book: the head plus every member. Balancing on
		          -- the head alone would send everything to whichever head had just
		          -- finished dealing theirs out, because dealing empties their own count.
		          ORDER BY (
		                     SELECT COUNT(*)
		                       FROM app.crm_contacts x
		                      WHERE x.lead_stage NOT IN ('converted', 'disqualified')
		                        AND (x.sales_owner_id = t.head_user_id
		                          OR x.sales_owner_id IN (SELECT m.user_id
		                                                    FROM app.sales_team_members m
		                                                   WHERE m.team_id = t.id))
		                   ) ASC,
		                   t.head_user_id ASC
		          LIMIT 1),
		       updated_at = NOW()
		 WHERE c.id = $1
		   AND c.sales_owner_id IS NULL
		   AND app.sales_hub_for_state(c.state) IS NOT NULL
		RETURNING sales_owner_id`, contactID)
	if err != nil || len(rows) == 0 {
		return 0
	}
	return toInt64(rows[0]["sales_owner_id"])
}

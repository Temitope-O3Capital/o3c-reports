package handlers

import (
	"context"
	"log/slog"

	"github.com/o3c/workspace/core"
)

// ─────────────────────────────────────────────────────────────────────────────
// A forwarded lead reaches a TEAM, and the team's head decides who works it.
//
// There are four teams: Team Jennifer and Team IK in Lagos, Team Ozioma and Team
// Ikechukwu Okoro in Abuja. The hand-off is two steps, not one — the lead is shared
// evenly between the two teams that cover its state, and then the head of the team that
// got it either deals it round their own officers, takes a share themselves, or picks
// leads and hands the batch to one person. Ten Lagos leads forwarded is five to each
// Lagos team.
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
//
// IT IS RECORDED IN FOUR PLACES, because a routing decision nobody can see afterwards is
// how the last one went unnoticed for three weeks:
//
//	crm_contacts            who holds it now (the queue, the alert, every Sales screen)
//	call_center_lead_forwards  the hand-off ledger, so the call centre's own tracker names
//	                        the team rather than reading "Unassigned" at a glance
//	crm_lead_events         the lead's timeline — which team, when, and that it was the
//	                        router and not a person
//	app.activities          the shared stream behind Customer 360 and the hand-off inbox
// ─────────────────────────────────────────────────────────────────────────────

// routeHandoffToTeam puts a newly forwarded lead on whichever of its hub's teams is
// carrying least, and returns the head who now holds it (0 if it could not be routed).
//
// The decision is ONE statement, so two calls racing cannot both read the same "lightest"
// team and both deal to it. Only ever fills a NULL owner: a supervisor who picked a sales
// owner when they forwarded has already made this decision, and re-running must not
// overturn an allocation a head has since made.
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
		            -- THE CASE THIS WAS ADDED FOR. A head who is away was still the
		            -- least-busy head -- being away is precisely what keeps your book
		            -- small -- so the balancing actively PREFERRED them. One Lagos head
		            -- accumulated 21 accepted-but-unworked forwards averaging 3.4 days
		            -- against a four-hour pickup promise. Nobody chooses here, so there
		            -- is nobody to warn: the only correct behaviour is to skip them.
		            AND NOT app.is_unavailable(u.id)
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
	if err != nil {
		slog.Error("routeHandoffToTeam: could not route the hand-off", "contact", contactID, "err", err)
		return 0
	}
	if len(rows) == 0 {
		// Already owned, or no routable state. Being owned is ordinary; having no state is
		// not, and it is the case that hides - the lead sits in the pool belonging to
		// nobody and looks exactly like a quiet afternoon. Tell the floor that can fix it.
		if unroutable, uerr := db.PGQuery(ctx, `
			SELECT btrim(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')) AS name
			  FROM app.crm_contacts
			 WHERE id = $1
			   AND sales_owner_id IS NULL
			   AND app.sales_hub_for_state(state) IS NULL`, contactID); uerr == nil && len(unroutable) > 0 {
			name := str(unroutable[0]["name"])
			if name == "" {
				name = "A qualified lead"
			}
			go notifyLeadHasNoLocation(context.WithoutCancel(ctx), db, contactID, name)
		}
		return 0
	}
	head := toInt64(rows[0]["sales_owner_id"])
	if head == 0 {
		// The contact matched but no team covers its hub — nobody in that office, or
		// neither team is active. Worth a line in the log: it means leads for a whole
		// city are piling up unowned, which looks identical to "quiet week" on screen.
		slog.Warn("routeHandoffToTeam: no active team covers this lead's state",
			"contact", contactID)
		return 0
	}

	// The team's name, for the records below. A second read rather than part of the
	// statement above, because the UPDATE is the atomic decision and this is only how
	// the decision gets described.
	teamName, headName := "", ""
	if info, ierr := db.PGQuery(ctx, `
		SELECT t.name AS team, u.full_name AS head
		  FROM app.sales_teams t
		  JOIN app.o3c_users u ON u.id = t.head_user_id
		 WHERE t.head_user_id = $1 AND t.is_active
		 LIMIT 1`, head); ierr == nil && len(info) > 0 {
		teamName, headName = str(info[0]["team"]), str(info[0]["head"])
	}
	if teamName == "" {
		teamName = "their team"
	}
	if headName == "" {
		headName = "the team head"
	}

	recordTeamRouting(ctx, db, contactID, head, teamName, headName)
	return head
}

// recordTeamRouting writes the decision everywhere it has to be visible.
//
// Deliberately best-effort and logged rather than fatal: the lead is already on the right
// team by the time this runs, and losing the audit line is a smaller harm than unwinding a
// correct allocation because a timeline insert failed.
func recordTeamRouting(ctx context.Context, db *core.DB, contactID, head int64, teamName, headName string) {
	// 1. The hand-off ledger. Without this the call centre's own tracker had to infer the
	//    owner from the contact row, and its stored copy — the one every export and
	//    report reads — stayed NULL for ever.
	if _, err := db.PGExec(ctx, `
		UPDATE call_center_lead_forwards
		   SET sales_owner_id   = COALESCE(sales_owner_id, $2),
		       sales_owner_name = COALESCE(sales_owner_name,
		                                   (SELECT full_name FROM o3c_users WHERE id = $2)),
		       status           = CASE WHEN status = 'forwarded' THEN 'assigned' ELSE status END,
		       updated_at       = NOW()
		 WHERE contact_id = $1
		   AND resolved_at IS NULL`, contactID, head); err != nil {
		slog.Error("recordTeamRouting: ledger", "contact", contactID, "err", err)
	}

	// 2. The lead's own timeline. created_by is NULL on purpose: no person chose this, and
	//    attributing it to the agent who happened to log the call would be a lie the
	//    timeline then tells for ever.
	note := "Shared to " + teamName + " (" + headName + ") — the two teams covering this state take turns"
	if _, err := db.PGExec(ctx, `
		INSERT INTO crm_lead_events (contact_id, event, to_owner, note, created_by)
		VALUES ($1, 'assigned', $2, $3, NULL)`, contactID, head, note); err != nil {
		slog.Error("recordTeamRouting: timeline", "contact", contactID, "err", err)
	}

	// 3. The shared activity stream — Customer 360, the hand-off inbox and the step
	//    history all read this, and none of them would otherwise show how the lead got
	//    to whoever is now working it.
	if _, err := LogActivity(ctx, db, Activity{
		ContactID:    &contactID,
		Type:         "handoff",
		Direction:    "internal",
		Subject:      "Shared to " + teamName,
		Body:         note,
		TargetTeam:   teamName,
		TargetUserID: &head,
		ActorName:    "Lead router",
		// call_center, not call_centre: 14,818 rows already use that spelling and a second
		// one would quietly split every GROUP BY source in the reports.
		Source: "call_center",
		Status: "open",
	}); err != nil {
		slog.Error("recordTeamRouting: activity", "contact", contactID, "err", err)
	}
}

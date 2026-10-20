package handlers

import (
	"context"
	"encoding/json"

	"github.com/o3c/workspace/core"
)

/*
ASSIGN TARGETS — one check for "can this person actually be given work?"

WHY THIS EXISTS, COUNTED. Forty-one handlers take a staff user id from a request body and
use it to assign work. Nine of them validated that id in no way whatsoever — not even a
zero-check in two cases — and several of those write to columns that carry NO foreign key
to o3c_users, so a mistyped id does not fail: it silently assigns the work to a user who
does not exist, where nothing will ever surface it. collections_ops.go had already written
the finding down in a comment:

	"There is no FK on agent_user_id, so a mistyped id silently assigned a whole batch
	 of accounts to nobody."

Of the rest, most relied on the foreign key alone, which proves only that the row exists —
it says nothing about whether the account is live. So work could be handed to somebody
deactivated six months ago, and the only symptom is a queue that never moves.

Fourteen handlers already did some version of this check, in nine slightly different
phrasings, three of which omitted deleted_at. That is the drift this file ends: one
question, asked the same way, with one sentence back.

WHAT IT CHECKS, AND WHAT IT DELIBERATELY DOES NOT.

	exists, not deleted,     account state. A deactivated or suspended account cannot
	is_active, not suspended sign in, so assigning work to it is assigning work to a
	                         closed door.

	NOT app.is_unavailable   being away is temporary, and the business decision of
	                         2026-10-19 is explicit: a human assigning by hand may
	                         deliberately assign to somebody who is away, and sees the
	                         absence on the dropdown (availability is returned as data by
	                         /api/availability/assignable). Refusing here would overturn
	                         that decision in the one place it was meant to hold. Machines
	                         exclude; people are warned.

	NOT role or department   two handlers check a role and they are right to, because a
	                         ticket needs Helpdesk access to work. But most do not, and
	                         inventing a role rule for each queue here would be guessing
	                         at policy. Account state is the floor, not the ceiling.
*/

// assignTargetProblem returns "" when id can be given work, or a sentence naming the
// problem, suitable for returning to the caller as a 422.
//
// A zero id is reported as missing rather than as unknown, because the two are different
// mistakes: one is a field the screen failed to send, the other is a stale list.
func assignTargetProblem(ctx context.Context, db *core.DB, id int64) string {
	if id <= 0 {
		return "No member of staff was named to assign this to"
	}
	rows, err := db.PGQuery(ctx, `
		SELECT u.full_name,
		       (u.deleted_at IS NOT NULL) AS deleted,
		       NOT u.is_active             AS inactive,
		       (u.suspended_at IS NOT NULL) AS suspended
		  FROM app.o3c_users u WHERE u.id = $1`, id)
	if err != nil {
		// An unreadable users table is not the caller's fault and must not read as a
		// rejection of their choice, so it fails closed with a different sentence.
		return "Could not check whether that member of staff can take this on"
	}
	if len(rows) == 0 {
		return "That member of staff does not exist — refresh the list and choose again"
	}
	row := rows[0]
	name := "That account"
	if n, ok := row["full_name"].(string); ok && n != "" {
		name = n
	}
	if row["deleted"] == true {
		return name + " has been removed and cannot be given work"
	}
	if row["inactive"] == true {
		return name + " is deactivated and cannot be given work"
	}
	if row["suspended"] == true {
		return name + " is suspended and cannot be given work"
	}
	return ""
}

// assignTargetProblemIn is the same check for an id arriving inside a decoded JSON
// object, which is how the PATCH-style handlers take it: they build their SET clause
// from whichever keys are present, so "absent" and "sent as null" have to stay
// distinguishable and neither is an error.
//
//	key absent    nothing is being changed, so there is nothing to check
//	key null      a deliberate unassignment, which all of these handlers allow
//	key a number  it has to name somebody who can open the thing being assigned
func assignTargetProblemIn(ctx context.Context, db *core.DB, body map[string]any, key string) string {
	v, present := body[key]
	if !present || v == nil {
		return ""
	}
	var id int64
	switch n := v.(type) {
	case float64:
		id = int64(n)
	case int64:
		id = n
	case int:
		id = int64(n)
	case json.Number:
		parsed, err := n.Int64()
		if err != nil {
			return "Whoever this is assigned to must be given as a user id"
		}
		id = parsed
	default:
		return "Whoever this is assigned to must be given as a user id"
	}
	return assignTargetProblem(ctx, db, id)
}

// assignTargetsProblem is the same check for a list, as the bulk and round-robin
// handlers take. It names the first bad id rather than counting them: a list arriving
// with one dead account in it is a stale dropdown, and the fix is the same either way.
//
// An empty list is the caller's mistake and is reported as such, because every caller
// that takes a list treats "none given" as a 422 already.
func assignTargetsProblem(ctx context.Context, db *core.DB, ids []int64) string {
	if len(ids) == 0 {
		return "No members of staff were named to assign this to"
	}
	for _, id := range ids {
		if p := assignTargetProblem(ctx, db, id); p != "" {
			return p
		}
	}
	return ""
}

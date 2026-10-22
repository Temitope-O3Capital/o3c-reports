package handlers

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/o3c/workspace/core"
)

// Teams, and what a team actually did.
//
// "How many customers has team Jennifer reached out to this week" was answered
// "None" on 2026-10-22, and the answer was both wrong and honestly arrived at.
// Three things were missing, and none of them was the model:
//
//  1. NOTHING COULD ASK WHAT A TEAM IS. Jennifer Igwilo is sales_head with three
//     officers hanging off her by manager_user_id. That column has been populated
//     from the roster for months and no tool read it, so "team Jennifer" could
//     only ever be read as "a person called Jennifer".
//
//  2. THE SALES OUTREACH LEDGER WAS INVISIBLE. activities holds 38,706 rows
//     written by sales_activity.go and its siblings -- calls, visits, notes and
//     stage changes, each with an actor and a customer. No tool selected from it.
//
//  3. THE ONLY TOOL THAT FIT THE WORDS WAS THE WRONG LEDGER. get_agent_call_stats
//     reads helpdesk_calls, the call-centre dialler. Jennifer and her three
//     officers have never had one row in it, because sales does not use the
//     dialler. So the model looked for an agent named Jennifer, correctly found
//     none, and said so.
//
// The fix is a team resolver and a tool over the ledger sales actually writes to.
// The model needed data, not a sterner prompt.

// assistantTeamHead resolves a team to the colleague who heads it.
//
// Ordered by HOW MANY PEOPLE REPORT TO THEM, not by how well the name matches.
// Two colleagues can share a first name and only one of them heads a team;
// "team Jennifer" means that one. Falling through to job title lets "the sales
// team" and "team Jennifer" take the same path.
func assistantTeamHead(ctx context.Context, db *core.DB, who string) (map[string]any, error) {
	who = strings.TrimSpace(who)
	if who == "" {
		return nil, nil
	}

	const sel = `
		SELECT u.id, u.full_name, u.role, u.department,
		       (SELECT COUNT(*) FROM o3c_users m
		         WHERE m.manager_user_id = u.id AND m.deleted_at IS NULL) AS reports
		FROM o3c_users u
		WHERE u.deleted_at IS NULL AND u.role <> 'system'
		  AND %s
		ORDER BY reports DESC, u.is_active DESC, u.full_name
		LIMIT 1`

	rows, err := db.PGQuery(ctx, fmt.Sprintf(sel,
		`(u.full_name ILIKE '%' || $1 || '%'
		  OR u.first_name ILIKE '%' || $1 || '%'
		  OR u.last_name  ILIKE '%' || $1 || '%')`), who)
	if err != nil {
		return nil, err
	}
	if len(rows) > 0 {
		return rows[0], nil
	}

	// Not a name. Try it as a job title, so "the sales team" resolves too.
	rows, err = db.PGQuery(ctx, fmt.Sprintf(sel,
		`(u.role = ANY(string_to_array($1, ',')) OR u.role ILIKE '%' || $2 || '%')`),
		strings.Join(assistantRoleCandidates(who), ","), assistantRoleToken(who))
	if err != nil {
		return nil, err
	}
	if len(rows) > 0 {
		return rows[0], nil
	}
	return nil, nil
}

// assistantTeamIDs returns the head and their direct reports as the id list the
// activity query filters on. The head is INCLUDED: a sales head carries their own
// accounts, and "what has team Jennifer done" plainly covers Jennifer.
func assistantTeamIDs(ctx context.Context, db *core.DB, headID int64) ([]string, []map[string]any, error) {
	rows, err := db.PGQuery(ctx, `
		SELECT id, full_name, role,
		       CASE WHEN is_active THEN 'active' ELSE 'inactive' END AS account_status
		FROM o3c_users
		WHERE manager_user_id = $1 AND deleted_at IS NULL AND role <> 'system'
		ORDER BY full_name`, headID)
	if err != nil {
		return nil, nil, err
	}
	ids := []string{strconv.FormatInt(headID, 10)}
	for _, r := range rows {
		if v, ok := r["id"]; ok {
			ids = append(ids, fmt.Sprint(v))
		}
		delete(r, "id")
	}
	return ids, rows, nil
}

// assistantPersonMatches resolves a colleague by name, and does NOT hide the
// fact that more than one person answers to it.
//
// There are two Kehindes: Kehinde Naibi heads operations with six reports, and
// Kehinde Ajayi is one of Jennifer's sales officers. "What has Kehinde done this
// week" has two different true answers, and silently picking the alphabetically
// first one would report the wrong person's work as theirs. So the caller gets
// every candidate and must name who it reported on.
func assistantPersonMatches(ctx context.Context, db *core.DB, name string) ([]map[string]any, error) {
	return db.PGQuery(ctx, `
		SELECT id, full_name, role FROM o3c_users
		WHERE deleted_at IS NULL AND role <> 'system'
		  AND (full_name ILIKE '%' || $1 || '%'
		       OR first_name ILIKE '%' || $1 || '%'
		       OR last_name  ILIKE '%' || $1 || '%')
		ORDER BY is_active DESC, full_name
		LIMIT 4`, name)
}

func assistantTeamTools() []assistantTool {
	return []assistantTool{
		{
			Name: "get_team",
			Description: "Who reports to whom: the members of a named colleague's team, or of a " +
				"team named by its function. Use this for 'who is on team Jennifer', 'who " +
				"reports to the sales head', 'how big is the collections team'. A team is " +
				"named after the colleague who heads it.",
			Params: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"team": map[string]any{"type": "string",
						"description": "The colleague who heads the team, or the team's function, e.g. 'Jennifer', 'sales head', 'collections'."},
				},
			},
			// No page key, for the same reason find_staff has none: the reporting
			// line is already on every person's profile in the directory.
			Run: func(ctx context.Context, db *core.DB, u *core.Claims, a map[string]any) (any, error) {
				who := argStr(a, "team")
				if who == "" {
					return nil, fmt.Errorf("the name of the colleague who heads the team is required")
				}
				head, err := assistantTeamHead(ctx, db, who)
				if err != nil {
					return nil, err
				}
				if head == nil {
					return map[string]any{"searched_for": who, "found": false,
						"note": "Nobody in the directory matches that name or title. Say that plainly."}, nil
				}
				id, _ := strconv.ParseInt(fmt.Sprint(head["id"]), 10, 64)
				_, members, err := assistantTeamIDs(ctx, db, id)
				if err != nil {
					return nil, err
				}
				delete(head, "id")
				delete(head, "reports")
				out := map[string]any{"head": head, "members": members, "size": len(members)}
				if len(members) == 0 {
					out["note"] = "Nobody reports to this colleague, so they do not head a team. " +
						"Say that rather than implying the information is missing."
				}
				return out, nil
			},
		},
		{
			Name: "get_outreach_activity",
			Description: "What our own staff RECORDED doing with customers and leads: calls made, " +
				"visits, notes and pipeline stage changes, per colleague, with how many " +
				"distinct customers each one contacted. Use for 'how many customers has " +
				"team Jennifer reached out to this week', 'who has been calling', 'what has " +
				"Kehinde done this month'. This is the sales and relationship ledger. For " +
				"the call-centre dialler specifically, use get_call_centre_stats instead.",
			Params: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"team": map[string]any{"type": "string",
						"description": "Limit to a team, named by the colleague heading it, e.g. 'Jennifer'. Covers the head and everyone reporting to them."},
					"person": map[string]any{"type": "string",
						"description": "Limit to one colleague by name."},
					"days": map[string]any{"type": "integer",
						"description": "How many days back, 1 to 365. Default 7."},
				},
			},
			Pages: []string{"sales"},
			Run: func(ctx context.Context, db *core.DB, u *core.Claims, a map[string]any) (any, error) {
				days := argInt(a, "days", 7, 1, 365)
				team, person := argStr(a, "team"), argStr(a, "person")

				var ids []string
				var ambiguous []string
				var members []map[string]any
				scope := "everyone who logged activity"

				switch {
				case team != "":
					head, err := assistantTeamHead(ctx, db, team)
					if err != nil {
						return nil, err
					}
					if head == nil {
						return map[string]any{"searched_for": team, "found": false,
							"note": "Nobody in the directory matches that name or title, so there is no " +
								"team to report on. Say so plainly."}, nil
					}
					id, _ := strconv.ParseInt(fmt.Sprint(head["id"]), 10, 64)
					ids, members, err = assistantTeamIDs(ctx, db, id)
					if err != nil {
						return nil, err
					}
					scope = fmt.Sprint(head["full_name"]) + " and the team reporting to them"
				case person != "":
					people, err := assistantPersonMatches(ctx, db, person)
					if err != nil {
						return nil, err
					}
					if len(people) == 0 {
						return map[string]any{"searched_for": person, "found": false,
							"note": "No colleague of that name is in the directory. Say so plainly."}, nil
					}
					ids = []string{fmt.Sprint(people[0]["id"])}
					scope = fmt.Sprint(people[0]["full_name"]) + " (" + fmt.Sprint(people[0]["role"]) + ")"
					if len(people) > 1 {
						var others []string
						for _, p := range people[1:] {
							others = append(others, fmt.Sprint(p["full_name"])+" ("+fmt.Sprint(p["role"])+")")
						}
						ambiguous = others
					}
				}

				// NOTES THE ASSISTANT WROTE ARE EXCLUDED from customers_contacted below.
				// A note counts as customer contact, so without that exclusion asking the
				// assistant to log something would raise an officer's contact figure, and a
				// note written on a misunderstanding would become evidence of work nobody
				// did. add_customer_note marks every row source='assistant' for this.
				// An EMPTY id list must not read as "no rows". It is built as a comma
				// string so a single query serves the scoped and unscoped cases alike,
				// and an empty string means no filter.
				filter := strings.Join(ids, ",")

				rows, err := db.PGQuery(ctx, `
					SELECT u.full_name AS colleague,
					       COUNT(*) FILTER (WHERE a.type = 'call')         AS calls,
					       COUNT(*) FILTER (WHERE a.type = 'visit')        AS visits,
					       COUNT(*) FILTER (WHERE a.type = 'note')         AS notes,
					       COUNT(*) FILTER (WHERE a.type = 'stage_change') AS stage_changes,
					       COUNT(DISTINCT COALESCE(a.party_id::text, a.contact_id::text, NULLIF(a.phone, '')))
					         FILTER (WHERE a.type IN ('call','visit','note') AND COALESCE(a.source,'') <> 'assistant') AS customers_contacted
					FROM activities a
					JOIN o3c_users u ON u.id = a.actor_user_id AND u.deleted_at IS NULL
					WHERE a.occurred_at >= now() - make_interval(days => $1)
					  AND ($2 = '' OR a.actor_user_id = ANY(string_to_array($2, ',')::bigint[]))
					  -- System Rule and Lead router write here too, and actor_user_id 0 is a
					  -- sentinel, not a person. This tool reports what COLLEAGUES recorded.
					  AND a.actor_user_id > 0
					GROUP BY 1
					ORDER BY customers_contacted DESC, calls DESC, colleague
					LIMIT 12`, days, filter)
				if err != nil {
					return nil, err
				}

				// The total is NOT the sum of the rows. One customer contacted by two
				// officers is one customer reached, and the same customer called on
				// three days is one customer too.
				tot, err := db.PGQuery(ctx, `
					SELECT COUNT(*) FILTER (WHERE a.type = 'call') AS calls,
					       COUNT(DISTINCT COALESCE(a.party_id::text, a.contact_id::text, NULLIF(a.phone, '')))
					         FILTER (WHERE a.type IN ('call','visit','note') AND COALESCE(a.source,'') <> 'assistant') AS customers_contacted,
					       COALESCE(MAX(a.occurred_at)::date::text, 'none in this window') AS last_activity
					FROM activities a
					WHERE a.occurred_at >= now() - make_interval(days => $1)
					  AND ($2 = '' OR a.actor_user_id = ANY(string_to_array($2, ',')::bigint[]))
					  -- System Rule and Lead router write here too, and actor_user_id 0 is a
					  -- sentinel, not a person: colleagues only, on both queries alike.
					  AND a.actor_user_id > 0`, days, filter)
				if err != nil {
					return nil, err
				}

				out := map[string]any{
					"scope":        scope,
					"days":         days,
					"by_colleague": rows,
					// Said once, plainly, because this figure is a floor and not a
					// measurement. Sales officers logged 21 calls in October against the
					// call centre's 10,329 in September: that gap is recording habit, not
					// effort, and an answer implying otherwise is worse than no answer.
					"note": "These are activities STAFF RECORDED in the workspace, so they are a floor " +
						"on what happened and not a complete record. Say 'logged' or 'recorded' " +
						"when reporting these figures. Never add the per-colleague customer " +
						"counts together -- use the total, which already counts each customer once.",
				}
				if len(tot) > 0 {
					out["team_total"] = tot[0]
				}
				if len(ambiguous) > 0 {
					out["other_people_with_that_name"] = ambiguous
					out["note"] = fmt.Sprint(out["note"]) +
						" More than one colleague answers to that name, so NAME the person " +
						"these figures belong to and say who else it could have been."
				}
				if len(members) > 0 {
					out["team_members"] = members
				}
				return out, nil
			},
		},
	}
}

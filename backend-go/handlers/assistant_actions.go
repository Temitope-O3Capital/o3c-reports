package handlers

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/o3c/workspace/core"
)

// The first thing the assistant is allowed to WRITE.
//
// Until now it could only read, and "draft me an email" meant it produced text
// for someone to copy. The obvious next step was to let it create the email --
// and that turned out to be unsafe for a reason worth recording: mail_messages
// has no draft state. Its statuses are queued, sending, failed and unsubscribed,
// and the dispatcher picks up anything queued. A row inserted there is not a
// draft, it is an email already on its way to a customer. So drafting stays as
// text in the reply, and will until there is a real draft state for a human to
// approve.
//
// What IS safe is a note, and it is safe for reasons rather than by assertion:
//
//   - IT IS ADDITIVE. One INSERT, no UPDATE and no DELETE. Nothing that existed
//     before is changed, so the worst case is a wrong note somebody deletes,
//     not a changed record nobody notices.
//   - IT MOVES NO MONEY AND APPROVES NOTHING. The system prompt already forbids
//     that; this tool could not do it if it tried.
//   - IT IS ATTRIBUTED TO THE PERSON ASKING, from their session claims and never
//     from a tool argument, so the model cannot write a note as somebody else.
//   - IT WIDENS NO PERMISSION. POST /activities sits on the plain authenticated
//     router with no page gate, so every member of staff can already add a note
//     through the UI. This tool is exactly as permitted, no more.
//   - IT REFUSES WHEN IT CANNOT TELL WHO THE NOTE IS ABOUT. An unattached note
//     is a note nobody will ever read again, and guessing the wrong customer is
//     worse than declining.
//
// AND IT IS MARKED, WHICH MATTERS MORE THAN IT LOOKS. Every note is written with
// source='assistant'. Notes count as customer contact in get_outreach_activity,
// so without that mark an assistant note would inflate "customers contacted" --
// a staff performance figure -- and a hallucinated note would become evidence
// that somebody did work they did not do. That tool now excludes this source.

// assistantNoteSubject is who a note is about, once resolved.
type assistantNoteSubject struct {
	Label     string
	PartyID   *int64
	ContactID *int64
	CIF       string
}

// assistantResolveNoteSubject finds exactly one person for a note to hang on.
//
// Tries the CRM contact book first, because a note is nearly always about
// somebody being worked as a lead, then the customer master. Returns nothing
// rather than a guess when several people match.
func assistantResolveNoteSubject(ctx context.Context, db *core.DB, who string) (*assistantNoteSubject, []string, error) {
	who = strings.TrimSpace(who)
	if who == "" {
		return nil, nil, nil
	}

	rows, err := db.PGQuery(ctx, `
		-- btrim only strips the SPACE character. Some contact names carry a tab or
		-- a non-breaking space, and 16,166 contacts have an empty first_name, so a
		-- plain concatenation leaves leading whitespace that btrim does not touch.
		-- Collapsing all whitespace first is what makes the label right. The same
		-- family of character has already produced two bugs in this work.
		SELECT id, btrim(regexp_replace(COALESCE(first_name,'') || ' ' || COALESCE(last_name,''), '\s+', ' ', 'g')) AS full_name, party_id
		FROM crm_contacts
		-- crm_contacts has no deleted_at and no full_name: the name is two columns
		-- and there is no soft delete. A Go build does not validate SQL in a
		-- string, so this cost a test run to find rather than a compile.
		WHERE (btrim(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) ILIKE '%' || $1 || '%'
		       OR phone = $1)
		ORDER BY updated_at DESC NULLS LAST, id
		LIMIT 4`, who)
	if err != nil {
		return nil, nil, err
	}
	if len(rows) == 1 {
		s := &assistantNoteSubject{Label: fmt.Sprint(rows[0]["full_name"])}
		if v, ok := rows[0]["id"].(int64); ok {
			s.ContactID = &v
		}
		if v, ok := rows[0]["party_id"].(int64); ok {
			s.PartyID = &v
		}
		return s, nil, nil
	}
	if len(rows) > 1 {
		var names []string
		for _, r := range rows {
			names = append(names, fmt.Sprint(r["full_name"]))
		}
		return nil, names, nil
	}

	cust, err := db.PGQuery(ctx, `
		SELECT DISTINCT cif, full_name
		FROM app.customers
		WHERE cif = $1 OR full_name ILIKE '%' || $1 || '%'
		ORDER BY full_name
		LIMIT 4`, who)
	if err != nil {
		return nil, nil, err
	}
	if len(cust) == 1 {
		return &assistantNoteSubject{
			Label: fmt.Sprint(cust[0]["full_name"]),
			CIF:   fmt.Sprint(cust[0]["cif"]),
		}, nil, nil
	}
	var names []string
	for _, r := range cust {
		names = append(names, fmt.Sprint(r["full_name"])+" ("+fmt.Sprint(r["cif"])+")")
	}
	return nil, names, nil
}

func assistantActionTools() []assistantTool {
	return []assistantTool{
		{
			Name: "add_customer_note",
			Description: "Write a note onto a customer's or lead's timeline, so it is on the " +
				"record for whoever works them next. Use when the person asks you to note, " +
				"log or record something about a named customer — 'note that she asked for a " +
				"statement', 'log that he will pay on Friday'. It adds a note and nothing " +
				"else: it moves no money, sends nothing and approves nothing.",
			Params: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"about": map[string]any{"type": "string",
						"description": "The customer or lead the note is about: a name, a phone number or a CIF."},
					"note": map[string]any{"type": "string",
						"description": "What to record, in full sentences. Write what the person told you, not your own commentary."},
				},
				"required": []string{"about", "note"},
			},
			// No page key, matching POST /activities, which every authenticated
			// member of staff may already call. See the header.
			Run: func(ctx context.Context, db *core.DB, u *core.Claims, a map[string]any) (any, error) {
				about, note := argStr(a, "about"), strings.TrimSpace(argStr(a, "note"))
				if about == "" || note == "" {
					return nil, fmt.Errorf("both the customer and the note text are required")
				}
				if u == nil || u.ID == 0 {
					// Attribution is the whole safety story. Without a real actor this
					// would write an anonymous record into a system of record.
					return nil, fmt.Errorf("a signed-in user is required to write a note")
				}
				if len(note) > 2000 {
					return nil, fmt.Errorf("that note is too long; keep it under 2000 characters")
				}

				subj, ambiguous, err := assistantResolveNoteSubject(ctx, db, about)
				if err != nil {
					return nil, err
				}
				if subj == nil {
					out := map[string]any{"written": false, "searched_for": about}
					if len(ambiguous) > 0 {
						out["several_people_match"] = ambiguous
						out["note"] = "More than one person matches that name, so nothing was written. " +
							"Ask which one is meant and say the note has NOT been saved yet."
					} else {
						out["note"] = "Nobody of that name is in the contact book or the customer " +
							"master, so nothing was written. Say the note has NOT been saved."
					}
					return out, nil
				}

				actor := u.ID
				now := time.Now()
				id, err := LogActivity(ctx, db, Activity{
					PartyID:     subj.PartyID,
					ContactID:   subj.ContactID,
					CIF:         subj.CIF,
					ActorUserID: &actor,
					ActorName:   u.FullName,
					ActorTeam:   teamFromRole(u.Role),
					Type:        "note",
					Direction:   "internal",
					Subject:     "Note added through the assistant",
					Body:        note,
					// The mark that keeps this out of staff contact figures.
					Source:     "assistant",
					OccurredAt: &now,
					Metadata: map[string]any{
						"written_by": "assistant",
						"on_behalf_of": map[string]any{
							"user_id": u.ID, "name": u.FullName,
						},
					},
				})
				if err != nil {
					return nil, err
				}

				return map[string]any{
					"written":     true,
					"activity_id": id,
					"about":       subj.Label,
					"recorded_by": u.FullName,
					"note_text":   note,
					"note": "Saved to " + subj.Label + "'s timeline, recorded against " +
						u.FullName + " and marked as written through the assistant. Tell the " +
						"person exactly what was saved and who it is about, so they can correct " +
						"it if the customer is wrong. It does not count as customer contact in " +
						"outreach figures.",
				}, nil
			},
		},
	}
}

package handlers

import (
	"context"
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

// ─────────────────────────────────────────────────────────────────────────────
// Distributing the lead pool — evenly within an office, correctly between states.
//
// Two rules, and they are not the same rule:
//
//   CORRECTLY BETWEEN STATES. A lead belongs to the office that can actually visit it.
//   Migration 353 maps all 37 states to Lagos or Abuja; app.sales_hub_for_state resolves
//   the lead and app.sales_hub_for_office resolves the officer, because the two books
//   spell the same place differently ('FCT' on a lead, 'Abuja' on an officer).
//
//   EVENLY WITHIN IT. Round-robin, biggest estimated value dealt first, so no single
//   officer collects all the large leads. This is deliberately the same mechanic as
//   Collections' Distribute Queue (collectionsOpsDistribute) — a floor that already
//   understands one distribution button should not have to learn a second behaviour.
//
// WHAT IT WILL NOT DO. A lead whose state does not resolve is never routed: it stays in
// the pool and is reported back as unroutable, so a typo ('Lgos') or a blank surfaces as
// a number a head can act on instead of landing in whichever office the code defaulted
// to. Migration 317 took the same view of the five leads whose campaign named no
// location. Nor does it ever move a lead that already has an owner — re-running must be
// safe, and taking work off whoever holds it silently is the one outcome nobody could
// recover from.
//
// An officer with no office_location takes part in nothing, by the same logic: two of the
// fourteen sales staff have a blank office, and guessing one for them would quietly give
// a Lagos lead to someone in Abuja.
// ─────────────────────────────────────────────────────────────────────────────

// RegisterSalesLeadDistribute adds the pool preview.
//
// The ACTION itself lives in sales_leads.go's distributeLeads, which already owned
// POST /leads/distribute, already had the dry-run/limit contract the Leads page is
// written against, and already wrote a crm_lead_events row per assignment inside one
// transaction. Registering a second handler on that path would have been a routing
// collision at start-up, so the office routing went in there as a 'by_office' strategy
// instead — its 'by_state' strategy clusters a state onto one officer but never checks
// that the officer's office covers it, which is the thing Sales actually asked for.
//
// This file keeps the read side: "what would pressing Distribute do", which had no
// endpoint at all.
func RegisterSalesLeadDistribute(r chi.Router, db *core.DB) {
	access := core.RequirePages("sales", "crm_contacts")
	r.With(access).Get("/leads/distribution", salesLeadDistributionPreview(db))
}

// distributableOfficers resolves who may receive leads, and in which office.
//
// Scope follows the same structure the Leads queue uses: a head deals to their own
// team(s), management deals to everyone on an active sales team. Passing explicit ids
// narrows that further — the head picking who is on shift today, exactly as Collections
// does — but can never widen past what the caller may already see.
func distributableOfficers(r *http.Request, db *core.DB, u *core.Claims, want []int64) ([]int64, error) {
	allowed := map[int64]bool{}
	if ids := teamHeadOfficerIDs(r, db, u.ID); len(ids) > 0 {
		for _, id := range ids {
			allowed[id] = true
		}
	} else if u.CanSeeAllRows() || isSalesHead(u) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT DISTINCT m.user_id FROM app.sales_teams t
			  JOIN app.sales_team_members m ON m.team_id = t.id
			 WHERE t.is_active
			UNION
			SELECT t.head_user_id FROM app.sales_teams t
			 WHERE t.is_active AND t.head_user_id IS NOT NULL`)
		if err != nil {
			return nil, err
		}
		for _, row := range rows {
			if id := toInt64(row["user_id"]); id != 0 {
				allowed[id] = true
			}
		}
	}
	if len(allowed) == 0 {
		return nil, nil
	}
	out := []int64{}
	if len(want) > 0 {
		for _, id := range want {
			if allowed[id] {
				out = append(out, id)
			}
		}
		return out, nil
	}
	for id := range allowed {
		out = append(out, id)
	}
	return out, nil
}

// salesLeadDistributionPreview answers "what would pressing Distribute do?" — the pool
// per office, who is eligible to receive it, and how many leads cannot be routed at all.
//
// It exists because the answer is not obvious from the Leads table: a pool of 40 split
// across two offices with nobody rostered in one of them is a very different situation
// from 40 that all belong to Lagos, and a head should see which before they commit.
func salesLeadDistributionPreview(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := core.UserFromCtx(r.Context())
		if !canManageTeams(u) {
			respondErr(w, 403, "Only a sales head can distribute the lead pool")
			return
		}
		officers, err := distributableOfficers(r, db, u, nil)
		if err != nil {
			respondErrLog(w, 500, "Could not resolve the officer roster", err)
			return
		}
		pool, err := db.PGQuery(r.Context(), `
			SELECT COALESCE(app.sales_hub_for_state(state), '(unroutable)') AS hub,
			       COUNT(*)                                                 AS leads,
			       COALESCE(SUM(COALESCE(estimated_value_kobo, 0)), 0)      AS value_kobo
			  FROM app.crm_contacts
			 WHERE sales_entered_at IS NOT NULL
			   AND sales_owner_id IS NULL
			   AND lead_stage NOT IN ('converted', 'disqualified')
			 GROUP BY 1 ORDER BY 1`)
		if err != nil {
			respondErrLog(w, 500, "Could not read the lead pool", err)
			return
		}
		var roster []map[string]any
		if len(officers) > 0 {
			roster, err = db.PGQuery(r.Context(), `
				SELECT u.id, u.full_name,
				       app.sales_hub_for_office(u.office_location) AS hub,
				       u.office_location,
				       (SELECT COUNT(*) FROM app.crm_contacts c
				         WHERE c.sales_owner_id = u.id
				           AND c.lead_stage NOT IN ('converted', 'disqualified')) AS open_leads
				  FROM app.o3c_users u
				 WHERE u.is_active AND u.id = ANY($1::bigint[])
				 ORDER BY app.sales_hub_for_office(u.office_location) NULLS LAST, u.full_name`,
				int64Array(officers))
			if err != nil {
				respondErrLog(w, 500, "Could not read the officer roster", err)
				return
			}
		}
		respond(w, map[string]any{"pool": pool, "officers": roster}, "pg")
	}
}

// notifyLeadsAssigned tells each officer what landed in their queue — one grouped
// notification per officer rather than one per lead, so a 40-lead distribution is a
// single "12 leads assigned to you" rather than forty pings nobody reads.
func notifyLeadsAssigned(ctx context.Context, db *core.DB, perOfficer map[int64]int) {
	for id, count := range perOfficer {
		if id == 0 || count == 0 {
			continue
		}
		noun, Noun := "leads", "Leads"
		if count == 1 {
			noun, Noun = "lead", "Lead"
		}
		go Notify(context.WithoutCancel(ctx), db, NotifPayload{
			EventType: EvtLeadAssigned,
			UserID:    id,
			Title:     fmt.Sprintf("%d New %s Assigned to You", count, Noun),
			Body: fmt.Sprintf("%d %s from the pool are now yours to work. "+
				"Open Leads to plan the first visit.", count, noun),
			ActionURL: "/sales/leads?owner=me",
			EntityRef: fmt.Sprintf("sales_lead_batch:%d", id),
			Priority:  "high",
		})
	}
}

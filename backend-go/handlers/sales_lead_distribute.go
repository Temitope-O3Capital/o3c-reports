package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

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

// RegisterSalesLeadDistribute adds the pool preview and the distribute action.
// Both are head/management actions — an officer cannot deal the pool to themselves.
func RegisterSalesLeadDistribute(r chi.Router, db *core.DB) {
	access := core.RequirePages("sales", "crm_contacts")
	r.With(access).Get("/leads/distribution", salesLeadDistributionPreview(db))
	r.With(access).Post("/leads/distribute", salesLeadDistribute(db))
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

// salesLeadDistribute deals the unowned pool out.
func salesLeadDistribute(db *core.DB) http.HandlerFunc {
	type body struct {
		// Hub narrows the run to one office. Empty means both.
		Hub string `json:"hub"`
		// OfficerIDs is who is on shift. Empty means everyone in scope with an office.
		OfficerIDs []int64 `json:"officer_ids"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		u := core.UserFromCtx(ctx)
		if !canManageTeams(u) {
			respondErr(w, 403, "Only a sales head can distribute the lead pool")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil && err.Error() != "EOF" {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		hub := strings.TrimSpace(b.Hub)
		if hub != "" && hub != "Lagos" && hub != "Abuja" {
			respondErr(w, 422, "hub must be Lagos, Abuja, or omitted for both")
			return
		}
		officers, err := distributableOfficers(r, db, u, b.OfficerIDs)
		if err != nil {
			respondErrLog(w, 500, "Could not resolve the officer roster", err)
			return
		}
		if len(officers) == 0 {
			respondErr(w, 422, "No officers to distribute to. Add officers to a sales team first.")
			return
		}

		// One statement, so a half-finished distribution cannot exist. seq % n per hub is
		// the round-robin; ordering by value descending within the hub is what spreads the
		// large leads instead of stacking them on whoever sorts first.
		assigned, err := db.PGQuery(ctx, `
			WITH pool AS (
				SELECT u.id,
				       app.sales_hub_for_office(u.office_location) AS hub,
				       ROW_NUMBER() OVER (PARTITION BY app.sales_hub_for_office(u.office_location)
				                          ORDER BY u.id) - 1 AS rn,
				       COUNT(*)    OVER (PARTITION BY app.sales_hub_for_office(u.office_location)) AS n
				  FROM app.o3c_users u
				 WHERE u.is_active
				   AND u.id = ANY($1::bigint[])
				   AND app.sales_hub_for_office(u.office_location) IS NOT NULL
				   AND ($2 = '' OR app.sales_hub_for_office(u.office_location) = $2)
			),
			todo AS (
				SELECT c.id,
				       app.sales_hub_for_state(c.state) AS hub,
				       ROW_NUMBER() OVER (PARTITION BY app.sales_hub_for_state(c.state)
				                          ORDER BY COALESCE(c.estimated_value_kobo, 0) DESC, c.id) - 1 AS seq
				  FROM app.crm_contacts c
				 WHERE c.sales_entered_at IS NOT NULL
				   AND c.sales_owner_id IS NULL
				   AND c.lead_stage NOT IN ('converted', 'disqualified')
				   AND app.sales_hub_for_state(c.state) IS NOT NULL
				   AND ($2 = '' OR app.sales_hub_for_state(c.state) = $2)
			)
			UPDATE app.crm_contacts c
			   SET sales_owner_id = p.id,
			       updated_at     = NOW()
			  FROM todo t
			  JOIN pool p ON p.hub = t.hub AND p.rn = (t.seq % p.n)
			 WHERE c.id = t.id
			RETURNING c.id, c.sales_owner_id AS officer_id, t.hub`,
			int64Array(officers), hub)
		if err != nil {
			respondErrLog(w, 500, "Distribution failed", err)
			return
		}

		perOfficer := map[int64]int{}
		perHub := map[string]int{}
		for _, row := range assigned {
			perOfficer[toInt64(row["officer_id"])]++
			perHub[str(row["hub"])]++
		}

		// What is left, and why. An unroutable remainder is the number a head needs:
		// those leads will sit there for ever until someone gives them a state.
		left, _ := db.PGQuery(ctx, `
			SELECT COUNT(*) FILTER (WHERE app.sales_hub_for_state(state) IS NULL)     AS unroutable,
			       COUNT(*) FILTER (WHERE app.sales_hub_for_state(state) IS NOT NULL) AS no_officer
			  FROM app.crm_contacts
			 WHERE sales_entered_at IS NOT NULL
			   AND sales_owner_id IS NULL
			   AND lead_stage NOT IN ('converted', 'disqualified')`)

		notifyLeadsAssigned(ctx, db, perOfficer)

		out := map[string]any{
			"assigned":    len(assigned),
			"per_officer": perOfficer,
			"per_hub":     perHub,
		}
		if len(left) > 0 {
			out["unroutable"] = toInt64(left[0]["unroutable"])
			out["no_officer_in_office"] = toInt64(left[0]["no_officer"])
		}
		respond(w, out, "pg")
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

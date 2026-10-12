package handlers

import (
	"context"
	"fmt"
	"strings"

	"github.com/o3c/workspace/core"
)

// ─────────────────────────────────────────────────────────────────────────────
// Telling people a lead moved.
//
// Before this, one alert existed for the whole lead journey: a grouped digest to
// sales_head saying "a call-centre agent qualified a lead". Which meant:
//
//   • the officer who would actually work the lead was told nothing, ever — and with
//     the pool distributed by state (migration 353) that officer is now knowable the
//     moment the lead is forwarded, not only once a head assigns it;
//   • the agent who got the customer to say yes never learned whether anybody picked
//     it up, so the floor had no idea whether hand-offs were going anywhere;
//   • a lead qualified with no location — the one case nobody can act on — looked
//     exactly like a healthy hand-off.
//
// VOLUME IS THE DESIGN CONSTRAINT, not an afterthought. The unassigned-ticket alert
// once produced 4,133 notifications for two people, who then stopped reading any of
// them, which is why GroupKey exists at all. Email is suppressed on a grouped re-send,
// so a key that never changes means one email and then silence.
//
// So the rule here is: a notification addressed to ONE person about ONE lead is
// ungrouped and emails every time, because it is specific and actionable. A
// notification to a whole office about work arriving in its patch is grouped PER DAY —
// the badge keeps counting, and they get one email each morning rather than one per
// lead or one ever.
// ─────────────────────────────────────────────────────────────────────────────

// leadHubHeads returns the heads whose team covers this hub — the people who should
// hear that a lead has landed in their patch, and nobody else.
//
// The hand-off digest used to go to every sales_head, which on this floor means the two
// Lagos heads AND the CMO hear about an Abuja lead that is none of their business. A
// head who cannot act on an alert learns to ignore the alerts they can act on.
//
// Keyed on the head's own office rather than on a hard-coded team list, so moving
// somebody between offices moves their alerts with them. Returns empty when the lead's
// state does not resolve, and the caller then falls back to every head — an unplaceable
// lead is exactly the case where somebody senior needs to look.
func leadHubHeads(ctx context.Context, db *core.DB, hub string) []int64 {
	if hub == "" {
		return nil
	}
	rows, err := db.PGQuery(ctx, `
		SELECT DISTINCT u.id
		  FROM app.o3c_users u
		  JOIN app.sales_teams t ON t.head_user_id = u.id AND t.is_active
		 WHERE u.is_active
		   AND app.sales_hub_for_office(u.office_location) = $1`, hub)
	if err != nil {
		return nil
	}
	out := []int64{}
	for _, row := range rows {
		if id := toInt64(row["id"]); id != 0 {
			out = append(out, id)
		}
	}
	return out
}

// leadHubOfficers returns the active sales officers whose office covers this hub.
func leadHubOfficers(ctx context.Context, db *core.DB, hub string) []int64 {
	if hub == "" {
		return nil
	}
	rows, err := db.PGQuery(ctx, `
		SELECT DISTINCT u.id
		  FROM app.o3c_users u
		 WHERE u.is_active
		   AND app.sales_hub_for_office(u.office_location) = $1
		   AND (u.id IN (SELECT user_id FROM app.sales_team_members)
		        OR u.id IN (SELECT head_user_id FROM app.sales_teams WHERE is_active))`, hub)
	if err != nil {
		return nil
	}
	out := []int64{}
	for _, row := range rows {
		if id := toInt64(row["id"]); id != 0 {
			out = append(out, id)
		}
	}
	return out
}

// leadForwardFacts is what the notifications need to say something concrete. A body
// reading "a lead was forwarded" is indistinguishable from any other, which is most of
// why the existing digest went unread.
type leadForwardFacts struct {
	ContactID int64
	Name      string
	City      string
	State     string
	Hub       string
	OwnerID   int64
	Product   string
}

func leadForwardFactsFor(ctx context.Context, db *core.DB, leadID int64) (leadForwardFacts, bool) {
	rows, err := db.PGQuery(ctx, `
		SELECT c.id,
		       btrim(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) AS name,
		       COALESCE(c.city, '')  AS city,
		       COALESCE(c.state, '') AS state,
		       COALESCE(app.sales_hub_for_state(c.state), '') AS hub,
		       COALESCE(c.sales_owner_id, 0) AS owner_id,
		       COALESCE(c.product_interest, '') AS product
		  FROM call_center_leads l
		  JOIN crm_contacts c ON c.id = l.contact_id
		 WHERE l.id = $1`, leadID)
	if err != nil || len(rows) == 0 {
		return leadForwardFacts{}, false
	}
	r := rows[0]
	f := leadForwardFacts{
		ContactID: toInt64(r["id"]),
		Name:      strings.TrimSpace(str(r["name"])),
		City:      str(r["city"]),
		State:     str(r["state"]),
		Hub:       str(r["hub"]),
		OwnerID:   toInt64(r["owner_id"]),
		Product:   str(r["product"]),
	}
	if f.Name == "" {
		f.Name = "A new lead"
	}
	return f, true
}

// where renders the location as a person would say it, and says so plainly when there
// isn't one — a lead nobody can place is the thing a head most needs to notice.
func (f leadForwardFacts) where() string {
	switch {
	case f.City != "" && f.State != "":
		return f.City + ", " + f.State
	case f.State != "":
		return f.State
	case f.City != "":
		return f.City
	}
	return "no location recorded"
}

// notifyLeadForwarded tells the people who can act on a freshly qualified lead.
//
// Called from recordCallHandoff, which is the real qualification path — a call said
// Interested — and is fire-and-forget there, because the hand-off is already recorded
// and an alert that fails must not throw at an agent who has just finished a call.
func notifyLeadForwarded(ctx context.Context, db *core.DB, leadID int64, agentID *int64) {
	f, ok := leadForwardFactsFor(ctx, db, leadID)
	if !ok {
		return
	}
	product := ""
	if f.Product != "" {
		product = " · interested in " + f.Product
	}
	body := f.Name + " (" + f.where() + ")" + product + ". Qualified by a call-centre call."

	if f.OwnerID != 0 {
		// Addressed to one person about one lead: ungrouped, so it emails every time.
		Notify(ctx, db, NotifPayload{
			EventType: EvtLeadForwarded,
			UserID:    f.OwnerID,
			Title:     "A Lead Was Forwarded to You",
			Body:      body + " Open it to plan the first visit.",
			ActionURL: fmt.Sprintf("/sales/leads/%d", f.ContactID),
			EntityRef: fmt.Sprintf("crm_contact:%d", f.ContactID),
			Priority:  "high",
		})
	} else if officers := leadHubOfficers(ctx, db, f.Hub); len(officers) > 0 {
		// Nobody owns it yet, so it is the office's to claim. One digest per office per
		// day: the count keeps rising in the bell, and the email arrives once.
		day := nowDateKey(ctx, db)
		NotifyUsers(ctx, db, officers, NotifPayload{
			EventType: EvtLeadForwarded,
			Title:     "New " + f.Hub + " Leads Forwarded From the Call Centre",
			Body:      body + " Unclaimed. Open Leads to take it.",
			ActionURL: "/sales/leads?owner=unassigned",
			EntityRef: fmt.Sprintf("crm_contact:%d", f.ContactID),
			GroupKey:  "sales:forwarded:" + f.Hub + ":" + day,
			Priority:  "high",
		})
	}

	// The head whose office covers this lead — and only them.
	//
	// This digest used to go to every sales_head, so both Lagos heads and the CMO were
	// told about Abuja leads they cannot act on. Alerts a person cannot act on are how
	// they learn to ignore the ones they can. Dated, so it collapses within a day and
	// reopens the next morning rather than falling silent for ever.
	//
	// Falls back to every head when the state does not resolve, because an unplaceable
	// lead belongs to no office and is precisely when someone senior should look.
	if heads := leadHubHeads(ctx, db, f.Hub); len(heads) > 0 {
		NotifyUsers(ctx, db, heads, NotifPayload{
			EventType: EvtLeadForwarded,
			Title:     "A Lead Was Forwarded to Your Team",
			Body:      body + " " + whoHasIt(f),
			ActionURL: "/sales/leads?owner=unassigned",
			EntityRef: fmt.Sprintf("crm_contact:%d", f.ContactID),
			GroupKey:  "sales:head:" + f.Hub + ":" + nowDateKey(ctx, db),
			Priority:  "high",
		})
	}

	// A lead with no resolvable state cannot be routed or planned, and will sit in the
	// pool indefinitely unless a person notices. Heads get this one because fixing it
	// means deciding where the customer actually is.
	if f.Hub == "" {
		NotifyRoles(ctx, db, []string{"sales_head", "call_center_head"}, NotifPayload{
			EventType: EvtLeadNoLocation,
			Title:     "A Qualified Lead Has No Location",
			Body: f.Name + " was qualified without a state we can route on, so no office " +
				"owns it and nobody can plan a visit. Add the state to release it.",
			ActionURL: fmt.Sprintf("/sales/leads/%d", f.ContactID),
			EntityRef: fmt.Sprintf("crm_contact:%d", f.ContactID),
			GroupKey:  "sales:unroutable",
			Priority:  "high",
		})
	}

	// And close the loop for the agent: they are the one person who spoke to the
	// customer, and until now nothing told them the hand-off had landed.
	if agentID != nil && *agentID != 0 {
		Notify(ctx, db, NotifPayload{
			EventType: EvtLeadForwarded,
			UserID:    *agentID,
			Title:     "Your Lead Reached Sales",
			Body:      f.Name + " (" + f.where() + ") is now with the " + hubOrSales(f.Hub) + " team.",
			ActionURL: "/call-center/forwards",
			EntityRef: fmt.Sprintf("crm_contact:%d", f.ContactID),
			GroupKey:  "cc:handoff:landed:" + nowDateKey(ctx, db),
			Priority:  "low",
		})
	}
}

func hubOrSales(hub string) string {
	if hub == "" {
		return "sales"
	}
	return hub
}

// whoHasIt tells the head whether the lead already has a name against it or is sitting
// in the pool waiting to be given out — the one thing that decides whether they need to
// do anything about it.
func whoHasIt(f leadForwardFacts) string {
	if f.OwnerID != 0 {
		return "Already owned."
	}
	return "Unclaimed — distribute it or let an officer take it."
}

// nowDateKey is the database's idea of today, so a group key rolls over at the same
// moment for everyone regardless of where the process thinks it is.
func nowDateKey(ctx context.Context, db *core.DB) string {
	rows, err := db.PGQuery(ctx, `SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS d`)
	if err != nil || len(rows) == 0 {
		return "today"
	}
	return str(rows[0]["d"])
}

// notifyLeadConverted announces the one lead event worth interrupting someone for.
//
// Goes to the officer's head and the executive tier rather than the whole floor, and
// names the product line and reference — "converted on a salary loan" is a sentence
// somebody can act on, where "a lead converted" is only a number moving.
func notifyLeadConverted(ctx context.Context, db *core.DB, contactID int64, line, ref string) {
	rows, err := db.PGQuery(ctx, `
		SELECT btrim(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')) AS name,
		       COALESCE(u.full_name, 'Unassigned')                                 AS officer,
		       COALESCE(c.sales_owner_id, 0)                                       AS officer_id
		  FROM crm_contacts c
		  LEFT JOIN app.o3c_users u ON u.id = c.sales_owner_id
		 WHERE c.id = $1`, contactID)
	if err != nil || len(rows) == 0 {
		return
	}
	name, officer := str(rows[0]["name"]), str(rows[0]["officer"])
	body := name + " converted on " + line
	if ref != "" {
		body += " " + ref
	}
	body += " — closed by " + officer + "."
	NotifyRoles(ctx, db, []string{"sales_head", "cmo"}, NotifPayload{
		EventType: EvtLeadConverted,
		Title:     "A Lead Converted",
		Body:      body,
		ActionURL: fmt.Sprintf("/sales/leads/%d", contactID),
		EntityRef: fmt.Sprintf("crm_contact:%d", contactID),
		Priority:  "normal",
	})
}

// notifyLeadClaimed tells the head that an officer took a lead out of the pool, and
// tells nobody else: it is a small, routine act and the officer knows they did it.
func notifyLeadClaimed(ctx context.Context, db *core.DB, contactID, officerID int64) {
	rows, err := db.PGQuery(ctx, `
		SELECT btrim(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')) AS name,
		       (SELECT full_name FROM app.o3c_users WHERE id = $2) AS officer
		  FROM crm_contacts c WHERE c.id = $1`, contactID, officerID)
	if err != nil || len(rows) == 0 {
		return
	}
	NotifyRoles(ctx, db, []string{"sales_head"}, NotifPayload{
		EventType: EvtLeadClaimed,
		Title:     "A Lead Was Claimed",
		Body:      str(rows[0]["officer"]) + " took " + str(rows[0]["name"]) + " out of the pool.",
		ActionURL: fmt.Sprintf("/sales/leads/%d", contactID),
		EntityRef: fmt.Sprintf("crm_contact:%d", contactID),
		GroupKey:  "sales:claimed:" + nowDateKey(ctx, db),
		Priority:  "low",
	})
}

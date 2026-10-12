package handlers

import (
	"context"
	"fmt"
	"time"

	"github.com/o3c/workspace/core"
)

// ─────────────────────────────────────────────────────────────────────────────
// The morning diary — what you planned for today, and what has come due.
//
// A plan nobody is reminded of is a note in a drawer. The officer's calendar shows
// the week, but the thing that makes a diary work is being told at 07:30 what is in
// it, in the same way Collections is told about promises falling due.
//
// Two separate alerts, because they are two different failures:
//
//   visit_due_today  — you planned this. One digest listing the day, so the officer
//                      opens the calendar already knowing the shape of it.
//   follow_up_due    — a lead's next_action_at has arrived or passed. This is the one
//                      that rots silently: the disposition machinery sets the date and
//                      nothing has ever read it back out at the officer, so a promise
//                      to ring someone on Tuesday survived only as long as the officer
//                      remembered it.
//
// Overdue follow-ups are counted into the same alert rather than getting their own,
// and the body says how many are late. An officer with 14 overdue follow-ups does not
// need 14 notifications; they need to know the number is 14.
// ─────────────────────────────────────────────────────────────────────────────

// ScheduleSalesDiaryAlerts runs daily at 07:30, before the first visit of the day.
func ScheduleSalesDiaryAlerts(db *core.DB) {
	now := time.Now()
	next := time.Date(now.Year(), now.Month(), now.Day(), 7, 30, 0, 0, now.Location())
	if now.After(next) {
		next = next.Add(24 * time.Hour)
	}
	time.Sleep(next.Sub(now))

	for {
		runSalesDiaryAlerts(db)
		time.Sleep(24 * time.Hour)
	}
}

func runSalesDiaryAlerts(db *core.DB) {
	ctx := context.Background()
	WorkerBeat(ctx, db, "sales_diary_alerts", "running", "", "")
	runPlannedTodayAlerts(ctx, db)
	runFollowUpDueAlerts(ctx, db)
	WorkerBeat(ctx, db, "sales_diary_alerts", "ok", "diary + follow-up alerts swept", "")
}

// runPlannedTodayAlerts: one notification per officer, listing today's plan.
func runPlannedTodayAlerts(ctx context.Context, db *core.DB) {
	rows, err := db.PGQuery(ctx, `
		SELECT p.officer_id,
		       COUNT(*)                                        AS total,
		       COUNT(*) FILTER (WHERE p.kind = 'visit')        AS visits,
		       COUNT(*) FILTER (WHERE p.kind = 'call')         AS calls,
		       COUNT(*) FILTER (WHERE p.kind = 'meeting')      AS meetings,
		       COUNT(*) FILTER (WHERE p.kind = 'follow_up')    AS follow_ups,
		       string_agg(DISTINCT COALESCE(NULLIF(btrim(p.city), ''), ''), ', ')
		           FILTER (WHERE COALESCE(NULLIF(btrim(p.city), ''), '') <> '') AS towns
		  FROM app.sales_visit_plans p
		  JOIN app.o3c_users u ON u.id = p.officer_id AND u.is_active
		 WHERE p.planned_for = CURRENT_DATE
		   AND p.status = 'planned'
		 GROUP BY p.officer_id`)
	if err != nil {
		return
	}
	for _, row := range rows {
		officer := toInt64(row["officer_id"])
		if officer == 0 {
			continue
		}
		total := toInt64(row["total"])
		parts := []string{}
		for _, k := range []struct {
			col, one, many string
		}{
			{"visits", "visit", "visits"},
			{"calls", "call", "calls"},
			{"meetings", "meeting", "meetings"},
			{"follow_ups", "follow-up", "follow-ups"},
		} {
			if n := toInt64(row[k.col]); n > 0 {
				noun := k.many
				if n == 1 {
					noun = k.one
				}
				parts = append(parts, fmt.Sprintf("%d %s", n, noun))
			}
		}
		body := "Today: " + joinWithAnd(parts) + "."
		if towns := str(row["towns"]); towns != "" {
			body += " " + towns + "."
		}
		Notify(ctx, db, NotifPayload{
			EventType: EvtVisitDueToday,
			UserID:    officer,
			Title:     fmt.Sprintf("%d in Your Diary Today", total),
			Body:      body,
			ActionURL: "/sales/calendar",
			EntityRef: fmt.Sprintf("sales_diary:%d", officer),
			// Keyed per day: one ping each morning, never a second for the same day.
			GroupKey: fmt.Sprintf("sales:diary:%d:%s", officer, nowDateKey(ctx, db)),
			Priority: "normal",
		})
	}
}

// runFollowUpDueAlerts: the leads whose next action has arrived, or has not.
func runFollowUpDueAlerts(ctx context.Context, db *core.DB) {
	rows, err := db.PGQuery(ctx, `
		SELECT c.sales_owner_id AS officer_id,
		       COUNT(*)                                                               AS total,
		       COUNT(*) FILTER (WHERE c.next_action_at::date < CURRENT_DATE)           AS overdue,
		       MIN(btrim(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, ''))) AS a_name
		  FROM app.crm_contacts c
		  JOIN app.o3c_users u ON u.id = c.sales_owner_id AND u.is_active
		 WHERE c.next_action_at IS NOT NULL
		   AND c.next_action_at::date <= CURRENT_DATE
		   AND c.lead_stage NOT IN ('converted', 'disqualified')
		 GROUP BY c.sales_owner_id`)
	if err != nil {
		return
	}
	for _, row := range rows {
		officer := toInt64(row["officer_id"])
		if officer == 0 {
			continue
		}
		total, overdue := toInt64(row["total"]), toInt64(row["overdue"])
		noun := "follow-ups"
		if total == 1 {
			noun = "follow-up"
		}
		body := fmt.Sprintf("%d %s due", total, noun)
		if overdue > 0 {
			body += fmt.Sprintf(", %d of them already late", overdue)
		}
		if total == 1 {
			body = str(row["a_name"]) + " is due a follow-up"
			if overdue > 0 {
				body += " — and is already late"
			}
		}
		Notify(ctx, db, NotifPayload{
			EventType: EvtFollowUpDue,
			UserID:    officer,
			Title:     "Follow-Ups Due",
			Body:      body + ". Open Leads to work through them.",
			ActionURL: "/sales/leads?due=today",
			EntityRef: fmt.Sprintf("sales_followups:%d", officer),
			GroupKey:  fmt.Sprintf("sales:followups:%d:%s", officer, nowDateKey(ctx, db)),
			Priority: func() string {
				if overdue > 0 {
					return "high"
				}
				return "normal"
			}(),
		})
	}
}

// joinWithAnd renders a list the way a person would read it aloud.
func joinWithAnd(parts []string) string {
	switch len(parts) {
	case 0:
		return "nothing"
	case 1:
		return parts[0]
	case 2:
		return parts[0] + " and " + parts[1]
	}
	out := ""
	for i, p := range parts {
		switch {
		case i == len(parts)-1:
			out += " and " + p
		case i > 0:
			out += ", " + p
		default:
			out = p
		}
	}
	return out
}

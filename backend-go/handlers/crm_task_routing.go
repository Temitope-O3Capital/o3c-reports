package handlers

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// rowStr reads a text column out of a core.Row. Values arrive as any, and a NULL
// that slipped past a COALESCE must read as empty rather than panic on assertion.
func rowStr(v any) string {
	switch s := v.(type) {
	case string:
		return s
	case []byte:
		return string(s)
	case nil:
		return ""
	default:
		return fmt.Sprintf("%v", s)
	}
}

// Task routing — turning a task into the place you actually do the work.
//
// A task on its own is not actionable: "Call Adebayo about his card limit" is only
// useful next to Adebayo's book entry. Every task therefore resolves to a deep link
// at the record it concerns, with ?task=<id> appended so the receiving page opens the
// task modal over its own content. Notifications carry that link, so clicking through
// lands the officer on the work rather than on a list they must search.
//
// Previously every task notification pointed at "/crm/tasks", which is not a route in
// this app at all — the module lives under /sales. Clicking a task notification went
// to the 404 page.

// taskContext is the minimum needed to route a task to its record.
type taskContext struct {
	ID          int64
	Title       string
	LinkedType  string
	LinkedID    int64
	ContactID   int64
	DealID      int64
	ContactCIF  string
	AssignedTo  int64
	DueDate     *time.Time
	ContactName string
}

// loadTaskContext resolves a task and whatever record it hangs off. The contact join
// is left outer on purpose: a task against a deleted contact should still route
// somewhere sane rather than disappearing.
func loadTaskContext(ctx context.Context, db *core.DB, taskID int64) (*taskContext, error) {
	rows, err := db.PGQuery(ctx, `
		SELECT t.id, t.title,
		       COALESCE(t.linked_type,'')                       AS linked_type,
		       COALESCE(t.linked_id,0)                          AS linked_id,
		       COALESCE(t.contact_id,0)                         AS contact_id,
		       COALESCE(t.deal_id,0)                            AS deal_id,
		       COALESCE(c.converted_cif,'')                     AS contact_cif,
		       COALESCE(t.assigned_to,0)                        AS assigned_to,
		       t.due_date,
		       TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')) AS contact_name
		  FROM crm_tasks t
		  LEFT JOIN crm_contacts c ON c.id = t.contact_id
		 WHERE t.id = $1`, taskID)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("task %d not found", taskID)
	}
	r := rows[0]
	tc := &taskContext{
		ID:          toInt64(r["id"]),
		Title:       rowStr(r["title"]),
		LinkedType:  rowStr(r["linked_type"]),
		LinkedID:    toInt64(r["linked_id"]),
		ContactID:   toInt64(r["contact_id"]),
		DealID:      toInt64(r["deal_id"]),
		ContactCIF:  rowStr(r["contact_cif"]),
		AssignedTo:  toInt64(r["assigned_to"]),
		ContactName: strings.TrimSpace(rowStr(r["contact_name"])),
	}
	if d, ok := r["due_date"].(time.Time); ok {
		tc.DueDate = &d
	}
	return tc, nil
}

// taskActionURL is the deep link for a task: the record it concerns, with the task
// modal opened over it. Ordering is most-specific-first — an explicit linked_type
// beats an inferred one, and a converted lead routes to the customer book rather than
// back to the lead queue it has already left.
func taskActionURL(tc *taskContext) string {
	suffix := fmt.Sprintf("?task=%d", tc.ID)

	switch strings.ToLower(tc.LinkedType) {
	case "customer", "cif":
		if tc.LinkedID > 0 || tc.ContactCIF != "" {
			cif := tc.ContactCIF
			if cif == "" {
				// linked_id is numeric; CIFs are zero-padded 8-digit keys.
				cif = fmt.Sprintf("%08d", tc.LinkedID)
			}
			return "/sales/book/" + cif + suffix
		}
	case "loan_application", "application":
		if tc.LinkedID > 0 {
			return fmt.Sprintf("/sales/applications/%d%s", tc.LinkedID, suffix)
		}
	case "deal":
		if tc.LinkedID > 0 {
			return "/sales/crm" + suffix
		}
	}

	if tc.ContactCIF != "" {
		return "/sales/book/" + tc.ContactCIF + suffix
	}
	if tc.DealID > 0 {
		return "/sales/crm" + suffix
	}
	if tc.ContactID > 0 {
		return "/sales/leads" + suffix
	}
	// Nothing to anchor to — the list is still a valid destination, and the modal
	// opens over it just the same.
	return "/sales/tasks" + suffix
}

// getTask returns one task with enough context for the modal to title itself and to
// offer a way through to the record. Reached by ?task=<id> from any page in the app,
// including pages that have no task list of their own.
func getTask(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := toInt64FromStr(strings.TrimSpace(chi.URLParam(r, "id")))
		if id <= 0 {
			respondErr(w, 400, "task id must be a number")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT t.*,
			       a.full_name  AS assignee_name,
			       cr.full_name AS creator_name,
			       TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')) AS contact_name,
			       COALESCE(c.converted_cif,'') AS contact_cif,
			       d.title AS deal_title
			  FROM crm_tasks t
			  LEFT JOIN o3c_users   a  ON a.id  = t.assigned_to
			  LEFT JOIN o3c_users   cr ON cr.id = t.created_by
			  LEFT JOIN crm_contacts c ON c.id  = t.contact_id
			  LEFT JOIN crm_deals    d ON d.id  = t.deal_id
			 WHERE t.id = $1`, id)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		if len(rows) == 0 {
			respondErr(w, 404, "Task not found")
			return
		}
		out := rows[0]
		// The modal needs to know where "open the record" goes, and the routing rules
		// live here rather than being re-derived in TypeScript from half the columns.
		if tc, err := loadTaskContext(r.Context(), db, id); err == nil {
			out["action_url"] = taskActionURL(tc)
		}
		respond(w, out, "pg")
	}
}

// taskNotifyURL resolves a task's deep link for a notification, degrading to the task
// list if the lookup fails. Used by the hourly due-soon/overdue sweep, which already
// had its own dedupe and did not need a second worker beside it — it only needed a
// link that goes somewhere.
func taskNotifyURL(ctx context.Context, db *core.DB, taskID int64) string {
	if tc, err := loadTaskContext(ctx, db, taskID); err == nil {
		return taskActionURL(tc)
	}
	return fmt.Sprintf("/sales/tasks?task=%d", taskID)
}

// notifyTaskAssigned tells someone a task is theirs, pointing at the record rather
// than at a list. Best-effort: a routing failure must not fail the write that
// triggered it, so the caller runs this in a goroutine and errors degrade to the
// plain task list.
func notifyTaskAssigned(ctx context.Context, db *core.DB, taskID, assignee int64, title string) {
	url := fmt.Sprintf("/sales/tasks?task=%d", taskID)
	body := fmt.Sprintf("%q has been assigned to you", title)
	if tc, err := loadTaskContext(ctx, db, taskID); err == nil {
		url = taskActionURL(tc)
		if tc.ContactName != "" {
			body = fmt.Sprintf("%q — %s", title, tc.ContactName)
		}
	}
	Notify(ctx, db, NotifPayload{
		EventType: EvtTaskAssigned,
		UserID:    assignee,
		Title:     "Task assigned to you",
		Body:      body,
		ActionURL: url,
		EntityRef: fmt.Sprintf("task:%d", taskID),
	})
}

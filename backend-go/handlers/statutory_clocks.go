package handlers

import (
	"context"
	"fmt"
	"time"

	"github.com/o3c/workspace/core"
)

/*
STATUTORY CLOCKS — the two deadlines in this product that a regulator sets.

WHY THIS EXISTS. Both were being measured and neither was being watched.

	data_breach_incidents.notify_deadline_at  Set by a trigger to discovered_at + 72
	                                          hours, which is the NDPC notification
	                                          window. Read by exactly one thing in the
	                                          codebase: a column in a report dataset.
	                                          Somebody had to think to run a report.

	data_subject_requests.sla_due_at          Written once when the request is created
	                                          (handlers/compliance.go) and then read by
	                                          NOTHING AT ALL — not a list ordering, not
	                                          a page figure, not an alarm. A statutory
	                                          response clock that was set and never
	                                          looked at again.

Neither table has a row today, which is the argument for building this rather than
against it: the first breach is precisely the moment you cannot afford to discover that
nothing was watching. A missed 72-hour notification is a regulatory finding, not a
backlog item, and it cannot be fixed retrospectively.

WHY THIS ONE REPEATS, WHEN THE HOUSE RULE IS FRESH-ONLY DIGESTS. Every other alert in
this codebase fires on what has just changed, because a backlog that alarms daily stops
being read. A statutory deadline is the exception and deliberately nags until somebody
acts: the alternative is alerting only on the poll that happens to straddle the
threshold, and then a restart or a slow tick loses the alarm permanently. GroupKey still
does the work — one live bell row per incident per phase, updated in place, with email
suppressed after the first — so repeating costs one row, not one row per sweep.

TWO PHASES, BECAUSE THEY ARE DIFFERENT NEWS. "Due within a day" is work to schedule;
"past the deadline" is an incident to escalate and report. They carry different
priorities and different keys so the second does not collapse into the first.

WHO HEARS. The assignee, through NotifyHolder, so that an assignee who is away has their
cover copied rather than the clock running into an empty inbox — the whole point of that
helper. And the compliance role regardless, because a statutory deadline is the
company's exposure and not only one person's task; NotifyRoles always copies admin.
*/

// statutoryClockPeriod — fifteen minutes. The 72-hour window does not need a tighter
// loop than that, and a slower one would let the "within 24 hours" warning land too
// late to be actionable.
const statutoryClockPeriod = 15 * time.Minute

// StartStatutoryClockWorker watches the deadlines a regulator set.
func StartStatutoryClockWorker(db *core.DB) {
	for {
		runStatutoryClocks(db)
		time.Sleep(statutoryClockPeriod)
	}
}

func runStatutoryClocks(db *core.DB) {
	ctx := context.Background()
	WorkerBeat(ctx, db, "statutory_clocks", "running", "", "")
	n := sweepBreachDeadlines(ctx, db) + sweepDSARDeadlines(ctx, db)
	WorkerBeat(ctx, db, "statutory_clocks", "ok",
		fmt.Sprintf("%d statutory deadline(s) inside a day or already past", n), "")
}

// sweepBreachDeadlines — NDPC must be notified within 72 hours of discovery.
//
// ndpc_notified is the thing that stops the clock, NOT the status: an incident can be
// remediated and still unreported, which is the worse of the two failures. So the filter
// is on ndpc_notified, and a closed incident that was never notified keeps alarming
// because that is a fact somebody has to answer for.
func sweepBreachDeadlines(ctx context.Context, db *core.DB) int {
	rows, err := db.PGQuery(ctx, `
		SELECT id, ref_no, title, severity, assigned_to,
		       notify_deadline_at,
		       (notify_deadline_at < NOW()) AS past_due,
		       GREATEST(0, ROUND(EXTRACT(EPOCH FROM (notify_deadline_at - NOW())) / 3600))::int AS hours_left,
		       GREATEST(0, ROUND(EXTRACT(EPOCH FROM (NOW() - notify_deadline_at)) / 3600))::int AS hours_over
		  FROM app.data_breach_incidents
		 WHERE NOT ndpc_notified
		   AND notify_deadline_at < NOW() + interval '24 hours'
		 ORDER BY notify_deadline_at`)
	if err != nil {
		return 0
	}
	for _, row := range rows {
		id := toInt64(row["id"])
		ref := str(row["ref_no"])
		past := row["past_due"] == true

		phase, title, prio := "warn", "", "high"
		body := fmt.Sprintf("%s (%s) must be reported to the NDPC within %d hour(s). Notify them, then record the NDPC reference on the incident.",
			ref, str(row["severity"]), toInt64(row["hours_left"]))
		title = "NDPC deadline approaching: " + ref
		if past {
			phase, prio = "breach", "urgent"
			title = "NDPC DEADLINE PASSED: " + ref
			body = fmt.Sprintf("%s (%s) passed its 72-hour NDPC notification deadline %d hour(s) ago and is still not recorded as notified. This is reportable in itself.",
				ref, str(row["severity"]), toInt64(row["hours_over"]))
		}

		p := NotifPayload{
			EventType: EvtBreachDeadline,
			Title:     title,
			Body:      body,
			ActionURL: "/compliance/breach-incidents",
			EntityRef: fmt.Sprintf("data_breach_incident:%d", id),
			Priority:  prio,
		}
		// The holder, with their cover copied if they are away.
		if a := toInt64(row["assigned_to"]); a > 0 {
			ph := p
			ph.UserID = a
			ph.GroupKey = fmt.Sprintf("breach_deadline:%d:%s", id, phase)
			NotifyHolder(ctx, db, ph)
		}
		// And compliance, whose exposure it is whoever holds the task.
		pr := p
		pr.GroupKey = fmt.Sprintf("breach_deadline:%d:%s:compliance", id, phase)
		NotifyRoles(ctx, db, []string{"compliance_officer", "compliance_head", "internal_control_head"}, pr)
	}
	return len(rows)
}

// sweepDSARDeadlines — a data subject's request has a response window.
//
// The status vocabulary is pending | in_progress | resolved | rejected, taken from the
// CHECK constraint rather than guessed: an earlier draft of this filter excluded
// 'completed' and 'closed', neither of which this column can ever hold, which would
// have made the sweep look correct and match everything.
func sweepDSARDeadlines(ctx context.Context, db *core.DB) int {
	rows, err := db.PGQuery(ctx, `
		SELECT id, request_type, subject_name, status, assigned_to,
		       sla_due_at,
		       (sla_due_at < NOW()) AS past_due,
		       GREATEST(0, ROUND(EXTRACT(EPOCH FROM (sla_due_at - NOW())) / 3600))::int AS hours_left,
		       GREATEST(0, ROUND(EXTRACT(EPOCH FROM (NOW() - sla_due_at)) / 86400))::int  AS days_over
		  FROM app.data_subject_requests
		 WHERE status IN ('pending', 'in_progress')
		   AND sla_due_at IS NOT NULL
		   AND sla_due_at < NOW() + interval '24 hours'
		 ORDER BY sla_due_at`)
	if err != nil {
		return 0
	}
	for _, row := range rows {
		id := toInt64(row["id"])
		who := str(row["subject_name"])
		if who == "" {
			who = "A data subject"
		}
		kind := str(row["request_type"])
		past := row["past_due"] == true

		phase, prio := "warn", "high"
		title := "Data subject request due: " + kind
		body := fmt.Sprintf("%s made a %s request and the response window closes in %d hour(s).",
			who, kind, toInt64(row["hours_left"]))
		if past {
			phase, prio = "breach", "urgent"
			title = "Data subject request OVERDUE: " + kind
			body = fmt.Sprintf("%s made a %s request and the statutory response window closed %d day(s) ago.",
				who, kind, toInt64(row["days_over"]))
		}

		p := NotifPayload{
			EventType: EvtDSARDeadline,
			Title:     title,
			Body:      body,
			ActionURL: "/compliance/data-subject-requests",
			EntityRef: fmt.Sprintf("data_subject_request:%d", id),
			Priority:  prio,
		}
		if a := toInt64(row["assigned_to"]); a > 0 {
			ph := p
			ph.UserID = a
			ph.GroupKey = fmt.Sprintf("dsar_deadline:%d:%s", id, phase)
			NotifyHolder(ctx, db, ph)
		}
		pr := p
		pr.GroupKey = fmt.Sprintf("dsar_deadline:%d:%s:compliance", id, phase)
		NotifyRoles(ctx, db, []string{"compliance_officer", "compliance_head", "internal_control_head"}, pr)
	}
	return len(rows)
}

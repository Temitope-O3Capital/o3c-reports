package handlers

import (
	"fmt"
	"net/http"

	"github.com/o3c/workspace/core"
)

// The "Other" review — the loop that keeps the escape hatch a backlog instead of a bin.
//
// WHY THIS EXISTS. "Other — Describe What Happened" was added on 2026-09-28 with a mandatory
// written explanation, and the whole argument for offering it at all was that what agents write
// there becomes the NEXT named disposition. That argument only holds if somebody reads it.
//
// It has already paid out once. Eleven real uses in the first two days, read by hand on
// 29 Sept, produced three outcomes the vocabulary could not previously say:
// registration_incomplete, payment_to_verify and not_yet_due — plus the discovery that a
// SUPPORT call had recorded "PAYING IN 2WEEKS TIME" with nowhere to put it, which is why
// Promise to Pay is now offered on support calls too.
//
// That read was a hand-written SQL query nobody else could run. This endpoint is the same
// question, on a screen, so the loop does not depend on one person remembering:
//
//   * the RATE — Other as a share of dispositioned calls, which is the number that says
//     whether the vocabulary is drifting back into one bin. A climbing rate means an outcome
//     is missing; "Not Interested" absorbed 130 of 466 notes before anyone noticed.
//   * the NOTES themselves, newest first, with purpose and agent, because the wording is the
//     evidence. Three of the notes above named the same missing outcome in three different
//     ways, and only reading them together showed it.
//   * per-agent counts, which distinguish "the vocabulary has a gap" from "one agent reaches
//     for Other instead of reading the list".
//
// Supervisor-gated like every other analytic here (ccIsSupervisor = page call_center_stats,
// call_center_head, or management).

func ccOtherReview(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !ccIsSupervisor(core.UserFromCtx(r.Context())) {
			respondErr(w, 403, "Supervisors only")
			return
		}
		dateFrom, _ := validDate(r, "date_from")
		dateTo, _ := validDate(r, "date_to")

		// merged_into_call_id IS NULL and voided_at IS NULL are not optional here. A Zoho
		// dialling episode lands as several legs and the write-up is merged onto one of them;
		// counting the merged shadows double-counts every note. Reading these by hand on
		// 29 Sept without this filter reported 20 uses when the real figure was 11, and the
		// duplicates looked convincingly like agents logging the same call twice.
		where := "c.voided_at IS NULL AND c.merged_into_call_id IS NULL"
		var args []any
		n := 1
		if dateFrom != "" {
			where += fmt.Sprintf(" AND c.started_at::date >= $%d::date", n)
			args = append(args, dateFrom)
			n++
		}
		if dateTo != "" {
			where += fmt.Sprintf(" AND c.started_at::date <= $%d::date", n)
			args = append(args, dateTo)
			n++
		}
		_ = n

		// The rate, over calls that carry ANY disposition. Denominator excludes blanks
		// deliberately: an un-dispositioned call is an unfinished log, not a vote for Other,
		// and including 150k of them would bury the signal this number exists to show.
		rate, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT COUNT(*) FILTER (WHERE c.disposition LIKE 'Other%%') AS other_calls,
			       COUNT(*)                                                                      AS dispositioned_calls,
			       ROUND(100.0 * COUNT(*) FILTER (WHERE c.disposition LIKE 'Other%%')
			                   / NULLIF(COUNT(*), 0), 1)                                         AS other_pct
			  FROM app.helpdesk_calls c
			 WHERE %s AND COALESCE(NULLIF(TRIM(c.disposition), ''), '') <> ''`, where), args...)
		if err != nil {
			respondErrLog(w, 500, "Could not compute the Other rate", err)
			return
		}

		// The notes. This is the actual backlog — read top to bottom, clusters are the next
		// named outcome. resolution is included because the form offers a second field and an
		// agent may have put the substance there.
		notes, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT c.id,
			       c.started_at,
			       COALESCE(NULLIF(TRIM(c.purpose), ''), 'unspecified') AS purpose,
			       COALESCE(c.agent_name, '')                           AS agent_name,
			       COALESCE(c.customer_name, '')                        AS customer_name,
			       COALESCE(NULLIF(TRIM(c.notes), ''), '')              AS notes,
			       COALESCE(NULLIF(TRIM(c.resolution), ''), '')         AS resolution
			  FROM app.helpdesk_calls c
			 WHERE %s AND c.disposition LIKE 'Other%%'
			 ORDER BY c.started_at DESC
			 LIMIT 300`, where), args...)
		if err != nil {
			respondErrLog(w, 500, "Could not load the Other notes", err)
			return
		}

		// Per agent, so a vocabulary gap is distinguishable from one person's habit.
		byAgent, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT COALESCE(NULLIF(TRIM(c.agent_name), ''), 'Unattributed') AS agent_name,
			       COUNT(*) FILTER (WHERE c.disposition LIKE 'Other%%') AS other_calls,
			       COUNT(*)                                                                      AS dispositioned_calls,
			       ROUND(100.0 * COUNT(*) FILTER (WHERE c.disposition LIKE 'Other%%')
			                   / NULLIF(COUNT(*), 0), 1)                                         AS other_pct
			  FROM app.helpdesk_calls c
			 WHERE %s AND COALESCE(NULLIF(TRIM(c.disposition), ''), '') <> ''
			 GROUP BY 1
			HAVING COUNT(*) FILTER (WHERE c.disposition LIKE 'Other%%') > 0
			 ORDER BY other_calls DESC, agent_name`, where), args...)
		if err != nil {
			respondErrLog(w, 500, "Could not group the Other notes by agent", err)
			return
		}

		out := map[string]any{"notes": notes, "by_agent": byAgent}
		if len(rate) > 0 {
			out["other_calls"] = rate[0]["other_calls"]
			out["dispositioned_calls"] = rate[0]["dispositioned_calls"]
			out["other_pct"] = rate[0]["other_pct"]
		}
		writeJSON(w, out)
	}
}

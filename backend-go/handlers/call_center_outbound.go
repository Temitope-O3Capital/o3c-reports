package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

// StartCallbackReminderWorker alerts an agent when a call-back they scheduled comes
// due. Every minute it finds pending callbacks whose time has arrived and that haven't
// been alerted yet, pushes an in-app + email notification to the assigned agent, and
// stamps callback_notified_at so the alarm fires exactly once per callback.
func StartCallbackReminderWorker(db *core.DB) {
	run := func() {
		// On the CYCLE, not the ticker goroutine: a panic here ends this cycle and the
		// loop runs again in a minute. Without it one malformed row killed the worker
		// for the life of the process while WorkerBeat left the hub showing "running"
		// forever — the alarm stops and nothing says so.
		defer recoverPanic("callback_reminders")
		ctx := context.Background()
		WorkerBeat(ctx, db, "callback_reminders", "running", "", "")
		// Stamp every freshly-due call-back as alerted in ONE atomic step and get back
		// exactly the ones that flipped this cycle. The NOT EXISTS makes it self-clearing:
		// a call-back already returned (a call at/after its due time) is never alerted,
		// so a logged call-back can't ping. callback_notified_at guarantees once-per.
		freshRows, err := db.PGQuery(ctx, `
			UPDATE call_center_contacts c SET callback_notified_at=NOW()
			 WHERE status='pending' AND assigned_to IS NOT NULL
			   AND callback_at IS NOT NULL AND callback_at <= NOW()
			   AND callback_notified_at IS NULL
			   AND NOT EXISTS (
			     SELECT 1 FROM helpdesk_calls h
			      WHERE norm_phone(h.customer_phone) = norm_phone(c.phone)
			        AND h.merged_into_call_id IS NULL AND h.voided_at IS NULL
			        AND h.started_at >= c.callback_at)
			 RETURNING assigned_to`)
		if err != nil {
			WorkerBeat(ctx, db, "callback_reminders", "error", err.Error(), err.Error())
			return
		}
		// One collapsing digest per agent with newly-due call-backs — NOT one ping per
		// call-back (which piled ~3,500 unread across the floor). The bottom-right
		// Call-back popup is where an agent works the individual list; the bell just
		// says how many are waiting, and the GroupKey upsert updates that in place.
		perAgent := map[int64]bool{}
		for _, r := range freshRows {
			if a := toInt64(r["assigned_to"]); a > 0 {
				perAgent[a] = true
			}
		}
		for agentID := range perAgent {
			due := ccDueCallbackCount(ctx, db, agentID)
			if due == 0 {
				continue
			}
			Notify(context.WithoutCancel(ctx), db, NotifPayload{
				EventType: EvtCallbackDue,
				UserID:    agentID,
				Title:     fmt.Sprintf("%d call-back(s) due now", due),
				Body:      fmt.Sprintf("%d of your scheduled call-backs are due. Open the queue to return them.", due),
				ActionURL: "/call-center/queue?bucket=ready",
				EntityRef: "callback:due",
				GroupKey:  "callback:due:agent",
				Priority:  "high", // stands out in the bell — it's an alarm
			})
		}

		// NO auto-snooze. The "due" query already keeps an un-dialled call-back
		// surfacing (callback_at <= NOW() AND not called since) at its REAL scheduled
		// time, until the agent logs the call. The old code instead rewrote callback_at
		// to NOW()+10min every cycle — which corrupted the scheduled time into a rolling
		// "now" and re-fired the alarm endlessly.
		WorkerBeat(ctx, db, "callback_reminders", "ok", fmt.Sprintf("%d agent(s) alerted", len(perAgent)), "")
	}
	run()
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		run()
	}
}

// ccDueCallbackCount counts an agent's queue call-backs that are due now and still
// need the call — the same actionable set the popup shows, so the bell digest number
// matches what the agent finds when they open the queue. Self-clearing: a call-back
// already returned (a call at/after its due time) does not count.
func ccDueCallbackCount(ctx context.Context, db *core.DB, agentID int64) int {
	rows, _ := db.PGQuery(ctx, `
		SELECT COUNT(*) AS n
		  FROM call_center_contacts c
		 WHERE c.status='pending' AND c.assigned_to = $1
		   AND c.callback_at IS NOT NULL AND c.callback_at <= NOW()
		   AND (c.last_called_at IS NULL OR c.last_called_at < c.callback_at)
		   AND NOT EXISTS (
		     SELECT 1 FROM helpdesk_calls h
		      WHERE norm_phone(h.customer_phone) = norm_phone(c.phone)
		        AND h.merged_into_call_id IS NULL AND h.voided_at IS NULL
		        AND h.started_at >= c.callback_at)`, agentID)
	if len(rows) > 0 {
		return int(toInt64(rows[0]["n"]))
	}
	return 0
}

// ensureCCContactColumns adds provenance columns so the queue can distinguish
// where each contact came from (zoho_crm | collections | manual | support) and
// link back to a source record (e.g. a support ticket ref). Idempotent.
func ensureCCContactColumns(db *core.DB) {
	ctx := context.Background()
	for _, s := range []string{
		`ALTER TABLE call_center_contacts ADD COLUMN IF NOT EXISTS source TEXT`,
		`ALTER TABLE call_center_contacts ADD COLUMN IF NOT EXISTS ref TEXT`,
		`ALTER TABLE call_center_contacts ADD COLUMN IF NOT EXISTS state TEXT`,
		// Call-derived counters (migration 144). Declared here too so the queue
		// handlers cannot query a column the migration has not yet created.
		`ALTER TABLE call_center_contacts ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE call_center_contacts ADD COLUMN IF NOT EXISTS connects INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE call_center_contacts ADD COLUMN IF NOT EXISTS last_call_outcome TEXT`,
	} {
		db.PGExec(ctx, s) //nolint:errcheck
	}
}

// ccStampQueueForPhone refreshes the outbound queue's call-derived counters for one
// number, and is the live half of migration 144: the migration backfilled history,
// this keeps it true as calls arrive.
//
// It RECOMPUTES from helpdesk_calls rather than incrementing. The Zoho Desk importer
// re-upserts calls it has already seen on every hourly deep reconcile, so an increment
// would count the same call again on each sweep and inflate attempts without limit.
// Recomputing is idempotent, which matters more here than the saved row scan — and the
// scan is cheap, both sides of the match are indexed on norm_phone.
func ccStampQueueForPhone(ctx context.Context, db *core.DB, phone string) {
	if strings.TrimSpace(phone) == "" {
		return
	}
	if _, err := db.PGExec(ctx,
		`UPDATE call_center_contacts c
		    SET attempts          = t.n,
		        connects          = t.conn,
		        last_called_at    = t.last_at,
		        last_call_outcome = t.last_outcome,
		        -- A scheduled call-back is fulfilled the moment a call actually lands at
		        -- or after its due time, no matter which path logged it (in-queue log,
		        -- Zoho Desk sync, manual). Clearing it here is what stops a called-back
		        -- number lingering forever in the "callback due" / ready bucket.
		        callback_at       = CASE WHEN c.callback_at IS NOT NULL AND t.last_at >= c.callback_at
		                                 THEN NULL ELSE c.callback_at END,
		        -- Drop the alarm stamp with the call-back it belonged to. The reminder
		        -- worker only ever fires where callback_notified_at IS NULL, so leaving a
		        -- fulfilled call-back's stamp behind is half of why a contact's SECOND
		        -- call-back never alerted anyone.
		        callback_notified_at = CASE WHEN c.callback_at IS NOT NULL AND t.last_at >= c.callback_at
		                                    THEN NULL ELSE c.callback_notified_at END,
		        updated_at        = NOW()
		   FROM (
		     SELECT COUNT(*)                                            AS n,
		            COUNT(*) FILTER (WHERE outcome = 'completed')        AS conn,
		            MAX(started_at)                                      AS last_at,
		            (ARRAY_AGG(NULLIF(outcome,'') ORDER BY started_at DESC))[1] AS last_outcome
		       FROM helpdesk_calls
		      WHERE norm_phone(customer_phone) = norm_phone($1)
		        AND merged_into_call_id IS NULL AND voided_at IS NULL
		   ) t
		  WHERE norm_phone(c.phone) = norm_phone($1)
		    AND length(norm_phone($1)) = 10`, phone); err != nil {
		slog.Error("ccStampQueueForPhone: refresh queue counters", "err", err)
	}

	// The LEAD book gets the same treatment, from the same ledger, in the same call.
	// Migration 254 gave call_center_leads the attempts/connects columns and seeded
	// them; without this they would be a one-off snapshot that silently went stale,
	// and the workable predicate below (which decides what may be redistributed)
	// reads them. Every path that logs a call already funnels through here — the
	// in-queue log, the Leads form via helpdesk, and the Zoho Desk sync — so this is
	// the one place that keeps both books honest.
	//
	// RECOMPUTED, never incremented, for the same reason as above: the Zoho importer
	// re-upserts calls it has already seen on every deep reconcile, so an increment
	// would inflate the counters without limit on each sweep.
	if _, err := db.PGExec(ctx,
		`UPDATE call_center_leads l
		    SET attempts = t.n,
		        connects = t.conn,
		        updated_at = NOW()
		   FROM (
		     SELECT COUNT(*)                                     AS n,
		            COUNT(*) FILTER (WHERE outcome = 'completed') AS conn
		       FROM helpdesk_calls
		      WHERE norm_phone(customer_phone) = norm_phone($1)
		        AND direction = 'outbound'
		        AND merged_into_call_id IS NULL AND voided_at IS NULL
		   ) t
		  WHERE norm_phone(l.customer_phone) = norm_phone($1)
		    AND length(norm_phone($1)) = 10
		    AND (l.attempts, l.connects) IS DISTINCT FROM (t.n, t.conn)`, phone); err != nil {
		slog.Error("ccStampQueueForPhone: refresh lead counters", "err", err)
	}
}

// ccNotOnDNCExpr renders "this number is not on the Do Not Call list", for a phone
// column or expression.
//
// Six separate suppression checks had drifted into three different shapes — three
// compared app.norm_phone()'s form against the RAW stored value, two compared raw
// text to raw text — and not one of them could match a listed number, because the
// column held whatever the agent typed ('+2348033153664' vs '08033153664'). The
// list suppressed nothing. Migration 254 normalised the column; this makes every
// reader compare the same way, through one expression rather than six copies.
//
// The length()=10 guard is load-bearing, not tidiness: app.norm_phone returns ''
// (never NULL) for anything it cannot parse, so a bare equality is TRUE when both
// sides are blank — which would suppress every contact with no phone on file.
func ccNotOnDNCExpr(phoneCol string) string {
	return `NOT EXISTS (SELECT 1 FROM dnc_list d
	                     WHERE norm_phone(d.phone) = norm_phone(` + phoneCol + `)
	                       AND length(norm_phone(d.phone)) = 10)`
}

// ccLeadWorkableExpr renders "this lead is worth handing to an agent": not already
// worked to a conclusion, not resting inside the cool-down, and not past the attempt
// cap with nothing to show for it. alias is the table alias ("" for a bare table).
//
// Assignment, distribution and recall all filtered status='pending', but the FIRST
// dial moves a lead to 'no_answer' or 'called' permanently — so a lead could be
// handed out exactly once and then never again, by anyone. 9,126 of 13,042 leads
// were stuck at 'no_answer', unreachable by every supervisor action on the page.
//
// The queue has always had this discipline (ccCooldownDays / ccExhaustedAttempts);
// migration 254 gave the lead book the counters needed to share it, so an unreached
// lead recycles after the cool-down while an exhausted one stops costing agent time.
//
// 'called' is deliberately NOT workable. leadStatusFromCall files "Not Interested"
// under 'called', so recycling it would put people who have already declined back
// on the dialler. 'interested' and 'callback' are excluded for the opposite reason:
// they are live, owned work awaiting a forward or a promised time.
func ccLeadWorkableExpr(alias string) string {
	p := ""
	if alias != "" {
		p = alias + "."
	}
	return fmt.Sprintf(`(%[1]sstatus IN ('pending','no_answer','not_ready')
	     AND (%[1]slast_called_at IS NULL
	          OR %[1]slast_called_at <= NOW() - INTERVAL '%[2]d days')
	     AND NOT (COALESCE(%[1]sattempts,0) >= %[3]d AND COALESCE(%[1]sconnects,0) = 0))`,
		p, ccCooldownDays, ccExhaustedAttempts)
}

func RegisterCallCenterOutbound(r chi.Router, db *core.DB) {
	// Gating is applied once by the /api/call-center group in main.go.
	ensureCCContactColumns(db)

	// Campaigns
	r.Get("/campaigns", ccListCampaigns(db))
	r.Post("/campaigns", ccCreateCampaign(db))

	// Agents (for assignment UI)
	r.Get("/agents", ccListAgents(db))

	// Leads
	r.Get("/leads", ccListLeads(db))
	r.Post("/leads", ccCreateLead(db))
	r.Post("/leads/import", ccImportLeads(db)) // bulk upload a lead list (heads)
	r.Post("/leads/bulk-assign", ccBulkAssign(db))
	r.Post("/leads/assign-batch", ccAssignLeadsBatch(db)) // count-based assign to one agent (parity with the queue)
	r.Post("/leads/distribute", ccDistribute(db))
	r.Get("/leads/team", ccLeadsTeam(db))      // supervisor's live per-agent workload + floor totals
	r.Post("/leads/recall", ccRecallLeads(db)) // undo a distribution — pull handed-out pending leads back to the pool
	r.Patch("/leads/{id}", ccUpdateLead(db))
	r.Get("/leads/{id}/calls", ccLeadCalls(db)) // this lead's call history (so a logged call is visible here)
	r.Post("/leads/{id}/forward", forwardLeadToSales(db)) // hand a worked lead to Sales (agents: own leads; heads: any)

	// Sales hand-off tracker — agents see their own forwards; supervisors the floor.
	r.Get("/forwards", ccListForwards(db))
	r.Get("/forwards/summary", ccForwardsSummary(db))

	// Call-back reminders — the agent's due call-backs (feeds the pop-up) + snooze.
	r.Get("/callbacks/due", ccMyCallbacksDue(db))
	r.Post("/callbacks/{id}/snooze", ccSnoozeCallback(db))
	// The lead-only disposition endpoint has been removed. Logging a call from the
	// Leads page now goes through POST /api/helpdesk/calls with a lead_id, the same
	// write every other screen uses, and the lead is advanced by syncLeadFromCall.
	// Two endpoints meant a lead call captured no CIF, no disposition and no ticket.

	// Stats
	r.Get("/stats", ccStats(db))

	// Outbound queue (contacts + call logs)
	r.Get("/queue", ccListQueue(db))
	r.Post("/queue/sync-from-crm", ccSyncQueueFromCRM(db))   // marketing leads (Zoho CRM)
	r.Post("/queue/sync-collections", ccSyncCollections(db)) // collections (overdue accounts)
	r.Post("/queue/import", ccImportContacts(db))            // manual / CSV upload
	r.Post("/queue/add-callback", ccAddCallback(db))         // support call-back (from a ticket/customer)
	r.Post("/queue/assign-batch", ccAssignBatch(db))
	r.Post("/queue/distribute", ccDistributeQueue(db)) // round-robin the whole pool
	r.Post("/queue/bulk-skip", ccBulkSkip(db))
	r.Get("/queue/team", ccQueueTeam(db)) // supervisor's live per-agent dialer workload + floor totals
	r.Get("/contacts/{id}/calls", ccContactCalls(db))
	r.Post("/contacts/{id}/log-call", ccLogCall(db))
	r.Get("/dispositions", ccListDispositions()) // canonical outcome vocabulary

	// Agent presence heartbeat — the workspace pings while open (auto-online) and
	// beacons on close (auto-offline); powers "distribute to online agents".
	r.Post("/presence/ping", ccPresencePing(db))
	r.Post("/presence/offline", ccPresenceOffline(db))

	// Inbound — 53% of inbound calls go unanswered and had no follow-up path at all.
	r.Get("/inbound", ccInboundList(db))
	r.Get("/inbound/{id}/ring-legs", ccInboundRingLegs(db)) // per-agent ring sequence of a queued call
	r.Post("/inbound/queue-callbacks", ccQueueMissedCallbacks(db))
	r.Post("/inbound/{id}/ticket", ccInboundToTicket(db))

	// Performance analytics
	r.Get("/performance-kpis", ccPerformanceKPIs(db))
	r.Get("/by-disposition", ccByDisposition(db))
	r.Get("/hourly-volume", ccHourlyVolume(db))
	r.Get("/agent-performance", ccAgentPerformance(db))

	// DNC
	r.Get("/dnc", ccListDNC(db))
	r.Post("/dnc", ccAddDNC(db))
	r.Delete("/dnc/{id}", ccRemoveDNC(db))
	r.Get("/dnc-kpis", ccDNCKPIs(db))
	r.Post("/dnc/bulk-remove", ccBulkRemoveDNC(db))
}

func ccListCampaigns(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT c.id, c.name, c.status, c.purpose, c.target_segment, c.start_date, c.end_date,
			       c.created_at,
			       COUNT(l.id)                                      AS total_leads,
			       COUNT(l.id) FILTER (WHERE l.status = 'converted') AS converted
			FROM call_center_campaigns c
			LEFT JOIN call_center_leads l ON l.campaign_id = c.id
			GROUP BY c.id
			ORDER BY c.created_at DESC`)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		jsonRows(w, rows)
	}
}

func ccCreateCampaign(db *core.DB) http.HandlerFunc {
	type body struct {
		Name          string  `json:"name"`
		Status        string  `json:"status"`
		Purpose       string  `json:"purpose"`
		TargetSegment *string `json:"target_segment"`
		StartDate     *string `json:"start_date"`
		EndDate       *string `json:"end_date"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil || b.Name == "" {
			respondErr(w, 400, "name is required")
			return
		}
		if b.Status == "" {
			b.Status = "active"
		}
		switch b.Purpose {
		case "", "collections", "marketing", "support", "retention", "other":
			// ok (empty allowed — campaign purpose can be set later)
		default:
			respondErr(w, 400, "invalid purpose (collections|marketing|support|retention|other)")
			return
		}
		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(),
			`INSERT INTO call_center_campaigns (name, status, purpose, target_segment, start_date, end_date, created_by)
			 VALUES ($1,$2,NULLIF($3,''),$4,$5,$6,$7) RETURNING *`,
			b.Name, b.Status, b.Purpose, b.TargetSegment, b.StartDate, b.EndDate, user.ID)
		if err != nil {
			respondErr(w, 500, "Insert failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func ccListLeads(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		campaignID := qstr(r, "campaign_id")
		status := qstr(r, "status")
		agentID := qstr(r, "agent_id")
		search := qstr(r, "search")
		limit := qint(r, "limit", 50, 1, 500)
		offset := qint(r, "offset", 0, 0, 100_000_000)

		// Scope = every filter EXCEPT status. The mini status-breakdown cards read this
		// scope, so clicking a status chip narrows the list without zeroing the other
		// cards. The list + count add the status filter on top of the scope.
		//
		// A listed number is never served from the lead book. This check did not exist
		// here at all — only the outbound queue filtered DNC — so a customer who opted
		// out still appeared in an agent's Leads list and was dialled from it. Applied
		// to the scope so the list, the count and the status tiles all agree.
		scopeCond := " AND " + ccNotOnDNCExpr("l.customer_phone")
		var scopeArgs []any
		n := 1

		// An agent sees only her own assigned leads; heads (call_center_stats) and the
		// exec see-all roles see everyone's and can distribute/assign.
		if user := core.UserFromCtx(r.Context()); user != nil && !user.HasPage("call_center_stats") && !user.CanSeeAllRows() {
			scopeCond += fmt.Sprintf(" AND l.assigned_to=$%d", n)
			scopeArgs = append(scopeArgs, user.ID)
			n++
		}
		if campaignID != "" {
			scopeCond += fmt.Sprintf(" AND l.campaign_id=$%d", n)
			scopeArgs = append(scopeArgs, campaignID)
			n++
		}
		if agentID != "" {
			scopeCond += fmt.Sprintf(" AND l.assigned_to=$%d", n)
			scopeArgs = append(scopeArgs, agentID)
			n++
		}
		if search != "" {
			if clause, sargs, nn := buildCustomerSearch(search,
				[]string{"l.customer_name", "l.customer_phone", "l.employer"}, "l.customer_phone", n); clause != "" {
				scopeCond += " AND " + clause
				scopeArgs = append(scopeArgs, sargs...)
				n = nn
			}
		}
		if from := qstr(r, "from"); from != "" {
			scopeCond += fmt.Sprintf(" AND l.created_at::date >= $%d::date", n)
			scopeArgs = append(scopeArgs, from)
			n++
		}
		if to := qstr(r, "to"); to != "" {
			scopeCond += fmt.Sprintf(" AND l.created_at::date <= $%d::date", n)
			scopeArgs = append(scopeArgs, to)
			n++
		}

		// The list + count add the status filter on top of the scope.
		cond := scopeCond
		args := append([]any{}, scopeArgs...)
		if status != "" {
			cond += fmt.Sprintf(" AND l.status=$%d", n)
			args = append(args, status)
			n++
		}

		var total int64
		if err := db.PG.QueryRowContext(r.Context(),
			`SELECT COUNT(*) FROM call_center_leads l WHERE 1=1`+cond, args...).Scan(&total); err != nil {
			respondErr(w, 500, "Count failed")
			return
		}

		// Status-breakdown summary over the WHOLE scope (ignores the status filter and
		// pagination) so the KPI cards show real totals, not just the current page.
		// distributable / recallable drive the Distribute / Recall buttons.
		var sumPending, sumInterested, sumCallbacks, sumConverted, sumUnassigned, sumDistributable, sumRecallable int64
		var sumCalled, sumNoAnswer, sumNotReady, sumClosed, sumInvalid, sumDNC int64
		db.PG.QueryRowContext(r.Context(), `
			SELECT
			  COUNT(*) FILTER (WHERE status='pending'),
			  COUNT(*) FILTER (WHERE status='interested'),
			  COUNT(*) FILTER (WHERE status='callback'),
			  COUNT(*) FILTER (WHERE status='converted'),
			  COUNT(*) FILTER (WHERE assigned_to IS NULL),
			  -- Distributable / recallable now mean what Distribute and Recall will
			  -- actually move, so the buttons stop promising work they cannot hand out.
			  COUNT(*) FILTER (WHERE assigned_to IS NULL AND `+ccLeadWorkableExpr("")+`),
			  COUNT(*) FILTER (WHERE assigned_to IS NOT NULL AND `+ccLeadWorkableExpr("")+`),
			  -- The rest of the vocabulary. 'called', 'no_answer', 'closed' and 'invalid'
			  -- are the MAJORITY of the book — 9,126 of 13,042 leads sit at no_answer
			  -- alone — and appeared in no tile at all, so the cards never added up to
			  -- the lead count displayed beside them.
			  COUNT(*) FILTER (WHERE status='called'),
			  COUNT(*) FILTER (WHERE status='no_answer'),
			  COUNT(*) FILTER (WHERE status='not_ready'),
			  COUNT(*) FILTER (WHERE status='closed'),
			  COUNT(*) FILTER (WHERE status='invalid'),
			  COUNT(*) FILTER (WHERE status='dnc')
			FROM call_center_leads l WHERE 1=1`+scopeCond, scopeArgs...).
			Scan(&sumPending, &sumInterested, &sumCallbacks, &sumConverted, &sumUnassigned,
				&sumDistributable, &sumRecallable,
				&sumCalled, &sumNoAnswer, &sumNotReady, &sumClosed, &sumInvalid, &sumDNC) //nolint:errcheck

		q := `SELECT l.id, l.campaign_id, l.customer_cif, l.customer_name,
		             l.customer_phone, l.employer, l.email, l.address, l.state, l.lead_score, l.status,
		             l.assigned_to, l.last_called_at, l.callback_at, l.notes,
		             l.created_at, l.updated_at, l.forwarded_at,
		             u.full_name AS agent_name,
		             c.name AS campaign_name,
		             -- "Last Outcome" used to read call_center_dispositions, which stores the
		             -- raw telephony outcome. That is how 'completed' reached the panel as a
		             -- user-facing label, and it also let the panel disagree with the call
		             -- history right beside it, which reads helpdesk_calls. Both now read the
		             -- same ledger. The agent's own disposition wins; failing that the
		             -- frontend labels the raw outcome, which needs the duration and the
		             -- recording to tell a real conversation from a dial that never landed.
		             -- call_center_dispositions stores only the raw outcome, so it can
		             -- feed last_outcome but never last_disposition.
		             NULLIF(TRIM(lc.disposition),'') AS last_disposition,
		             COALESCE(lc.outcome,
		                      (SELECT outcome FROM call_center_dispositions d
		                        WHERE d.lead_id = l.id ORDER BY d.created_at DESC LIMIT 1)) AS last_outcome,
		             lc.direction    AS last_call_direction,
		             lc.duration_sec AS last_call_duration_sec,
		             (lc.recording_filename IS NOT NULL) AS last_call_recorded
		      FROM call_center_leads l
		      LEFT JOIN o3c_users u ON u.id = l.assigned_to
		      LEFT JOIN call_center_campaigns c ON c.id = l.campaign_id
		      LEFT JOIN LATERAL (
		          SELECT h.disposition, h.outcome, h.direction, h.duration_sec, h.recording_filename
		            FROM helpdesk_calls h
		           WHERE h.lead_id = l.id AND h.merged_into_call_id IS NULL AND h.voided_at IS NULL
		           ORDER BY h.started_at DESC NULLS LAST LIMIT 1
		      ) lc ON TRUE
		      WHERE 1=1` + cond +
			// Work-queue order, so logging a call moves that lead OUT of the way — it
			// either changes status (leaving a filtered view) or, staying in the same
			// bucket, sinks to the bottom instead of floating back to the top. Was
			// `updated_at DESC`, which did the opposite: a just-worked lead jumped to the
			// top and the agent re-hit it. Order: a due call-back is a time-bound promise
			// so it leads; then never-called (NULLS FIRST); then least-recently-called
			// (ASC) so the freshly-dialled land last; score/created break ties.
			fmt.Sprintf(" ORDER BY (l.callback_at IS NOT NULL AND l.callback_at <= NOW()) DESC,"+
				" l.last_called_at ASC NULLS FIRST, l.lead_score DESC, l.created_at ASC"+
				" LIMIT $%d OFFSET $%d", n, n+1)
		rows, err := db.PGQuery(r.Context(), q, append(append([]any{}, args...), limit, offset)...)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"data": rows, "total": total, "limit": limit, "offset": offset,
			"summary": map[string]any{
				"pending":       sumPending,
				"interested":    sumInterested,
				"callbacks":     sumCallbacks,
				"converted":     sumConverted,
				"unassigned":    sumUnassigned,
				"distributable": sumDistributable, // unassigned + workable → Distribute
				"recallable":    sumRecallable,    // assigned + workable  → Recall
				// Previously uncounted, and between them most of the book.
				"called":    sumCalled,
				"no_answer": sumNoAnswer,
				"not_ready": sumNotReady,
				"closed":    sumClosed,
				"invalid":   sumInvalid,
				"dnc":       sumDNC,
			},
		})
	}
}

// ccLeadCalls returns this lead's call history from the real telephony table
// (helpdesk_calls), matched by lead_id or by the lead's phone (last-10-digits), so a
// call an agent just logged shows up in the same place they logged it. Merged manual
// duplicates are hidden (they live on the real call they enriched).
func ccLeadCalls(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		// Scope the PARENT row exactly as the list endpoint scopes its rows. Without
		// this, any lead id returned that customer's whole call history — name, number,
		// notes — to any agent, which defeats the row scoping ccListLeads applies.
		// 404 rather than 403, so the endpoint does not confirm which ids exist.
		if !ccIsSupervisor(user) {
			if own, _ := db.PGQuery(r.Context(),
				`SELECT 1 FROM call_center_leads WHERE id=$1 AND assigned_to=$2`, id, user.ID); len(own) == 0 {
				respondErr(w, 404, "Lead not found")
				return
			}
		}
		rows, err := db.PGQuery(r.Context(), `
			WITH lp AS (
			  SELECT NULLIF(right(regexp_replace(COALESCE(customer_phone,''),'\D','','g'),10),'') AS ph
			    FROM call_center_leads WHERE id = $1
			)
			SELECT h.id, h.started_at, h.direction, h.outcome, h.duration_sec,
			       COALESCE(h.agent_name,'')   AS agent_name,
			       COALESCE(h.notes,'')        AS notes,
			       COALESCE(h.disposition,'')  AS disposition,
			       COALESCE(h.resolution,'')   AS resolution,
			       h.recording_filename
			  FROM helpdesk_calls h, lp
			 WHERE (h.lead_id = $1
			        OR (lp.ph IS NOT NULL
			            AND right(regexp_replace(COALESCE(h.customer_phone,''),'\D','','g'),10) = lp.ph))
			   AND COALESCE(h.merged_into_call_id, 0) = 0 AND h.voided_at IS NULL
			 ORDER BY h.started_at DESC NULLS LAST
			 LIMIT 50`, id)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		jsonRows(w, rows)
	}
}

// ccMyCallbacksDue returns the signed-in agent's call-backs that are due now and
// still need the call — i.e. status pending, assigned to me, callback_at reached,
// and NOT dialled since it came due (once ccLogCall bumps last_called_at, the
// call-back drops out of this set, which is how the popup auto-clears on log).
func ccMyCallbacksDue(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := core.UserFromCtx(r.Context())
		if u == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		// Call-backs come from BOTH books: the outbound queue (call_center_contacts) and
		// marketing leads (call_center_leads). Each row carries its source so the popup
		// can send the agent to the right screen — a lead call-back opens the Leads page,
		// a queue call-back opens the Outbound Queue — instead of always the queue.
		// Two guards keep this an actionable alarm rather than a growing backlog:
		//   1. Self-clearing — a call-back with ANY real call at or after its due time
		//      is done, regardless of whether last_called_at got stamped. The direct
		//      EXISTS on helpdesk_calls is authoritative, so a call-back can never
		//      "linger after calling and logging it" because of a phone-format or
		//      logging-path gap (the stamp path could miss; this cannot).
		//   2. Bounded — only call-backs that came due in the last 24h alarm here. An
		//      un-dialled call-back older than a day is backlog, worked from the queue's
		//      "ready" bucket, not popped as an alarm every session.
		rows, err := db.PGQuery(r.Context(), `
			SELECT source, id, name, phone, callback_at, last_disposition, purpose FROM (
			  SELECT 'contact'::text AS source, id,
			         COALESCE(NULLIF(customer_name,''), phone) AS name, phone,
			         callback_at, COALESCE(last_disposition,'') AS last_disposition,
			         COALESCE(purpose,'') AS purpose
			    FROM call_center_contacts c
			   WHERE status='pending' AND assigned_to = $1
			     AND callback_at IS NOT NULL AND callback_at <= NOW()
			     AND callback_at >= NOW() - INTERVAL '24 hours'
			     AND (last_called_at IS NULL OR last_called_at < callback_at)
			     AND NOT EXISTS (
			       SELECT 1 FROM helpdesk_calls h
			        WHERE norm_phone(h.customer_phone) = norm_phone(c.phone)
			          AND h.merged_into_call_id IS NULL AND h.voided_at IS NULL
			          AND h.started_at >= c.callback_at)
			  UNION ALL
			  SELECT 'lead'::text AS source, id,
			         COALESCE(NULLIF(customer_name,''), customer_phone) AS name, customer_phone AS phone,
			         callback_at, '' AS last_disposition, 'marketing' AS purpose
			    FROM call_center_leads l
			   WHERE assigned_to = $1 AND status NOT IN ('converted','dnc')
			     AND callback_at IS NOT NULL AND callback_at <= NOW()
			     AND callback_at >= NOW() - INTERVAL '24 hours'
			     AND (last_called_at IS NULL OR last_called_at < callback_at)
			     AND NOT EXISTS (
			       SELECT 1 FROM helpdesk_calls h
			        WHERE norm_phone(h.customer_phone) = norm_phone(l.customer_phone)
			          AND h.merged_into_call_id IS NULL AND h.voided_at IS NULL
			          AND h.started_at >= l.callback_at)
			) x
			 ORDER BY callback_at
			 LIMIT 20`, u.ID)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		jsonRows(w, rows)
	}
}

// ccSnoozeCallback pushes a call-back forward by N minutes (default 10) and resets
// the alarm so it fires again when the new time arrives. Scoped to the owning agent.
func ccSnoozeCallback(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := core.UserFromCtx(r.Context())
		if u == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		id := chi.URLParam(r, "id")
		var b struct {
			Minutes int    `json:"minutes"`
			Source  string `json:"source"` // 'lead' | 'contact' (default contact)
		}
		_ = json.NewDecoder(r.Body).Decode(&b)
		if b.Minutes <= 0 {
			b.Minutes = 10
		}
		if b.Minutes > 1440 {
			b.Minutes = 1440
		}
		// Snooze the right book: a lead call-back lives on call_center_leads, a queue
		// call-back on call_center_contacts.
		q := `UPDATE call_center_contacts
			   SET callback_at = NOW() + make_interval(mins => $1), callback_notified_at = NULL
			 WHERE id = $2 AND assigned_to = $3 AND status='pending'`
		if b.Source == "lead" {
			q = `UPDATE call_center_leads
			   SET callback_at = NOW() + make_interval(mins => $1), updated_at = NOW()
			 WHERE id = $2 AND assigned_to = $3`
		}
		res, err := db.PGExec(r.Context(), q, b.Minutes, id, u.ID)
		if err != nil {
			respondErrLog(w, 500, "Snooze failed", err)
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			respondErr(w, 404, "Call-back not found or not assigned to you")
			return
		}
		respond(w, map[string]any{"ok": true, "snoozed_minutes": b.Minutes}, "pg")
	}
}

func ccCreateLead(db *core.DB) http.HandlerFunc {
	type body struct {
		CampaignID    *int64  `json:"campaign_id"`
		CustomerCIF   *string `json:"customer_cif"`
		CustomerName  string  `json:"customer_name"`
		CustomerPhone *string `json:"customer_phone"`
		Employer      *string `json:"employer"`
		State         *string `json:"state"`
		LeadScore     int     `json:"lead_score"`
		AssignedTo    *int64  `json:"assigned_to"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil || b.CustomerName == "" {
			respondErr(w, 400, "customer_name is required")
			return
		}
		rows, err := db.PGQuery(r.Context(),
			`INSERT INTO call_center_leads
			 (campaign_id, customer_cif, customer_name, customer_phone, employer, state, lead_score, assigned_to)
			 VALUES ($1,$2,$3,$4,$5,NULLIF($6,''),$7,$8) RETURNING *`,
			b.CampaignID, b.CustomerCIF, b.CustomerName, b.CustomerPhone,
			b.Employer, b.State, b.LeadScore, b.AssignedTo)
		if err != nil {
			respondErr(w, 500, "Insert failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func ccUpdateLead(db *core.DB) http.HandlerFunc {
	type body struct {
		Status       *string `json:"status"`
		Notes        *string `json:"notes"`
		CallbackAt   *string `json:"callback_at"`
		AssignedTo   *int64  `json:"assigned_to"`
		CustomerName *string `json:"customer_name"`
		Email        *string `json:"email"`
		Employer     *string `json:"employer"`
		Address      *string `json:"address"`
		State        *string `json:"state"`
		CustomerCIF  *string `json:"customer_cif"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		sup := ccIsSupervisor(user)
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		q := `UPDATE call_center_leads SET updated_at = NOW()`
		var args []any
		n := 1
		// Identity fields — a lead imported as a bare number gets a real name/details here.
		if b.CustomerName != nil {
			q += fmt.Sprintf(", customer_name=$%d", n)
			args = append(args, strings.TrimSpace(*b.CustomerName))
			n++
		}
		if b.Email != nil {
			q += fmt.Sprintf(", email=NULLIF($%d,'')", n)
			args = append(args, strings.TrimSpace(*b.Email))
			n++
		}
		if b.Employer != nil {
			q += fmt.Sprintf(", employer=NULLIF($%d,'')", n)
			args = append(args, strings.TrimSpace(*b.Employer))
			n++
		}
		if b.Address != nil {
			q += fmt.Sprintf(", address=NULLIF($%d,'')", n)
			args = append(args, strings.TrimSpace(*b.Address))
			n++
		}
		if b.State != nil {
			q += fmt.Sprintf(", state=NULLIF($%d,'')", n)
			args = append(args, strings.TrimSpace(*b.State))
			n++
		}
		if b.CustomerCIF != nil {
			q += fmt.Sprintf(", customer_cif=NULLIF($%d,'')", n)
			args = append(args, strings.TrimSpace(*b.CustomerCIF))
			n++
		}
		if b.Status != nil {
			// Validated against the same vocabulary call_center_leads_status_chk
			// enforces. This wrote the request body straight through, so a typo now
			// trips the constraint and reaches the agent as a bare 500 — a clean 400
			// naming the problem is the difference between fixable and baffling.
			st := strings.ToLower(strings.TrimSpace(*b.Status))
			if !ccLeadStatuses[st] {
				respondErr(w, 400, "unknown status: "+*b.Status)
				return
			}
			q += fmt.Sprintf(", status=$%d", n)
			args = append(args, st)
			n++
		}
		if b.Notes != nil {
			q += fmt.Sprintf(", notes=$%d", n)
			args = append(args, *b.Notes)
			n++
		}
		if b.CallbackAt != nil {
			q += fmt.Sprintf(", callback_at=$%d", n)
			args = append(args, *b.CallbackAt)
			n++
		}
		if b.AssignedTo != nil {
			// Reassignment is a supervisor action. With this field writable and no
			// check of any kind, any agent could move any lead — including a colleague's
			// converted one — onto herself and take the conversion credit.
			if !sup {
				respondErr(w, 403, "Only a call-centre supervisor can reassign a lead")
				return
			}
			q += fmt.Sprintf(", assigned_to=$%d", n)
			args = append(args, *b.AssignedTo)
			n++
		}
		args = append(args, id)
		q += fmt.Sprintf(" WHERE id=$%d", n)
		n++
		// Ownership enforced in the WHERE, so a lead that is not yours simply does not
		// match — the pattern ccSnoozeCallback uses, 404 on no rows. There was no
		// ownership check here at all.
		if !sup {
			q += fmt.Sprintf(" AND assigned_to=$%d", n)
			args = append(args, user.ID)
			n++
		}
		q += " RETURNING *"

		rows, err := db.PGQuery(r.Context(), q, args...)
		if err != nil || len(rows) == 0 {
			respondErrLog(w, 404, "Lead not found or not assigned to you", err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

// ccLastDispositionOnLead is the predicate "this disposition is the LAST one recorded
// against its lead" — the agent who actually closed it.
//
// Conversion was credited to EVERY agent who had ever dispositioned the lead, so one
// converted lead worked by three agents produced three conversions and the per-agent
// column summed to more conversions than the book contains. Attributing it to the last
// toucher is the rule the floor already works to: whoever got them over the line.
const ccLastDispositionOnLead = `d.id = (SELECT d2.id FROM call_center_dispositions d2
	                                       WHERE d2.lead_id = d.lead_id
	                                       ORDER BY d2.created_at DESC, d2.id DESC LIMIT 1)`

func ccStats(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		// Floor-wide, per-agent performance is supervisor data. This endpoint and the
		// four Performance ones below were registered with no gate of any kind, so any
		// agent could read every colleague's call and conversion counts.
		if !ccIsSupervisor(core.UserFromCtx(ctx)) {
			respondErr(w, 403, "Supervisors only")
			return
		}

		totals, _ := db.PGQuery(ctx, `
			SELECT
			  COUNT(*)                                                AS total_leads,
			  COUNT(*) FILTER (WHERE status='converted')             AS converted,
			  COUNT(*) FILTER (WHERE status='pending')               AS pending,
			  COUNT(*) FILTER (WHERE status='callback')              AS callbacks,
			  COUNT(*) FILTER (WHERE status='dnc')                   AS dnc_count,
			  COUNT(*) FILTER (WHERE last_called_at::date = CURRENT_DATE) AS called_today
			FROM call_center_leads`)

		agents, _ := db.PGQuery(ctx, `
			SELECT u.id, u.full_name,
			       COUNT(d.id)                                        AS calls_made,
			       COUNT(DISTINCT d.lead_id) FILTER (
			         WHERE l.status='converted' AND `+ccLastDispositionOnLead+`) AS conversions,
			       COUNT(d.id) FILTER (WHERE d.created_at::date = CURRENT_DATE) AS calls_today
			FROM o3c_users u
			JOIN call_center_dispositions d ON d.agent_id = u.id
			LEFT JOIN call_center_leads l ON l.id = d.lead_id
			WHERE u.deleted_at IS NULL
			GROUP BY u.id, u.full_name
			ORDER BY calls_made DESC
			LIMIT 20`)

		outcomes, _ := db.PGQuery(ctx, `
			SELECT outcome AS code,
			       app.cc_disposition_label(outcome) AS outcome,
			       COUNT(*) AS count
			FROM call_center_dispositions
			GROUP BY outcome
			ORDER BY count DESC`)

		totalsRow := map[string]any{"total_leads": 0, "converted": 0, "pending": 0, "callbacks": 0, "dnc_count": 0, "called_today": 0}
		if len(totals) > 0 {
			totalsRow = totals[0]
		}
		if agents == nil {
			agents = []map[string]any{}
		}
		if outcomes == nil {
			outcomes = []map[string]any{}
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"totals":   totalsRow,
			"agents":   agents,
			"outcomes": outcomes,
		})
	}
}

func ccListDNC(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := qint(r, "limit", 100, 1, 500)
		search := qstr(r, "search")

		q := `SELECT d.id, d.phone, d.reason, d.added_at, u.full_name AS added_by
		      FROM dnc_list d LEFT JOIN o3c_users u ON u.id = d.added_by WHERE 1=1`
		var args []any
		n := 1
		if search != "" {
			if clause, sargs, nn := buildCustomerSearch(search,
				[]string{"d.phone", "d.reason", "u.full_name"}, "d.phone", n); clause != "" {
				q += " AND " + clause
				args = append(args, sargs...)
				n = nn
			}
		}
		args = append(args, limit)
		q += fmt.Sprintf(" ORDER BY d.added_at DESC LIMIT $%d", n)

		rows, err := db.PGQuery(r.Context(), q, args...)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		jsonRows(w, rows)
	}
}

func ccAddDNC(db *core.DB) http.HandlerFunc {
	type body struct {
		Phone  string  `json:"phone"`
		Reason *string `json:"reason"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		// The opt-out list is a regulatory record, and this was the only mutation on
		// the page with no role check at all — every comparable bulk action gates on
		// supervisor, so any agent could add or wipe opt-outs.
		if !ccIsSupervisor(user) {
			respondErr(w, 403, "Only a call-centre supervisor can change the Do Not Call list")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil || b.Phone == "" {
			respondErr(w, 400, "phone is required")
			return
		}
		// Store the canonical form app.norm_phone() produces, and conflict on it, so
		// the list holds one row per number rather than the same number in several
		// shapes — which is what stopped the suppression checks matching anything.
		// A number we cannot normalise is refused outright: writing it would create an
		// entry that silently suppresses nothing while looking like an opt-out.
		np := normalizePhone(b.Phone)
		if len(np) != 10 {
			respondErr(w, 422, "That is not a number we can suppress — 10 digits are required")
			return
		}
		rows, err := db.PGQuery(r.Context(),
			`INSERT INTO dnc_list (phone, reason, added_by)
			 VALUES ($1,$2,$3)
			 ON CONFLICT (phone) DO UPDATE SET reason=$2, added_by=$3, added_at=NOW()
			 RETURNING *`,
			np, b.Reason, user.ID)
		if err != nil || len(rows) == 0 {
			respondErrLog(w, 500, "Insert failed", err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func ccRemoveDNC(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if !ccIsSupervisor(user) {
			respondErr(w, 403, "Only a call-centre supervisor can change the Do Not Call list")
			return
		}
		id := chi.URLParam(r, "id")
		// DELETE ... RETURNING captures the entry in the same statement that removes
		// it, so the tombstone can never disagree with what was actually deleted.
		// Taking a number OFF the opt-out list is the change on this page most likely
		// to be questioned later, and it left no trace whatsoever — the ccDNCKPIs
		// comment admits as much ("nothing tracked deletes").
		rows, err := db.PGQuery(r.Context(),
			`DELETE FROM dnc_list WHERE id=$1 RETURNING phone, reason, added_by, added_at`, id)
		if err != nil {
			respondErrLog(w, 500, "Delete failed", err)
			return
		}
		if len(rows) == 0 {
			respondErr(w, 404, "Not on the Do Not Call list")
			return
		}
		ccAuditDNCRemoval(r.Context(), db, user, rows)
		w.WriteHeader(204)
	}
}

// ccAuditDNCRemoval records who took numbers off the opt-out list and what those
// entries said.
//
// dnc_list has no tombstone column and adding one needs a migration this change set
// does not own, so the durable record goes to audit_logs — the table the rest of the
// app already uses for actor/action history, and which is partitioned for exactly
// this kind of append. A soft-delete column would be the better home if one is ever
// added; until then this is the difference between an auditable removal and none.
func ccAuditDNCRemoval(ctx context.Context, db *core.DB, user *core.Claims, removed []core.Row) {
	var actorID int64
	actorRole, actorName := "", ""
	if user != nil {
		actorID, actorRole, actorName = user.ID, user.Role, user.FullName
	}
	for _, row := range removed {
		changes, _ := json.Marshal(map[string]any{
			"phone":    str(row["phone"]),
			"reason":   str(row["reason"]),
			"added_by": toInt64(row["added_by"]),
			"added_at": row["added_at"],
		})
		if _, err := db.PGExec(ctx,
			`INSERT INTO audit_logs (actor_id, actor_role, actor_name, action, entity_type, entity_id, changes, ip_address, created_at)
			 VALUES ($1,$2,$3,'dnc_removed','dnc_list',$4,$5,'',NOW())`,
			actorID, actorRole, actorName, str(row["phone"]), string(changes)); err != nil {
			// The row is already gone; losing the audit trail silently would be the
			// worst of both outcomes, so say so loudly.
			slog.Error("ccAuditDNCRemoval: DNC removal NOT audited",
				"phone", str(row["phone"]), "actor", actorID, "err", err)
		}
	}
}

// ccListAgents returns all active call center agents for the assignment UI.
func ccListAgents(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(),
			`SELECT id, full_name
			 FROM o3c_users
			 WHERE deleted_at IS NULL
			   AND role IN ('call_center_agent','call_center_head')
			 ORDER BY full_name`)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		jsonRows(w, rows)
	}
}

// ccAssignBatch hands a BATCH of the outbound queue to a single agent — the supervisor
// picks a count (e.g. 20/50/100) and optionally a purpose, and that many still-pending,
// unassigned contacts (high priority first, then oldest queued) get assigned to them.
// Head/supervisor only (call_center_stats).
func ccAssignBatch(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !ccIsSupervisor(core.UserFromCtx(r.Context())) {
			respondErr(w, 403, "Only team heads can assign the queue")
			return
		}
		var b struct {
			AgentID int64  `json:"agent_id"`
			Count   int    `json:"count"`
			Purpose string `json:"purpose"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.AgentID <= 0 {
			respondErr(w, 422, "agent_id is required")
			return
		}
		if b.Count <= 0 || b.Count > 1000 {
			respondErr(w, 422, "count must be between 1 and 1000")
			return
		}
		if rows, _ := db.PGQuery(r.Context(),
			`SELECT 1 FROM o3c_users WHERE id=$1 AND deleted_at IS NULL AND role IN ('call_center_agent','call_center_head')`,
			b.AgentID); len(rows) == 0 {
			respondErr(w, 422, "Unknown agent")
			return
		}

		where := "status='pending' AND assigned_to IS NULL"
		args := []any{b.AgentID}
		n := 2
		if b.Purpose != "" && b.Purpose != "all" {
			where += fmt.Sprintf(" AND purpose=$%d", n)
			args = append(args, b.Purpose)
			n++
		}
		args = append(args, b.Count)
		res, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			UPDATE call_center_contacts SET assigned_to=$1, updated_at=NOW()
			WHERE id IN (
			  SELECT id FROM call_center_contacts
			  WHERE %s
			  ORDER BY CASE lower(priority) WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at
			  LIMIT $%d
			)
			  -- Re-check in the WRITE, not only in the read. Two supervisors assigning
			  -- at the same moment each selected the same top N and each wrote them, so
			  -- one agent received everything while the other was told "100 assigned"
			  -- and opened an empty queue. ccDistributeQueue already claims this way.
			  AND assigned_to IS NULL AND status='pending'
			RETURNING id`, where, n), args...)
		if err != nil {
			respondErr(w, 500, "Assign failed")
			return
		}
		// Tell the agent. Queue assignment was silent, which is why all 14,709
		// contacts sat with assigned_to NULL and nobody worked an owned list.
		if len(res) > 0 {
			go Notify(context.WithoutCancel(r.Context()), db, NotifPayload{
				EventType: "queue_contacts_assigned",
				UserID:    b.AgentID,
				Title:     fmt.Sprintf("%d contacts assigned to you", len(res)),
				Body:      "New contacts are waiting in your outbound queue.",
				ActionURL: "/call-center/queue?bucket=mine",
				EntityRef: "queue:assigned",
				GroupKey:  "queue:assigned",
			})
		}
		respond(w, map[string]any{"assigned": len(res)}, "pg")
	}
}

// ccDistributeQueue round-robins the unowned queue across active agents, so a
// supervisor can hand the whole pool out in one action instead of assigning a
// batch per agent. Complements ccAssignBatch (manual, one agent at a time) —
// both are needed: round-robin for the bulk case, manual for the deliberate one.
func ccDistributeQueue(db *core.DB) http.HandlerFunc {
	type body struct {
		Limit   int    `json:"limit"`
		Purpose string `json:"purpose"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		if !ccIsSupervisor(user) {
			respondErr(w, 403, "Only team heads can distribute the queue")
			return
		}
		var b body
		json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck
		if b.Limit <= 0 || b.Limit > 20000 {
			b.Limit = 20000
		}

		// Online & available agents first; fall back to everyone so a distribute never
		// no-ops when nobody is currently online.
		agents, onlineOnly := distributionAgents(ctx, db)
		if len(agents) == 0 {
			respondErr(w, 422, "No active call-centre agents to distribute to")
			return
		}

		where := "status='pending' AND assigned_to IS NULL"
		args := []any{}
		n := 1
		if b.Purpose != "" && b.Purpose != "all" {
			where += fmt.Sprintf(" AND purpose=$%d", n)
			args = append(args, b.Purpose)
			n++
		}
		args = append(args, b.Limit)
		rows, err := db.PGQuery(ctx, fmt.Sprintf(`
			SELECT id FROM call_center_contacts
			 WHERE %s
			 ORDER BY CASE lower(priority) WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
			          dpd DESC NULLS LAST, created_at
			 LIMIT $%d`, where, n), args...)
		if err != nil {
			respondErr(w, 500, "Could not read the queue")
			return
		}
		if len(rows) == 0 {
			respond(w, map[string]any{"assigned": 0, "per_agent": map[string]int{}, "online_only": onlineOnly}, "json")
			return
		}

		// Deal the pool out round-robin, then write one UPDATE per agent.
		buckets := make(map[int64][]int64, len(agents))
		for i, row := range rows {
			a := agents[i%len(agents)]
			buckets[a] = append(buckets[a], toInt64(row["id"]))
		}

		total := 0
		perAgent := map[string]int{}
		for agentID, ids := range buckets {
			// Re-check assigned_to IS NULL in the write so a concurrent manual
			// assignment cannot be silently overwritten.
			res, err := db.PGExec(ctx, `
				UPDATE call_center_contacts SET assigned_to=$1, updated_at=NOW()
				 WHERE id = ANY($2) AND assigned_to IS NULL AND status='pending'`, agentID, ids)
			if err != nil {
				continue
			}
			cnt, _ := res.RowsAffected()
			if cnt == 0 {
				continue
			}
			total += int(cnt)
			perAgent[fmt.Sprintf("%d", agentID)] = int(cnt)
			go Notify(context.WithoutCancel(ctx), db, NotifPayload{
				EventType: "queue_contacts_assigned",
				UserID:    agentID,
				Title:     fmt.Sprintf("%d contacts assigned to you", cnt),
				Body:      "New contacts are waiting in your outbound queue.",
				ActionURL: "/call-center/queue?bucket=mine",
				EntityRef: "queue:assigned",
				GroupKey:  "queue:assigned",
			})
		}
		respond(w, map[string]any{"assigned": total, "per_agent": perAgent, "agents": len(agents), "online_only": onlineOnly}, "json")
	}
}

// ccBulkAssign assigns a list of leads to a single agent.
// Restricted to call_center_head and management roles.
func ccBulkAssign(db *core.DB) http.HandlerFunc {
	type body struct {
		LeadIDs []int64 `json:"lead_ids"`
		AgentID int64   `json:"agent_id"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if !ccIsSupervisor(user) {
			respondErr(w, 403, "Only team heads can assign leads")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.AgentID == 0 || len(b.LeadIDs) == 0 {
			respondErr(w, 400, "agent_id and lead_ids are required")
			return
		}
		if len(b.LeadIDs) > ccMaxBulkIDs {
			respondErr(w, 422, fmt.Sprintf("too many leads in one request (max %d)", ccMaxBulkIDs))
			return
		}

		// ONE array parameter instead of a bind parameter per lead. The old form built
		// "$2,$3,…" across the whole selection, which Postgres refuses beyond 65,535
		// parameters — a big enough selection failed inside the driver.
		rows, err := db.PGQuery(r.Context(),
			`UPDATE call_center_leads SET assigned_to=$1, updated_at=NOW()
			  WHERE id = ANY($2) RETURNING id`,
			b.AgentID, b.LeadIDs)
		if err != nil {
			respondErrLog(w, 500, "Assign failed", err)
			return
		}
		if len(rows) > 0 {
			// Same as the round-robin distribute: the agent needs to be told, or the
			// hand-off is invisible to them until they happen to reload the page.
			go Notify(context.WithoutCancel(r.Context()), db, NotifPayload{
				EventType: "leads_assigned",
				UserID:    b.AgentID,
				Title:     fmt.Sprintf("%d lead(s) assigned to you", len(rows)),
				Body:      "New leads are waiting in your list.",
				ActionURL: "/call-center/leads",
				EntityRef: "leads:assigned",
				GroupKey:  "leads:assigned",
			})
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"assigned": len(rows)}) //nolint:errcheck
	}
}

// ── Agent presence (heartbeat) ────────────────────────────────────────────────

// onlineAgentIDs returns the call-centre agents who are online AND available right
// now: status 'available' with a heartbeat in the last 5 minutes. Distribution uses
// this so work only lands on people actually at their desk.
func onlineAgentIDs(ctx context.Context, db *core.DB) []int64 {
	rows, _ := db.PGQuery(ctx, `
		SELECT id FROM o3c_users
		 WHERE deleted_at IS NULL
		   AND role IN ('call_center_agent','call_center_head')
		   AND COALESCE(helpdesk_status,'offline') = 'available'
		   AND helpdesk_last_seen IS NOT NULL
		   AND helpdesk_last_seen > NOW() - INTERVAL '5 minutes'
		 ORDER BY id`)
	out := make([]int64, 0, len(rows))
	for _, r := range rows {
		if id := toInt64(r["id"]); id > 0 {
			out = append(out, id)
		}
	}
	return out
}

// allCCAgentIDs is the fallback pool used when nobody is online, so a supervisor's
// distribute never silently no-ops.
func allCCAgentIDs(ctx context.Context, db *core.DB) []int64 {
	rows, _ := db.PGQuery(ctx, `
		SELECT id FROM o3c_users
		 WHERE deleted_at IS NULL AND role IN ('call_center_agent','call_center_head')
		 ORDER BY id`)
	out := make([]int64, 0, len(rows))
	for _, r := range rows {
		if id := toInt64(r["id"]); id > 0 {
			out = append(out, id)
		}
	}
	return out
}

// distributionAgents resolves the target pool for a round-robin: online-and-available
// first, falling back to everyone when nobody is online. The bool reports whether the
// online set was used, so the UI can say so.
func distributionAgents(ctx context.Context, db *core.DB) ([]int64, bool) {
	online := onlineAgentIDs(ctx, db)
	if len(online) > 0 {
		return online, true
	}
	return allCCAgentIDs(ctx, db), false
}

// ccPresencePing marks the caller present by refreshing last-seen on a timer while the
// workspace is open. Body {"initial":true} — sent once when the app loads — also brings
// an offline agent back to available ("auto-online on login"). Regular heartbeats never
// change status, so a manual Break/Offline the agent chose with the tab open is respected.
func ccPresencePing(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := core.UserFromCtx(r.Context())
		if u == nil {
			respondErr(w, 401, "Not signed in")
			return
		}
		var b struct {
			Initial bool `json:"initial"`
		}
		json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck
		if b.Initial {
			db.PGExec(r.Context(), `
				UPDATE o3c_users
				   SET helpdesk_last_seen = NOW(),
				       helpdesk_status = CASE WHEN COALESCE(helpdesk_status,'offline') = 'offline'
				                              THEN 'available' ELSE helpdesk_status END
				 WHERE id = $1`, u.ID) //nolint:errcheck
		} else {
			db.PGExec(r.Context(), `UPDATE o3c_users SET helpdesk_last_seen = NOW() WHERE id = $1`, u.ID) //nolint:errcheck
		}
		var status string
		if rows, _ := db.PGQuery(r.Context(), `SELECT COALESCE(helpdesk_status,'available') AS s FROM o3c_users WHERE id=$1`, u.ID); len(rows) > 0 {
			status = str(rows[0]["s"])
		}
		respond(w, map[string]any{"status": status}, "json")
	}
}

// ccPresenceOffline flips the caller offline — sent as a beacon when the tab closes.
func ccPresenceOffline(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := core.UserFromCtx(r.Context())
		if u == nil {
			respondErr(w, 401, "Not signed in")
			return
		}
		db.PGExec(r.Context(), `UPDATE o3c_users SET helpdesk_status='offline' WHERE id=$1`, u.ID) //nolint:errcheck
		respond(w, map[string]any{"status": "offline"}, "json")
	}
}

// ccAssignLeadsBatch hands a COUNT of unassigned pending leads to one agent — the
// leads analogue of ccAssignBatch, so Leads and the Outbound Queue offer the same
// "Assign to agent" action. Head/management only.
func ccAssignLeadsBatch(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if !ccIsSupervisor(user) {
			respondErr(w, 403, "Only team heads can assign leads")
			return
		}
		var b struct {
			AgentID    int64  `json:"agent_id"`
			Count      int    `json:"count"`
			CampaignID *int64 `json:"campaign_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.AgentID <= 0 {
			respondErr(w, 422, "agent_id is required")
			return
		}
		if b.Count <= 0 || b.Count > 5000 {
			respondErr(w, 422, "count must be between 1 and 5000")
			return
		}
		if rows, _ := db.PGQuery(r.Context(),
			`SELECT 1 FROM o3c_users WHERE id=$1 AND deleted_at IS NULL AND role IN ('call_center_agent','call_center_head')`,
			b.AgentID); len(rows) == 0 {
			respondErr(w, 422, "Unknown agent")
			return
		}
		where := "assigned_to IS NULL AND " + ccLeadWorkableExpr("")
		args := []any{b.AgentID}
		n := 2
		if b.CampaignID != nil {
			where += fmt.Sprintf(" AND campaign_id=$%d", n)
			args = append(args, *b.CampaignID)
			n++
		}
		args = append(args, b.Count)
		res, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			UPDATE call_center_leads SET assigned_to=$1, updated_at=NOW()
			 WHERE id IN (
			   SELECT id FROM call_center_leads
			    WHERE %s
			    ORDER BY lead_score DESC, created_at ASC
			    LIMIT $%d
			 )
			   -- Same atomic claim as the queue: without it two concurrent assignments
			   -- both wrote the same leads.
			   AND assigned_to IS NULL
			 RETURNING id`, where, n), args...)
		if err != nil {
			respondErr(w, 500, "Assign failed")
			return
		}
		if len(res) > 0 {
			go Notify(context.WithoutCancel(r.Context()), db, NotifPayload{
				EventType: "leads_assigned",
				UserID:    b.AgentID,
				Title:     fmt.Sprintf("%d lead(s) assigned to you", len(res)),
				Body:      "New leads are waiting in your list.",
				ActionURL: "/call-center/leads",
				EntityRef: "leads:assigned",
				GroupKey:  "leads:assigned",
			})
		}
		respond(w, map[string]any{"assigned": len(res)}, "pg")
	}
}

// ccDistribute distributes unassigned pending leads round-robin across active agents.
// Restricted to call_center_head and management roles.
// Leads are ordered by lead_score DESC so high-value leads are spread first.
func ccDistribute(db *core.DB) http.HandlerFunc {
	type body struct {
		CampaignID *int64  `json:"campaign_id"` // nil = all campaigns
		AgentIDs   []int64 `json:"agent_ids"`   // nil = all call-center agents
		IncludeMe  bool    `json:"include_me"`  // supervisor opts in to take a share too
	}
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if !ccIsSupervisor(user) {
			respondErr(w, 403, "Only team heads can distribute leads")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		ctx := r.Context()

		// Resolve agents — online & available first, falling back to everyone so a
		// distribute never no-ops when the floor is quiet.
		agentIDs := b.AgentIDs
		onlineOnly := false
		if len(agentIDs) == 0 {
			agentIDs, onlineOnly = distributionAgents(ctx, db)
		}
		// The supervisor is a recipient only when they tick "include me". By default
		// keep leads off their own plate — they hand work out, they don't have to take
		// it — and when they do opt in, make sure they get a share even if they aren't
		// flagged online at that moment.
		if user != nil {
			kept := make([]int64, 0, len(agentIDs))
			inPool := false
			for _, id := range agentIDs {
				if id == user.ID {
					inPool = true
					if !b.IncludeMe {
						continue
					}
				}
				kept = append(kept, id)
			}
			if b.IncludeMe && !inPool {
				kept = append(kept, user.ID)
			}
			agentIDs = kept
		}
		if len(agentIDs) == 0 {
			respondErr(w, 400, "No call center agents found")
			return
		}

		// Fetch the workable, unassigned pool — BOUNDED. This had no limit at all: it
		// loaded every matching lead and then built one bind parameter per lead, and
		// Postgres refuses a statement carrying more than 65,535 of them, so a large
		// pool failed outright. The cap matches ccDistributeQueue's.
		q := `SELECT id FROM call_center_leads WHERE assigned_to IS NULL AND ` + ccLeadWorkableExpr("")
		var args []any
		if b.CampaignID != nil {
			q += " AND campaign_id=$1"
			args = append(args, *b.CampaignID)
		}
		q += fmt.Sprintf(" ORDER BY lead_score DESC, created_at ASC LIMIT %d", ccMaxDistribute)
		leadRows, err := db.PGQuery(ctx, q, args...)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		if len(leadRows) == 0 {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]any{"distributed": 0, "breakdown": []any{}}) //nolint:errcheck
			return
		}

		// Group lead IDs by agent (round-robin)
		groups := make(map[int64][]int64, len(agentIDs))
		for i, row := range leadRows {
			agentID := agentIDs[i%len(agentIDs)]
			var leadID int64
			switch v := row["id"].(type) {
			case int64:
				leadID = v
			case float64:
				leadID = int64(v)
			}
			groups[agentID] = append(groups[agentID], leadID)
		}

		// Bulk UPDATE per agent — all-or-nothing so a mid-loop failure doesn't leave
		// some agents assigned and others skipped.
		tx, err := db.PG.BeginTx(ctx, nil)
		if err != nil {
			respondErr(w, 500, "Distribute failed")
			return
		}
		defer tx.Rollback() //nolint:errcheck
		assignedPerAgent := make(map[int64]int64, len(groups))
		var totalAssigned int64
		for agentID, ids := range groups {
			// ONE array parameter instead of a parameter per lead, and the same
			// assigned_to re-check ccDistributeQueue makes, so a lead another
			// supervisor claimed in the meantime is not silently taken from them.
			res, err := tx.ExecContext(ctx,
				`UPDATE call_center_leads SET assigned_to=$1, updated_at=NOW()
				  WHERE id = ANY($2) AND assigned_to IS NULL`, agentID, ids)
			if err != nil {
				respondErrLog(w, 500, "Distribute failed", err)
				return
			}
			cnt, _ := res.RowsAffected()
			assignedPerAgent[agentID] = cnt
			totalAssigned += cnt
		}
		if err := tx.Commit(); err != nil {
			respondErr(w, 500, "Distribute failed")
			return
		}

		// Fetch agent names for the response breakdown
		nameRows, _ := db.PGQuery(ctx,
			`SELECT id, full_name FROM o3c_users WHERE id = ANY($1)`, agentIDs)
		nameMap := map[int64]string{}
		for _, row := range nameRows {
			var uid int64
			switch v := row["id"].(type) {
			case int64:
				uid = v
			case float64:
				uid = int64(v)
			}
			nameMap[uid] = str(row["full_name"])
		}

		breakdown := make([]map[string]any, 0, len(groups))
		for agentID := range groups {
			cnt := assignedPerAgent[agentID]
			// Report what each agent ACTUALLY received. This counted the leads dealt
			// into their bucket, not the rows updated, so a partially-applied
			// distribute still told the supervisor every lead had landed.
			breakdown = append(breakdown, map[string]any{
				"agent_id":   agentID,
				"agent_name": nameMap[agentID],
				"count":      cnt,
			})
			if cnt == 0 {
				continue // nothing landed — don't announce an empty hand-out
			}
			// Tell each agent leads landed in their list — the whole point of a
			// distribution is that the agent starts working it, and they won't unless
			// they know. Fire-and-forget so a slow notify never blocks the response.
			go Notify(context.WithoutCancel(ctx), db, NotifPayload{
				EventType: "leads_assigned",
				UserID:    agentID,
				Title:     fmt.Sprintf("%d lead(s) assigned to you", cnt),
				Body:      "New leads are waiting in your list.",
				ActionURL: "/call-center/leads",
				EntityRef: "leads:assigned",
				GroupKey:  "leads:assigned",
			})
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			// Rows actually updated, not rows selected.
			"distributed": totalAssigned,
			"breakdown":   breakdown,
			"online_only": onlineOnly,
		})
	}
}

// ccRecallLeads undoes a distribution: it pulls handed-out but NOT-yet-worked leads
// (assigned + status 'pending') back to the unassigned pool so a supervisor can
// distribute again — e.g. after a bad round where work landed on agents who turned
// out to be offline. Only 'pending' leads are recalled, so a lead an agent has already
// called, booked a call-back on, or converted keeps its owner and is never yanked
// mid-conversation. Optional campaign_id / agent_id narrow the recall. Head/mgmt only.
func ccRecallLeads(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if !ccIsSupervisor(user) {
			respondErr(w, 403, "Only team heads can recall leads")
			return
		}
		var b struct {
			CampaignID *int64 `json:"campaign_id"` // nil = all campaigns
			AgentID    *int64 `json:"agent_id"`    // nil = all agents
		}
		json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck

		// Workable, not merely 'pending': a lead was recallable exactly once, because
		// the first dial moved it to 'no_answer' permanently and no supervisor action
		// could reach it again. The cool-down inside the predicate also preserves the
		// original intent better than status alone did — a freshly-dialled lead is not
		// yanked out from under the agent mid-conversation.
		where := "assigned_to IS NOT NULL AND " + ccLeadWorkableExpr("")
		var args []any
		n := 1
		if b.CampaignID != nil {
			where += fmt.Sprintf(" AND campaign_id=$%d", n)
			args = append(args, *b.CampaignID)
			n++
		}
		if b.AgentID != nil {
			where += fmt.Sprintf(" AND assigned_to=$%d", n)
			args = append(args, *b.AgentID)
			n++
		}
		res, err := db.PGExec(r.Context(),
			fmt.Sprintf(`UPDATE call_center_leads SET assigned_to=NULL, updated_at=NOW() WHERE %s`, where),
			args...)
		if err != nil {
			respondErrLog(w, 500, "Recall failed", err)
			return
		}
		var recalled int64
		if res != nil {
			recalled, _ = res.RowsAffected()
		}
		respond(w, map[string]any{"recalled": recalled}, "json")
	}
}

// ccLeadsTeam is the supervisor's live read on the marketing floor: for each agent,
// how many leads they hold and what has become of them, plus whether they're at their
// desk right now — the panel agents themselves don't see. Head/management only.
func ccLeadsTeam(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if !ccIsSupervisor(user) {
			respondErr(w, 403, "Supervisors only")
			return
		}
		// Optional campaign scope, matching the Leads page's campaign filter.
		campFilter := ""
		var args []any
		if c := qstr(r, "campaign_id"); c != "" {
			campFilter = " AND l.campaign_id = $1"
			args = append(args, c)
		}
		agents, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT u.id, u.full_name,
			       COALESCE(u.helpdesk_status,'offline')                 AS status,
			       (u.helpdesk_last_seen > NOW() - INTERVAL '5 minutes') AS online,
			       COUNT(l.id)                                           AS assigned,
			       COUNT(l.id) FILTER (WHERE l.status='pending')         AS pending,
			       COUNT(l.id) FILTER (WHERE l.status='callback')        AS callbacks,
			       COUNT(l.id) FILTER (WHERE l.status='converted')       AS converted,
			       -- Without these the wallboard accounted for a fraction of each
			       -- agent's book: 'assigned' counted every lead she holds while the
			       -- breakdown beside it covered only four statuses, so the columns
			       -- visibly failed to reconcile.
			       COUNT(l.id) FILTER (WHERE l.status='interested')      AS interested,
			       COUNT(l.id) FILTER (WHERE l.status IN ('called','no_answer','not_ready')) AS worked,
			       COUNT(l.id) FILTER (WHERE l.status IN ('closed','invalid','dnc'))         AS closed,
			       -- LEADS called today, not raw dials: a support call, an inbound, or three
			       -- retries on one number were all counting as "called" next to a lead-book
			       -- "pending", so 87 dials sat beside 515 pending and read as broken. Count
			       -- the distinct leads in HER book she actually called today, so the numbers
			       -- tell one story.
			       (SELECT COUNT(DISTINCT hc.lead_id) FROM helpdesk_calls hc
			         JOIN call_center_leads ll ON ll.id = hc.lead_id AND ll.assigned_to = u.id
			        WHERE hc.agent_id = u.id
			          AND hc.started_at::date = CURRENT_DATE
			          AND hc.merged_into_call_id IS NULL AND hc.voided_at IS NULL) AS called_today,
			       -- Raw dials too, so the supervisor still sees activity (repeat calls,
			       -- support, inbound) separately from lead progress.
			       (SELECT COUNT(*) FROM helpdesk_calls hc
			         WHERE hc.agent_id = u.id
			           AND hc.started_at::date = CURRENT_DATE
			           AND hc.merged_into_call_id IS NULL AND hc.voided_at IS NULL) AS dials_today
			  FROM o3c_users u
			  LEFT JOIN call_center_leads l ON l.assigned_to = u.id%s
			 WHERE u.deleted_at IS NULL
			   -- Agents only. Supervisors/heads don't work a dial book, so listing them
			   -- padded the wallboard with a permanently-empty row. Any call-related
			   -- queue/board shows only the people who actually make calls.
			   AND u.role = 'call_center_agent'
			 GROUP BY u.id, u.full_name, u.helpdesk_status, u.helpdesk_last_seen
			 ORDER BY assigned DESC, u.full_name`, campFilter), args...)
		if err != nil {
			respondErrLog(w, 500, "Could not load the team", err)
			return
		}
		// Floor totals — the unassigned pool is what the supervisor still has to hand out.
		totalRows, _ := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT COUNT(*)                                    AS total,
			       COUNT(*) FILTER (WHERE assigned_to IS NULL) AS unassigned,
			       COUNT(*) FILTER (WHERE status='pending')    AS pending,
			       COUNT(*) FILTER (WHERE status='interested') AS interested,
			       COUNT(*) FILTER (WHERE status='callback')   AS callbacks,
			       COUNT(*) FILTER (WHERE status='converted')  AS converted,
			       COUNT(*) FILTER (WHERE status IN ('called','no_answer','not_ready')) AS worked,
			       COUNT(*) FILTER (WHERE status IN ('closed','invalid','dnc'))         AS closed
			  FROM call_center_leads l
			 WHERE TRUE%s`, campFilter), args...)
		var totals any = map[string]any{}
		if len(totalRows) > 0 {
			totals = totalRows[0]
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"agents": agents, "totals": totals}) //nolint:errcheck
	}
}

// ccQueueTeam is the outbound queue's live per-agent wallboard, the counterpart to
// ccLeadsTeam but over call_center_contacts (the dialer book) instead of
// call_center_leads. Same access model (supervisors/heads/mgmt), same agents-only row
// set — a supervisor watches who is dialling, how much of their book is still pending,
// how many call-backs are due, and how many dials landed today.
func ccQueueTeam(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if !ccIsSupervisor(user) {
			respondErr(w, 403, "Supervisors only")
			return
		}
		// Optional purpose scope, matching the queue's purpose tabs.
		purpFilter := ""
		var args []any
		if p := strings.ToLower(qstr(r, "purpose")); p == "marketing" || p == "collections" || p == "support" {
			purpFilter = " AND c.purpose = $1"
			args = append(args, p)
		}
		agents, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT u.id, u.full_name,
			       COALESCE(u.helpdesk_status,'offline')                 AS status,
			       (u.helpdesk_last_seen > NOW() - INTERVAL '5 minutes') AS online,
			       COUNT(c.id)                                                   AS assigned,
			       COUNT(c.id) FILTER (WHERE c.status='pending')                 AS pending,
			       -- "Not called since it came due" is the same guard ccMyCallbacksDue
			       -- and ccDueCallbackCount both apply. Without it the wallboard counted
			       -- call-backs the agent had already returned, so her number never
			       -- dropped no matter how many she worked.
			       COUNT(c.id) FILTER (WHERE c.status='pending'
			                             AND c.callback_at IS NOT NULL
			                             AND c.callback_at <= NOW()
			                             AND (c.last_called_at IS NULL
			                                  OR c.last_called_at < c.callback_at))  AS callbacks_due,
			       COUNT(c.id) FILTER (WHERE c.status IN ('closed','invalid','skipped')) AS closed,
			       -- Distinct contacts in HER book she actually reached today, matched to
			       -- the real call ledger by normalised phone (contacts carry no lead_id).
			       (SELECT COUNT(DISTINCT right(regexp_replace(c2.phone,'\D','','g'),10))
			          FROM call_center_contacts c2
			          JOIN helpdesk_calls hc
			            ON right(regexp_replace(hc.customer_phone,'\D','','g'),10)
			             = right(regexp_replace(c2.phone,'\D','','g'),10)
			         WHERE c2.assigned_to = u.id
			           AND hc.agent_id = u.id
			           AND hc.started_at::date = CURRENT_DATE
			           AND hc.merged_into_call_id IS NULL AND hc.voided_at IS NULL) AS called_today,
			       (SELECT COUNT(*) FROM helpdesk_calls hc
			         WHERE hc.agent_id = u.id
			           AND hc.started_at::date = CURRENT_DATE
			           AND hc.merged_into_call_id IS NULL AND hc.voided_at IS NULL) AS dials_today
			  FROM o3c_users u
			  LEFT JOIN call_center_contacts c ON c.assigned_to = u.id%s
			 WHERE u.deleted_at IS NULL
			   AND u.role = 'call_center_agent'
			 GROUP BY u.id, u.full_name, u.helpdesk_status, u.helpdesk_last_seen
			 ORDER BY assigned DESC, u.full_name`, purpFilter), args...)
		if err != nil {
			respondErrLog(w, 500, "Could not load the team", err)
			return
		}
		// Floor totals — the unassigned pool is what the supervisor still has to hand out.
		totalRows, _ := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT COUNT(*)                                    AS total,
			       COUNT(*) FILTER (WHERE assigned_to IS NULL) AS unassigned,
			       COUNT(*) FILTER (WHERE status='pending')    AS pending,
			       COUNT(*) FILTER (WHERE status='pending' AND callback_at IS NOT NULL
			                          AND callback_at <= NOW()
			                          AND (last_called_at IS NULL
			                               OR last_called_at < callback_at)) AS callbacks_due,
			       COUNT(*) FILTER (WHERE status IN ('closed','invalid','skipped')) AS closed
			  FROM call_center_contacts c
			 WHERE TRUE%s`, purpFilter), args...)
		var totals any = map[string]any{}
		if len(totalRows) > 0 {
			totals = totalRows[0]
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"agents": agents, "totals": totals}) //nolint:errcheck
	}
}

// ── Outbound Queue ────────────────────────────────────────────────────────────

// ccSyncQueueFromCRM seeds the outbound queue from Zoho-imported CRM leads.
// Idempotent: dedups by normalised phone and skips numbers already in the queue,
// so it can be re-run as new leads arrive. Rows are tagged product_name='Zoho Lead'.
func ccSyncQueueFromCRM(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		res, err := db.PGExec(r.Context(), `
			INSERT INTO call_center_contacts
			  (customer_name, phone, cif, product_name, priority, is_existing_customer, status, purpose, source)
			SELECT DISTINCT ON (norm_phone)
			  COALESCE(NULLIF(clean_name,''), ''),   -- blank when no real name; never store the phone as the name
			  phone,
			  NULLIF(cif_number,''),
			  'Zoho Lead',
			  'Medium',
			  (COALESCE(cif_number,'') <> ''),
			  'pending',
			  'marketing',  -- Zoho lead queue is telesales/marketing by nature
			  'zoho_crm'
			FROM (
			  SELECT
			    trim(regexp_replace(concat(COALESCE(first_name,''),' ',COALESCE(last_name,'')), '^[.[:space:]]+', '')) AS clean_name,
			    phone,
			    right(regexp_replace(COALESCE(phone,''), '\D', '', 'g'), 10) AS norm_phone,
			    cif_number
			  FROM crm_contacts
			  WHERE source='zoho_desk' AND status='lead' AND COALESCE(phone,'') <> ''
			) x
			WHERE length(norm_phone) = 10
			  AND ` + ccNotOnDNCExpr("x.phone") + `
			  AND NOT EXISTS (
			    SELECT 1 FROM call_center_contacts t
			    WHERE right(regexp_replace(COALESCE(t.phone,''), '\D', '', 'g'), 10) = x.norm_phone
			  )
			ORDER BY norm_phone, (clean_name ~ '[A-Za-z]') DESC`)
		if err != nil {
			respondErr(w, 500, "Sync failed: "+err.Error())
			return
		}
		n, _ := res.RowsAffected()

		// Attach the originating list/campaign to marketing contacts. Zoho leads
		// carry no list field, but the call-ticket subject IS the list
		// ("IK'S LIST", "FOOD BUSINESS CALL", …). Match by phone, take the most
		// recent, normalise (upper/trim/collapse spaces, drop apostrophes and the
		// inbound-call noise). Runs every sync so it also back-fills older rows.
		db.PGExec(r.Context(), `
			WITH lists AS (
			  SELECT DISTINCT ON (np) np, list_name FROM (
			    SELECT right(regexp_replace(COALESCE(customer_phone,''),'\D','','g'),10) AS np,
			           UPPER(TRIM(regexp_replace(replace(subject,'''',''),'\s+',' ','g'))) AS list_name,
			           created_at
			    FROM helpdesk_tickets
			    WHERE channel='call' AND COALESCE(subject,'') <> ''
			      AND subject NOT ILIKE 'zoho voice%'
			      AND subject NOT ILIKE '%incoming call alert%'
			  ) s WHERE length(np)=10
			  ORDER BY np, created_at DESC NULLS LAST
			)
			UPDATE call_center_contacts c
			SET ref = l.list_name
			FROM lists l
			WHERE c.purpose='marketing'
			  AND right(regexp_replace(COALESCE(c.phone,''),'\D','','g'),10) = l.np
			  AND (c.ref IS NULL OR c.ref='')`) //nolint:errcheck

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"inserted": n}) //nolint:errcheck
	}
}

// ccSyncCollections feeds the delinquency book into the dialler queue as collections
// calls, carrying real DPD, outstanding balance and product so the panel shows genuine
// collections context (not the empty ₦0/DPD 0 that marketing leads produce).
//
// Three faults fixed here:
//
//  1. SOURCE. It read app.accounts — the CARD table — despite being described as
//     "populates the dialer queue from the collections book". Delinquent loans could
//     therefore never be dialled at all. It now reads app.collections_delinquent_unified,
//     which covers cards, core-banking loans and the uploaded loan book alike.
//
//  2. DEDUPE. The NOT EXISTS carried no status predicate, so a number queued once was
//     never queued again — even after that attempt was closed and the customer fell
//     into arrears afresh. It now only skips a number with an OPEN (pending) collections
//     row, so a re-delinquent customer returns to the queue.
//
//  3. DNC. The suppression compared a normalised 10-digit number against the raw
//     dnc_list value, so any stored number holding spaces or a +234 prefix silently
//     failed to suppress. Both sides are normalised now. app.norm_phone returns ''
//     rather than NULL, so the length guard is what stops blank matching blank.
//
// Identity comes from v_contact_identity (freshest phone per party) and party_id is
// carried onto the queue row, so a dialled customer is the same person everywhere.
func ccSyncCollections(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		res, err := db.PGExec(r.Context(), `
			INSERT INTO call_center_contacts
			  (customer_name, phone, cif, party_id, product_name, priority,
			   outstanding_kobo, dpd, is_existing_customer, loan_product,
			   status, purpose, source)
			SELECT DISTINCT ON (norm_phone)
			  COALESCE(clean_name,''), phone, cif, party_id, product_name,
			  CASE WHEN dpd > 90 THEN 'High' WHEN dpd > 30 THEN 'Medium' ELSE 'Low' END,
			  outstanding_kobo, dpd, true, product_name,
			  'pending', 'collections', 'collections'
			FROM (
			  SELECT COALESCE(NULLIF(TRIM(v.full_name),''), NULLIF(TRIM(d.customer_name),'')) AS clean_name,
			         COALESCE(NULLIF(v.phone,''), NULLIF(c.phone,''))                         AS phone,
			         right(regexp_replace(COALESCE(COALESCE(NULLIF(v.phone,''), c.phone),''),'\D','','g'),10) AS norm_phone,
			         d.cif                                                                    AS cif,
			         d.party_id                                                               AS party_id,
			         d.product_name                                                           AS product_name,
			         d.dpd                                                                    AS dpd,
			         d.outstanding_kobo                                                       AS outstanding_kobo
			  FROM app.collections_delinquent_unified d
			  LEFT JOIN app.v_contact_identity v ON v.party_id = d.party_id
			  LEFT JOIN app.customers c          ON c.cif = d.cif
			  WHERE d.dpd > 0 AND d.outstanding_kobo > 0
			) x
			WHERE length(norm_phone) = 10
			  AND ` + ccNotOnDNCExpr("x.phone") + `
			  AND NOT EXISTS (
			    SELECT 1 FROM call_center_contacts t
			    WHERE right(regexp_replace(COALESCE(t.phone,''),'\D','','g'),10) = x.norm_phone
			      AND COALESCE(t.purpose,'marketing') = 'collections'
			      AND t.status = 'pending'
			  )
			ORDER BY norm_phone, dpd DESC`)
		if err != nil {
			respondErr(w, 500, "Collections sync failed: "+err.Error())
			return
		}
		n, _ := res.RowsAffected()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"inserted": n}) //nolint:errcheck
	}
}

// ccImportContacts adds contacts from a manual/CSV upload under a chosen purpose,
// so heads can load an internal list without routing through Zoho. Deduped per
// purpose; DNC-suppressed; requires a valid 10-digit phone.
func ccImportContacts(db *core.DB) http.HandlerFunc {
	type contact struct {
		Name    string `json:"name"`
		Phone   string `json:"phone"`
		CIF     string `json:"cif"`
		Product string `json:"product"`
		State   string `json:"state"`
	}
	type body struct {
		Purpose  string    `json:"purpose"`
		Contacts []contact `json:"contacts"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil || len(b.Contacts) == 0 {
			respondErr(w, 400, "contacts are required")
			return
		}
		// Bounded: this loops one DB round-trip per element, so an unbounded upload
		// holds a request open for as long as the file is large.
		if len(b.Contacts) > ccMaxBulkIDs {
			respondErr(w, 422, fmt.Sprintf("too many contacts in one upload (max %d)", ccMaxBulkIDs))
			return
		}
		purpose := b.Purpose
		switch purpose {
		case "marketing", "collections", "support":
		default:
			purpose = "marketing"
		}
		inserted, skipped := 0, 0
		for _, c := range b.Contacts {
			if strings.TrimSpace(c.Phone) == "" {
				skipped++
				continue
			}
			product := strings.TrimSpace(c.Product)
			if product == "" {
				product = "Manual Import"
			}
			res, err := db.PGExec(r.Context(),
				`INSERT INTO call_center_contacts
				   (customer_name, phone, cif, product_name, state, priority, is_existing_customer, status, purpose, source)
				 SELECT $1,$2,NULLIF($3,''),$4,NULLIF($6,''),'Medium',(NULLIF($3,'') IS NOT NULL),'pending',$5,'manual'
				 WHERE length(right(regexp_replace($2,'\D','','g'),10))=10
				   AND `+ccNotOnDNCExpr("$2")+`
				   AND NOT EXISTS (
				     SELECT 1 FROM call_center_contacts t
				     WHERE right(regexp_replace(COALESCE(t.phone,''),'\D','','g'),10) = right(regexp_replace($2,'\D','','g'),10)
				       AND COALESCE(t.purpose,'marketing') = $5
				   )`,
				strings.TrimSpace(c.Name), c.Phone, strings.TrimSpace(c.CIF), product, purpose, strings.TrimSpace(c.State))
			if err != nil {
				skipped++
				continue
			}
			if k, _ := res.RowsAffected(); k > 0 {
				inserted++
			} else {
				skipped++
			}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"inserted": inserted, "skipped": skipped}) //nolint:errcheck
	}
}

// ccImportLeads bulk-uploads a marketing lead list onto the Leads board. Heads run
// this to seed a campaign's leads from a spreadsheet — the page had no way to get
// leads in except "push from a campaign report", so a supervisor with a CSV was stuck.
//
// Deduped by phone within call_center_leads so re-uploading the same file doesn't
// double the board. A row with no name AND no phone is skipped (nothing to dial).
// ccImportLeads takes an uploaded lead list.
//
// A lead is not a customer. The import used to ask for a CIF and an employer —
// a cold lead has neither, and a CIF is the card book's identity key, which
// nothing should be inventing at upload time. What a lead has is a way to reach
// them, so the accepted fields are phone (required), name, email and address.
//
// Phone is normalised to the Nigerian national format on the way in, so the book
// stops holding the same number in four different shapes.
func ccImportLeads(db *core.DB) http.HandlerFunc {
	type lead struct {
		Name    string `json:"name"`
		Phone   string `json:"phone"`
		Email   string `json:"email"`
		Address string `json:"address"`
		State   string `json:"state"`
	}
	type body struct {
		CampaignID *int64 `json:"campaign_id"`
		Leads      []lead `json:"leads"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil || len(b.Leads) == 0 {
			respondErr(w, 400, "leads are required")
			return
		}
		// Bounded for the same reason as the contact import: one round-trip per lead.
		if len(b.Leads) > ccMaxBulkIDs {
			respondErr(w, 422, fmt.Sprintf("too many leads in one upload (max %d)", ccMaxBulkIDs))
			return
		}
		inserted, attached, skipped, noPhone := 0, 0, 0, 0
		for _, l := range b.Leads {
			name := strings.TrimSpace(l.Name)
			phone := normaliseNGPhone(l.Phone)

			// Phone is the one genuinely required field: a lead with no number
			// cannot be called, which is the only thing the outbound queue does.
			if phone == "" {
				noPhone++
				skipped++
				continue
			}
			if name == "" {
				// A nameless lead is fine — the agent adds the name on the call.
				// Showing the number is better than showing an empty row.
				name = phone
			}

			res, err := db.PGExec(r.Context(),
				`INSERT INTO call_center_leads
				   (campaign_id, customer_name, customer_phone, email, address, state, lead_score, status)
				 SELECT $1, $2, $3, NULLIF($4,''), NULLIF($5,''), NULLIF($6,''), 0, 'pending'
				 WHERE NOT EXISTS (
				      SELECT 1 FROM call_center_leads t
				      WHERE right(regexp_replace(COALESCE(t.customer_phone,''),'\D','','g'),10)
				          = right(regexp_replace($3,'\D','','g'),10)
				    )
				   -- A number that has opted out must not re-enter the book through an
				   -- upload. The lead book had no DNC check anywhere: only the queue
				   -- filtered the list, so a listed number could be imported freely and
				   -- then served to an agent from Leads.
				   AND `+ccNotOnDNCExpr("$3")+``,
				b.CampaignID, name, phone, strings.TrimSpace(l.Email), strings.TrimSpace(l.Address), strings.TrimSpace(l.State))
			if err != nil {
				skipped++
				continue
			}
			if k, _ := res.RowsAffected(); k > 0 {
				inserted++
				continue
			}

			// The number is already on the board. If this upload is INTO a campaign and
			// the existing lead has none yet, adopt it into this campaign rather than
			// silently dropping it — otherwise re-uploading a list under a campaign
			// leaves that campaign empty (the exact bug this fixes). A lead already in a
			// different campaign is left alone (moving it would be surprising).
			if b.CampaignID != nil {
				ures, uerr := db.PGExec(r.Context(),
					`UPDATE call_center_leads
					    SET campaign_id = $1, updated_at = NOW()
					  WHERE right(regexp_replace(COALESCE(customer_phone,''),'\D','','g'),10)
					      = right(regexp_replace($2,'\D','','g'),10)
					    AND campaign_id IS NULL`,
					*b.CampaignID, phone)
				if uerr == nil {
					if uk, _ := ures.RowsAffected(); uk > 0 {
						attached++
						continue
					}
				}
			}
			skipped++
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"inserted": inserted,
			// Existing campaign-less leads adopted into this campaign by a re-upload.
			"attached": attached,
			"skipped":  skipped,
			// Reported separately so "12 skipped" can be explained rather than
			// leaving the uploader to guess whether they were duplicates.
			"no_phone": noPhone,
		})
	}
}

// normaliseNGPhone is the Go twin of app.normalise_ng_phone: 0 + the last 10
// digits. Returns "" when there are too few digits to be a phone number, which is
// what makes phone genuinely required at import.
func normaliseNGPhone(raw string) string {
	digits := make([]rune, 0, len(raw))
	for _, r := range raw {
		if r >= '0' && r <= '9' {
			digits = append(digits, r)
		}
	}
	if len(digits) < 10 {
		return ""
	}
	return "0" + string(digits[len(digits)-10:])
}

// ccAddCallback queues a support call-back — an explicit push from a ticket (or an
// ad-hoc customer) so the agent who owns the conversation can get them called back.
// When a ticket_id is given, the customer + ref are pulled from the ticket.
func ccAddCallback(db *core.DB) http.HandlerFunc {
	type body struct {
		TicketID   int64  `json:"ticket_id"`
		Name       string `json:"name"`
		Phone      string `json:"phone"`
		CIF        string `json:"cif"`
		CallbackAt string `json:"callback_at"` // scheduled time (optional); empty = call-back ASAP
		Notes      string `json:"notes"`
		Purpose    string `json:"purpose"` // marketing | collections | support (default support)
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		// Assign the callback to whoever scheduled it, so it lands in THEIR queue when due.
		var assignedTo *int64
		if u := core.UserFromCtx(r.Context()); u != nil {
			assignedTo = &u.ID
		}
		name, phone, cif, ref := strings.TrimSpace(b.Name), strings.TrimSpace(b.Phone), strings.TrimSpace(b.CIF), ""
		if b.TicketID != 0 {
			if tr, _ := db.PGQuery(r.Context(),
				`SELECT customer_name, customer_phone, customer_cif, ticket_ref FROM helpdesk_tickets WHERE id=$1`, b.TicketID); len(tr) > 0 {
				if name == "" {
					name = str(tr[0]["customer_name"])
				}
				if phone == "" {
					phone = str(tr[0]["customer_phone"])
				}
				if cif == "" {
					cif = str(tr[0]["customer_cif"])
				}
				ref = str(tr[0]["ticket_ref"])
			}
		}
		if phone == "" {
			respondErr(w, 400, "phone is required (or a ticket_id with a phone on file)")
			return
		}
		// A number that has opted out must not be injected back into the dial queue,
		// whatever screen asks for it. This endpoint had no suppression check at all,
		// so it was a way to put a listed number in front of an agent.
		np := normalizePhone(phone)
		if len(np) != 10 {
			respondErr(w, 422, "That is not a number we can call — 10 digits are required")
			return
		}
		if listed, _ := db.PGQuery(r.Context(),
			`SELECT 1 FROM dnc_list WHERE norm_phone(phone) = $1 LIMIT 1`, np); len(listed) > 0 {
			respondErr(w, 422, "That number is on the Do Not Call list")
			return
		}
		// Carry the call's purpose so a collections/marketing call-back isn't dumped into
		// the support queue and mis-routed. Default to support (the ticket/customer path).
		purpose := strings.ToLower(strings.TrimSpace(b.Purpose))
		if purpose != "marketing" && purpose != "collections" && purpose != "sales" {
			purpose = "support"
		}
		label := map[string]string{"marketing": "Marketing Call-back", "sales": "Sales Call-back", "collections": "Collections Call-back", "support": "Support Call-back"}[purpose]
		// source is PROVENANCE, not purpose. The insert bound $9 (the purpose) into
		// both columns, so every call-back's source read "support"/"marketing" and the
		// queue could not tell one raised from a ticket from one typed in by hand.
		source := "manual"
		if b.TicketID != 0 {
			source = "ticket"
		}
		rows, err := db.PGQuery(r.Context(),
			`INSERT INTO call_center_contacts
			   (customer_name, phone, cif, product_name, priority, is_existing_customer, status, purpose, source, ref, callback_at, notes, assigned_to)
			 VALUES ($1,$2,NULLIF($3,''),$8,'High',(NULLIF($3,'') IS NOT NULL),'pending',$9,$10,NULLIF($4,''),NULLIF($5,'')::timestamptz,NULLIF($6,''),$7)
			 RETURNING id`,
			name, phone, cif, ref, strings.TrimSpace(b.CallbackAt), strings.TrimSpace(b.Notes), assignedTo, label, purpose, source)
		if err != nil || len(rows) == 0 {
			respondErrLog(w, 500, "Could not add call-back", err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(map[string]any{"id": rows[0]["id"]}) //nolint:errcheck
	}
}

// ccCooldownDays is how long a contact rests after a call before the queue offers it
// again. Without it the list is ordered by data the queue never had: before migration
// 144 every contact reported "never called" while 13,669 of them had been dialled
// 97,938 times, so agents were re-serving numbers called hours earlier.
const ccCooldownDays = 7

// ccExhaustedAttempts is the point at which repeat dialling stops being worth an
// agent's minute — this many attempts with not one connect. 3,773 marketing contacts
// were past it at backfill, one collections number at 229 attempts.
const ccExhaustedAttempts = 6

// ccMaxBulkIDs caps one bulk action. Every bulk endpoint here built a bind parameter
// per element with no limit, and Postgres refuses a statement carrying more than
// 65,535 of them — so a large selection failed inside the driver with nothing the
// supervisor could act on. The array form these now use removes the parameter cap
// entirely; this bounds the work (and, for DNC removals, the audit volume).
const ccMaxBulkIDs = 5000

// ccMaxDistribute bounds one round-robin distribution, matching the queue's own cap
// in ccDistributeQueue. The lead distributor had no bound at all.
const ccMaxDistribute = 20000

// ccLeadStatuses is the vocabulary call_center_leads_status_chk enforces (migration
// 254). Validated in Go so a typo comes back as a clean 400 rather than tripping the
// constraint and reaching the agent as an uninterpretable 500.
var ccLeadStatuses = map[string]bool{
	"pending": true, "called": true, "interested": true, "not_ready": true,
	"callback": true, "no_answer": true, "converted": true, "closed": true,
	"invalid": true, "dnc": true,
}

// ccLeadStatusRank orders lead statuses by how far through the funnel they are, so a
// later call can advance a lead but never walk it backwards. Terminal outcomes share
// the top rank: a customer who has converted may still ask never to be called again.
var ccLeadStatusRank = map[string]int{
	"pending": 0, "no_answer": 1, "called": 1, "not_ready": 2,
	"callback": 3, "interested": 4,
	"converted": 5, "closed": 5, "invalid": 5, "dnc": 5,
}

// ccLeadStatusRankSQL mirrors ccLeadStatusRank inside the UPDATE, so the forward-only
// comparison happens in the statement and cannot race a concurrent writer.
const ccLeadStatusRankSQL = `CASE status
	                           WHEN 'pending'    THEN 0
	                           WHEN 'no_answer'  THEN 1
	                           WHEN 'called'     THEN 1
	                           WHEN 'not_ready'  THEN 2
	                           WHEN 'callback'   THEN 3
	                           WHEN 'interested' THEN 4
	                           ELSE 5
	                         END`

func ccListQueue(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		priority := qstr(r, "priority")
		disposition := qstr(r, "disposition")
		dpdRange := qstr(r, "dpd")
		search := qstr(r, "search")
		purpose := qstr(r, "purpose")
		bucket := qstr(r, "bucket")
		limit := qint(r, "limit", 200, 1, 500)
		// Paging. The queue capped at 500 rows with no OFFSET, so 14,751 of 14,951
		// contacts were simply unreachable through the UI.
		offset := qint(r, "offset", 0, 0, 100_000_000)
		cooldown := qint(r, "cooldown_days", ccCooldownDays, 0, 90)

		// Derived flags travel with each row so the UI can badge a contact without
		// re-deriving the thresholds and drifting from the ordering below.
		sel := fmt.Sprintf(`SELECT id, customer_name, phone, cif, product_name, state,
		             priority, outstanding_kobo, dpd, is_existing_customer,
		             loan_product, next_payment_date, last_disposition, last_called_at,
		             attempts, connects, last_call_outcome, disposition_code, callback_at,
		             COALESCE(last_called_at > NOW() - INTERVAL '%d days', FALSE) AS is_cooling,
		             (attempts >= %d AND connects = 0)                             AS is_exhausted,
		             (callback_at IS NOT NULL AND callback_at <= NOW())            AS callback_due,
		             COALESCE(purpose,'marketing') AS purpose, COALESCE(source,'zoho_crm') AS source, ref
		      FROM call_center_contacts
		      WHERE status = 'pending'
		        AND `+ccNotOnDNCExpr("phone"), cooldown, ccExhaustedAttempts)
		q := sel
		var args []any
		n := 1
		cond := ""

		// Row scope: an agent's queue shows ONLY the contacts assigned to her; heads
		// see the whole queue and may focus one agent via ?agent_id=.
		//
		// Held SEPARATELY from the other filters because the per-purpose tab counts
		// below must apply the scope while dropping everything else. They were applying
		// neither, so an agent's tabs showed floor-wide totals that could never match
		// the list underneath them.
		user := core.UserFromCtx(r.Context())
		scopeCond := ""
		var scopeArgs []any
		if user != nil && !ccIsSupervisor(user) {
			scopeCond = fmt.Sprintf(" AND assigned_to=$%d", n)
			scopeArgs = append(scopeArgs, user.ID)
			n++
		} else if av := qstr(r, "agent_id"); av != "" {
			scopeCond = fmt.Sprintf(" AND assigned_to=$%d", n)
			scopeArgs = append(scopeArgs, av)
			n++
		}
		cond += scopeCond
		args = append(args, scopeArgs...)

		if priority != "" {
			cond += fmt.Sprintf(" AND priority=$%d", n)
			args = append(args, priority)
			n++
		}
		if purpose != "" {
			cond += fmt.Sprintf(" AND COALESCE(purpose,'marketing')=$%d", n)
			args = append(args, purpose)
			n++
		}
		if disposition != "" {
			// Match the canonical code, not the display label — the label is presentation
			// and changing its wording would silently break every saved filter.
			cond += fmt.Sprintf(" AND disposition_code=$%d", n)
			args = append(args, disposition)
			n++
		}
		switch dpdRange {
		case "1-30":
			cond += " AND dpd BETWEEN 1 AND 30"
		case "31-60":
			cond += " AND dpd BETWEEN 31 AND 60"
		case "61-90":
			cond += " AND dpd BETWEEN 61 AND 90"
		case "90+":
			cond += " AND dpd > 90"
		}
		if search != "" {
			if clause, sargs, nn := buildCustomerSearch(search,
				[]string{"customer_name", "phone"}, "phone", n); clause != "" {
				cond += " AND " + clause
				args = append(args, sargs...)
				n = nn
			}
		}
		if from := qstr(r, "from"); from != "" {
			cond += fmt.Sprintf(" AND created_at::date >= $%d::date", n)
			args = append(args, from)
			n++
		}
		if to := qstr(r, "to"); to != "" {
			cond += fmt.Sprintf(" AND created_at::date <= $%d::date", n)
			args = append(args, to)
			n++
		}

		// Buckets are the queue's working views, kept out of `cond` so the chips below
		// keep reporting every bucket's size while one of them is selected — the same
		// reason the purpose tabs drop the purpose filter. "ready" is what an agent
		// should actually dial: never called or rested past the cooldown, and not a
		// number that has already swallowed ccExhaustedAttempts tries without one answer.
		bucketCond := ""
		switch bucket {
		case "ready":
			// A due call-back is always ready — the customer named a time, so neither the
			// cooldown nor the exhausted-number rule should hold it back. A future
			// call-back is still cooling from the call that set it, so it stays out. Cold
			// dials are the usual "never called, or rested, and not exhausted" set.
			// (Call-backs float to the top via the ORDER BY, and also carry their own
			// disposition filter + the due-now popup — so they need no separate tile.)
			bucketCond = fmt.Sprintf(" AND ((callback_at IS NOT NULL AND callback_at <= NOW())"+
				" OR (callback_at IS NULL"+
				"     AND (last_called_at IS NULL OR last_called_at <= NOW() - INTERVAL '%d days')"+
				"     AND NOT (attempts >= %d AND connects = 0)))", cooldown, ccExhaustedAttempts)
		case "uncalled":
			bucketCond = " AND attempts = 0"
		case "cooling":
			bucketCond = fmt.Sprintf(" AND last_called_at > NOW() - INTERVAL '%d days'", cooldown)
		case "exhausted":
			bucketCond = fmt.Sprintf(" AND attempts >= %d AND connects = 0", ccExhaustedAttempts)
		}

		// Summary over the full filtered pool — powers the queue's stat chips so they
		// reflect the whole backlog, not just the loaded page. Counted from the
		// call-derived columns, so "uncalled" now means nobody has ever dialled this
		// number rather than "the queue never recorded dialling it".
		//
		// The bucket filter is deliberately excluded here: the chips are the navigation
		// between buckets, so each has to keep reporting its own size while another is
		// selected — the same reason the purpose tabs drop the purpose filter below.
		summary := map[string]any{"total": 0, "uncalled": 0, "contacted": 0, "cooling": 0,
			"exhausted": 0, "ready": 0, "callbacks": 0, "callbacks_due": 0,
			"marketing": 0, "collections": 0, "support": 0}
		if sr, _ := db.PGQuery(r.Context(),
			fmt.Sprintf(`SELECT COUNT(*) AS total,
			        COUNT(*) FILTER (WHERE attempts = 0)                  AS uncalled,
			        COUNT(*) FILTER (WHERE attempts > 0)                  AS contacted,
			        COUNT(*) FILTER (WHERE last_called_at > NOW() - INTERVAL '%d days') AS cooling,
			        COUNT(*) FILTER (WHERE attempts >= %d AND connects = 0)             AS exhausted,
			        COUNT(*) FILTER (WHERE (callback_at IS NOT NULL AND callback_at <= NOW())
			                            OR (callback_at IS NULL
			                              AND (last_called_at IS NULL
			                                OR last_called_at <= NOW() - INTERVAL '%d days')
			                              AND NOT (attempts >= %d AND connects = 0)))       AS ready,
			        COUNT(*) FILTER (WHERE callback_at IS NOT NULL AND callback_at <= NOW()) AS callbacks_due,
			        COUNT(*) FILTER (WHERE callback_at IS NOT NULL)       AS callbacks
			 FROM call_center_contacts
			 WHERE status = 'pending' AND `+ccNotOnDNCExpr("phone"),
				cooldown, ccExhaustedAttempts, cooldown, ccExhaustedAttempts)+cond, args...); len(sr) > 0 {
			summary = sr[0]
		}
		// Per-purpose backlog drops the purpose filter so the segmentation tabs always
		// show each segment's count even when one is active — but it KEEPS the agent
		// row scope, or an agent's tabs report the whole floor's backlog.
		if pr, _ := db.PGQuery(r.Context(),
			`SELECT COALESCE(purpose,'marketing') AS purpose, COUNT(*) AS n
			 FROM call_center_contacts
			 WHERE status='pending' AND `+ccNotOnDNCExpr("phone")+scopeCond+`
			 GROUP BY 1`, scopeArgs...); len(pr) > 0 {
			for _, row := range pr {
				switch str(row["purpose"]) {
				case "marketing":
					summary["marketing"] = row["n"]
				case "collections":
					summary["collections"] = row["n"]
				case "support":
					summary["support"] = row["n"]
				}
			}
		}

		q += cond + bucketCond
		// Serving order, worst-first-to-dial last:
		//   1. exhausted numbers sink (attempts spent, never once answered),
		//   2. then anything still cooling from a recent attempt,
		//   3. then never-called before rested, oldest attempt first,
		//   4. then the existing priority / DPD tie-breaks.
		// The old clause led with `last_called_at IS NOT NULL` on a column that was NULL
		// for every row, so it sorted nothing and the queue fell through to priority.
		// COALESCE is load-bearing: `last_called_at > ...` is NULL for a never-called
		// contact, and Postgres sorts NULL last in an ASC order — which would bury the
		// never-called contacts (the ones an agent most wants) beneath every cooling one.
		//
		// A due callback outranks everything: the customer named a time and we agreed to
		// it, so it must beat even a never-called contact, and must not be held back by
		// the cooldown the call that scheduled it just started.
		// The order already terminates in `id`, which is what makes paging safe: every
		// preceding key can tie, and without a unique final key two pages could repeat
		// or skip rows as contacts are worked between requests.
		q += fmt.Sprintf(` ORDER BY (callback_at IS NULL OR callback_at > NOW()),
		         (attempts >= %d AND connects = 0),
		         COALESCE(last_called_at > NOW() - INTERVAL '%d days', FALSE),
		         last_called_at ASC NULLS FIRST,
		         CASE priority WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END,
		         dpd DESC, id LIMIT $%d OFFSET $%d`, ccExhaustedAttempts, cooldown, n, n+1)
		args = append(args, limit, offset)

		rows, err := db.PGQuery(r.Context(), q, args...)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": rows, "summary": summary}) //nolint:errcheck
	}
}

// ccContactCalls returns a contact's real call trail. All telephony — including the
// queue's own manually-logged dispositions (ccLogCall now writes them into
// helpdesk_calls) — lives in helpdesk_calls, matched by the last 10 digits of the
// phone. The panel shows every touch: direction, purpose, outcome, agent, duration
// and any recording.
func ccContactCalls(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		// Same parent-row scope the queue list applies — this returned any contact's
		// full call trail to any agent for the asking.
		if !ccIsSupervisor(user) {
			if own, _ := db.PGQuery(r.Context(),
				`SELECT 1 FROM call_center_contacts WHERE id=$1 AND assigned_to=$2`, id, user.ID); len(own) == 0 {
				respondErr(w, 404, "Contact not found")
				return
			}
		}
		rows, err := db.PGQuery(r.Context(),
			`WITH c AS (
			   SELECT right(regexp_replace(COALESCE(phone,''),'\D','','g'),10) AS np
			   FROM call_center_contacts WHERE id=$1
			 )
			 SELECT hc.id,
			        hc.started_at                                        AS called_at,
			        COALESCE(hc.duration_sec,0)                          AS duration_seconds,
			        -- Prefer the business disposition; fall back to the raw outcome only
			        -- when there isn't one. This is what the edit form seeds from, so it
			        -- must be the agent's conclusion, not the telephony result.
			        COALESCE(NULLIF(hc.disposition,''),NULLIF(hc.outcome,''),'Call') AS disposition,
			        COALESCE(hc.resolution,'')                           AS resolution,
			        COALESCE(NULLIF(hc.agent_name,''),'Unknown')         AS agent_name,
			        hc.direction                                         AS direction,
			        hc.purpose                                           AS purpose,
			        hc.recording_url                                     AS recording_url,
			        hc.notes                                             AS notes,
			        'telephony'                                          AS log_source
			 FROM helpdesk_calls hc, c
			 WHERE length(c.np)=10
			   AND right(regexp_replace(COALESCE(hc.customer_phone,''),'\D','','g'),10) = c.np
			 ORDER BY called_at DESC NULLS LAST
			 LIMIT 100`, id)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": rows}) //nolint:errcheck
	}
}

func ccLogCall(db *core.DB) http.HandlerFunc {
	type body struct {
		Disposition   string  `json:"disposition"`
		Notes         string  `json:"notes"`
		PTPDate       *string `json:"ptp_date"`
		PTPAmountKobo *int64  `json:"ptp_amount_kobo"`
		CallbackAt    *string `json:"callback_at"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil || b.Disposition == "" {
			respondErr(w, 400, "disposition is required")
			return
		}
		// Validate against the canonical vocabulary. Previously any string was accepted
		// and written straight to last_disposition, so a typo became a permanent value
		// that no filter would ever match.
		disp, ok := ccDispositionByCode(b.Disposition)
		if !ok {
			respondErr(w, 400, "unknown disposition: "+b.Disposition)
			return
		}
		ctx := r.Context()
		user := core.UserFromCtx(ctx)

		// Pull the contact so the call lands in the ledger with customer context — and
		// the lead it belongs to, which migration 254 added. That link is what lets a
		// call logged from the QUEUE qualify a lead; without it the queue was a
		// dead end.
		var name, phone, cif, purpose string
		var leadID int64
		if rows, _ := db.PGQuery(ctx,
			`SELECT COALESCE(customer_name,'') n, COALESCE(phone,'') p, COALESCE(cif,'') c,
			        COALESCE(NULLIF(purpose,''),'marketing') pu, COALESCE(lead_id,0) lid
			 FROM call_center_contacts WHERE id=$1`, id); len(rows) > 0 {
			name, phone, cif, purpose = str(rows[0]["n"]), str(rows[0]["p"]), str(rows[0]["c"]), str(rows[0]["pu"])
			leadID = toInt64(rows[0]["lid"])
		}
		var agentID *int64
		agentName := ""
		if user != nil {
			agentID, agentName = &user.ID, user.FullName
		}

		// A queue disposition IS a call — record it in the single call ledger
		// (helpdesk_calls) so it shows on agent stats, the customer 360 timeline and
		// QA, exactly like a Zoho or inbound call. This retires call_center_call_logs.
		//
		// outcome stays in the ledger's own two-value vocabulary (completed | missed,
		// what Zoho supplies) rather than the disposition label, because connect rates
		// across the module — including ccStampQueueForPhone's `connects` — are counted
		// as outcome='completed'. Writing "Answered — Interested" here would make a
		// connected call read as a non-connect everywhere. The richer label rides in
		// notes and on the contact row, so nothing is lost.
		outcome := ccCallOutcome(disp)
		notes := strings.TrimSpace(disp.Label + " — " + b.Notes)
		// disposition and lead_id are written HERE, not left blank. Omitting them is
		// what made a queue "Interested" produce nothing downstream: no CRM stage move,
		// no hand-off row, no party, and a blank disposition on every export. Live data
		// confirmed it — 0 of 44 queue-logged calls carried a disposition.
		//
		// duration_sec is NULL, never 0. Migration 159 settled that the column means
		// TALK TIME and must be NULL when unknown: 0 says "connected, said nothing",
		// which is a measurement we did not take, and it dragged the average talk time
		// down on every surface that averages duration BETWEEN 0 AND 14400.
		callRows, err := db.PGQuery(ctx,
			`INSERT INTO helpdesk_calls
			   (agent_id, agent_name, customer_name, customer_cif, customer_phone,
			    direction, duration_sec, outcome, disposition, notes, purpose,
			    source_system, lead_id)
			 VALUES ($1,$2,$3,$4,$5,'outbound',NULL,$6,$7,$8,$9,'call_center',NULLIF($10,0))
			 RETURNING id`,
			agentID, agentName, name, cif, phone, outcome, disp.Label, notes, purpose, leadID)
		if err != nil || len(callRows) == 0 {
			respondErrLog(w, 500, "Insert failed", err)
			return
		}
		callID := toInt64(callRows[0]["id"])

		// A promise-to-pay belongs in the Collections promise book, not a call log —
		// route it there (keyed by CIF) so it actually reaches Collections.
		if b.PTPAmountKobo != nil && *b.PTPAmountKobo > 0 && b.PTPDate != nil && *b.PTPDate != "" && cif != "" {
			db.PGExec(ctx, //nolint:errcheck
				`INSERT INTO collection_promises (cif_number, agent_user_id, promised_amount_kobo, promised_date, created_at)
				 VALUES ($1,$2,$3,$4,NOW())`,
				cif, agentID, *b.PTPAmountKobo, *b.PTPDate)
		} else if b.PTPAmountKobo != nil && *b.PTPAmountKobo > 0 && cif == "" {
			// The promise book is keyed by CIF; a marketing contact with no CIF would drop
			// the promised amount/date silently. Surface it rather than lose it quietly.
			slog.Warn("ccLogCall: promise-to-pay not recorded — contact has no CIF",
				"contact", id, "amount_kobo", *b.PTPAmountKobo)
		}

		// Apply the disposition's consequences — close it out, mark it invalid, schedule
		// the callback, suppress the number. This is what makes logging worth an agent's
		// time; before, every disposition left the contact exactly where it was.
		var userID *int64
		if user != nil {
			userID = &user.ID
		}
		ccApplyDisposition(ctx, db, id, disp, phone, b.CallbackAt, userID)

		// Take the queue call all the way through qualification, exactly as the Leads
		// path does. syncLeadFromCall is the ONE place that advances the lead, writes
		// call_center_dispositions (so the Performance screens stop disagreeing with the
		// Call Log), moves the CRM stage, creates the party and records the hand-off.
		// Calling it here is what closes the gap between "an agent marked them
		// Interested" and anything happening as a result.
		//
		// No double-write: this is the only path that runs for a queue log, and the
		// tables it touches (the lead book, the disposition ledger) are ones ccLogCall
		// never wrote. ccApplyDisposition above owns the CONTACT row; this owns the LEAD.
		if leadID > 0 {
			callbackAt := ""
			if b.CallbackAt != nil {
				callbackAt = *b.CallbackAt
			}
			// durationSec is nil — a queue call has no measured talk time, and
			// syncLeadFromCall keeps a NULL out of the handle-time average.
			syncLeadFromCall(ctx, db, leadID, outcome, &disp.Label, callbackAt, agentID, nil, callID)
		}

		// The call above went into helpdesk_calls, so recompute the counters from it
		// rather than stamping last_called_at here — one source of truth, one path.
		ccStampQueueForPhone(ctx, db, phone)

		w.WriteHeader(201)
	}
}

func ccBulkSkip(db *core.DB) http.HandlerFunc {
	type body struct {
		IDs []int64 `json:"ids"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil || len(b.IDs) == 0 {
			respondErr(w, 400, "ids are required")
			return
		}
		if len(b.IDs) > ccMaxBulkIDs {
			respondErr(w, 422, fmt.Sprintf("too many contacts in one request (max %d)", ccMaxBulkIDs))
			return
		}

		// Skipping is bounded three ways it previously was not: to contacts the agent
		// actually owns, to ones still 'pending' (skipping an already closed or invalid
		// contact would overwrite a real resolution with a shrug), and by one array
		// parameter rather than a bind parameter per id.
		where := "id = ANY($1) AND status='pending'"
		args := []any{b.IDs}
		if !ccIsSupervisor(user) {
			where += " AND assigned_to=$2"
			args = append(args, user.ID)
		}
		rows, err := db.PGQuery(r.Context(),
			`UPDATE call_center_contacts SET status='skipped', updated_at=NOW()
			  WHERE `+where+` RETURNING id`, args...)
		if err != nil {
			respondErrLog(w, 500, "Skip failed", err)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		// Rows actually skipped, not the size of the request — these differ whenever a
		// contact is someone else's or already resolved.
		json.NewEncoder(w).Encode(map[string]any{"skipped": len(rows)}) //nolint:errcheck
	}
}

// ── DNC extras ────────────────────────────────────────────────────────────────

func ccDNCKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT
			  COUNT(*)                                                                AS total_dnc,
			  COUNT(*) FILTER (WHERE added_at >= date_trunc('month', NOW()))         AS added_this_month,
			  -- Opt-outs captured by agents dispositioning "Do Not Call" on a live call
			  -- (ccApplyDisposition tags these), vs numbers added by hand. A real signal,
			  -- unlike the old hardcoded 0 "bulk removes" (nothing tracked deletes).
			  COUNT(*) FILTER (WHERE reason ILIKE 'Agent disposition%')              AS from_calls
			FROM dnc_list`)
		if err != nil || len(rows) == 0 {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": rows[0]}) //nolint:errcheck
	}
}

func ccBulkRemoveDNC(db *core.DB) http.HandlerFunc {
	type body struct {
		Phones []string `json:"phones"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if !ccIsSupervisor(user) {
			respondErr(w, 403, "Only a call-centre supervisor can change the Do Not Call list")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil || len(b.Phones) == 0 {
			respondErr(w, 400, "phones are required")
			return
		}
		if len(b.Phones) > ccMaxBulkIDs {
			respondErr(w, 422, fmt.Sprintf("too many numbers in one request (max %d)", ccMaxBulkIDs))
			return
		}

		// Match on the canonical form, passed as ONE array parameter. The old code
		// compared the caller's raw text against the raw stored value with a bind
		// parameter per number, so it both capped out at Postgres's parameter limit
		// and failed to match any number stored in a different shape.
		norm := make([]string, 0, len(b.Phones))
		for _, phone := range b.Phones {
			if np := normalizePhone(phone); len(np) == 10 {
				norm = append(norm, np)
			}
		}
		if len(norm) == 0 {
			respondErr(w, 422, "None of those are numbers we can match")
			return
		}
		rows, err := db.PGQuery(r.Context(),
			`DELETE FROM dnc_list
			  WHERE norm_phone(phone) = ANY($1)
			 RETURNING phone, reason, added_by, added_at`, norm)
		if err != nil {
			respondErrLog(w, 500, "Delete failed", err)
			return
		}
		ccAuditDNCRemoval(r.Context(), db, user, rows)

		w.Header().Set("Content-Type", "application/json")
		// What was actually removed, not how many were asked for.
		json.NewEncoder(w).Encode(map[string]any{"removed": len(rows)}) //nolint:errcheck
	}
}

func ccPerformanceKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !ccIsSupervisor(core.UserFromCtx(r.Context())) {
			respondErr(w, 403, "Supervisors only")
			return
		}
		dateFrom, _ := validDate(r, "date_from")
		dateTo, _ := validDate(r, "date_to")
		agent := qstr(r, "agent")

		from := "call_center_dispositions d LEFT JOIN call_center_leads l ON l.id = d.lead_id"
		where := "1=1"
		var args []any
		n := 1

		if agent != "" {
			// Prefer an agent id; fall back to an EXACT name. The old '%name%' match
			// merged every agent whose name contains another's — two staff called
			// "Chidi" reported as one row, with one figure standing for both — and a
			// KPI tile is exactly where nobody notices that.
			if id, perr := strconv.ParseInt(agent, 10, 64); perr == nil && id > 0 {
				where += fmt.Sprintf(" AND d.agent_id = $%d", n)
				args = append(args, id)
			} else {
				from += " LEFT JOIN o3c_users u ON u.id = d.agent_id"
				where += fmt.Sprintf(" AND u.full_name = $%d", n)
				args = append(args, agent)
			}
			n++
		}
		if dateFrom != "" {
			where += fmt.Sprintf(" AND d.created_at::date >= $%d::date", n)
			args = append(args, dateFrom)
			n++
		}
		if dateTo != "" {
			where += fmt.Sprintf(" AND d.created_at::date <= $%d::date", n)
			args = append(args, dateTo)
			n++
		}
		_ = n

		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT
			  COUNT(*)                                                              AS total_calls,
			  COUNT(*) FILTER (WHERE app.cc_disposition_connected(d.outcome))       AS connected,
			  COUNT(*) FILTER (WHERE d.outcome = 'ptp')                            AS ptp_count,
			  -- Conversion is a LEAD outcome, not a disposition: measure the share of
			  -- leads worked in this window that are now converted.
			  CASE WHEN COUNT(DISTINCT d.lead_id) > 0 THEN
			    ROUND(100.0 * COUNT(DISTINCT d.lead_id) FILTER (WHERE l.status = 'converted')
			          / COUNT(DISTINCT d.lead_id), 1)
			  ELSE 0 END                                                            AS conversion_rate_pct
			FROM %s WHERE %s`, from, where), args...)
		if err != nil || len(rows) == 0 {
			respond(w, map[string]any{
				"total_calls": 0, "connected": 0, "ptp_count": 0, "conversion_rate_pct": 0.0,
			}, "pg")
			return
		}
		respond(w, rows[0], "pg")
	}
}

func ccByDisposition(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !ccIsSupervisor(core.UserFromCtx(r.Context())) {
			respondErr(w, 403, "Supervisors only")
			return
		}
		dateFrom, _ := validDate(r, "date_from")
		dateTo, _ := validDate(r, "date_to")

		where := "1=1"
		var args []any
		n := 1
		if dateFrom != "" {
			where += fmt.Sprintf(" AND created_at::date >= $%d::date", n)
			args = append(args, dateFrom)
			n++
		}
		if dateTo != "" {
			where += fmt.Sprintf(" AND created_at::date <= $%d::date", n)
			args = append(args, dateTo)
			n++
		}
		_ = n

		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT outcome AS code,
			       app.cc_disposition_label(outcome) AS disposition,
			       COUNT(*) AS count
			FROM call_center_dispositions
			WHERE %s
			GROUP BY outcome
			ORDER BY count DESC`, where), args...)
		if err != nil || rows == nil {
			rows = []map[string]any{}
		}
		respond(w, rows, "pg")
	}
}

func ccHourlyVolume(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !ccIsSupervisor(core.UserFromCtx(r.Context())) {
			respondErr(w, 403, "Supervisors only")
			return
		}
		date := qstr(r, "date")
		var rows []map[string]any
		var err error
		if date != "" {
			rows, err = db.PGQuery(r.Context(), `
				SELECT TO_CHAR(created_at, 'HH24:00') AS hour, COUNT(*) AS count
				FROM call_center_dispositions
				WHERE created_at::date = $1::date
				GROUP BY TO_CHAR(created_at, 'HH24:00')
				ORDER BY hour`, date)
		} else {
			rows, err = db.PGQuery(r.Context(), `
				SELECT TO_CHAR(created_at, 'HH24:00') AS hour, COUNT(*) AS count
				FROM call_center_dispositions
				WHERE created_at::date = CURRENT_DATE
				GROUP BY TO_CHAR(created_at, 'HH24:00')
				ORDER BY hour`)
		}
		if err != nil || rows == nil {
			rows = []map[string]any{}
		}
		respond(w, rows, "pg")
	}
}

func ccAgentPerformance(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !ccIsSupervisor(core.UserFromCtx(r.Context())) {
			respondErr(w, 403, "Supervisors only")
			return
		}
		dateFrom, _ := validDate(r, "date_from")
		dateTo, _ := validDate(r, "date_to")

		where := "1=1"
		var args []any
		n := 1
		if dateFrom != "" {
			where += fmt.Sprintf(" AND d.created_at::date >= $%d::date", n)
			args = append(args, dateFrom)
			n++
		}
		if dateTo != "" {
			where += fmt.Sprintf(" AND d.created_at::date <= $%d::date", n)
			args = append(args, dateTo)
			n++
		}
		_ = n

		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT
			  u.full_name                                                              AS agent_name,
			  COUNT(d.id)                                                              AS calls,
			  COUNT(d.id) FILTER (WHERE app.cc_disposition_connected(d.outcome))       AS connected,
			  COUNT(d.id) FILTER (WHERE d.outcome = 'ptp')                            AS ptp_count,
			  -- Conversion measured from the lead's actual status, not a phantom disposition,
			  -- and credited only to the agent who closed it (see ccLastDispositionOnLead) —
			  -- otherwise three agents on one converted lead each scored a conversion.
			  CASE WHEN COUNT(DISTINCT d.lead_id) > 0 THEN
			    ROUND(100.0 * COUNT(DISTINCT d.lead_id) FILTER (
			            WHERE l.status = 'converted' AND `+ccLastDispositionOnLead+`)
			          / COUNT(DISTINCT d.lead_id), 1)
			  ELSE 0 END                                                               AS conversion_pct,
			  -- Handle time over calls that actually recorded one (NULLs excluded), not 0-filled.
			  COALESCE(ROUND(AVG(d.duration_sec) FILTER (WHERE COALESCE(d.duration_sec,0) > 0)), 0) AS avg_handle_seconds
			FROM o3c_users u
			JOIN call_center_dispositions d ON d.agent_id = u.id
			LEFT JOIN call_center_leads l ON l.id = d.lead_id
			WHERE u.deleted_at IS NULL AND u.role = 'call_center_agent' AND %s
			GROUP BY u.id, u.full_name
			ORDER BY calls DESC
			LIMIT 50`, where), args...)
		if err != nil || rows == nil {
			rows = []map[string]any{}
		}
		respond(w, rows, "pg")
	}
}

// ── Lead sync from the shared call log ───────────────────────────────────────

// leadStatusFromCall maps a logged call onto a lead status.
//
// Both the outcome (did the call connect) and the disposition (what was the
// business result) can move a lead, and the disposition is the stronger signal —
// a connected call whose disposition is "Not Interested" is not simply "called".
// The Leads page used to have its own four-outcome vocabulary that existed
// nowhere else; this maps the shared vocabulary the whole call centre uses.
func leadStatusFromCall(outcome string, disposition *string) string {
	d := ""
	if disposition != nil {
		d = strings.ToLower(strings.TrimSpace(*disposition))
	}
	switch {
	case strings.Contains(d, "do not call"):
		return "dnc"
	case strings.Contains(d, "converted"):
		return "converted"
	case strings.Contains(d, "callback"):
		return "callback"
	case strings.Contains(d, "not eligible"):
		// A decline on our side: calling back will not change it.
		return "closed"
	case strings.Contains(d, "call dropped"), strings.Contains(d, "call_dropped"), strings.Contains(d, "dropped"):
		// The line was answered and then went dead within seconds. Nothing was
		// discussed, so the lead has not been worked — it goes back into the
		// queue to be dialled again rather than counting as a contact. Match the
		// label ("Call Dropped"), the code ("call_dropped") and any "dropped" phrasing
		// so the intent survives whichever form the caller sends.
		return "pending"
	case strings.Contains(d, "not ready"):
		// A timing objection, not a refusal — the lead stays workable and is
		// re-approached in a later cycle. Its own status so a supervisor can filter
		// the "not now, later" pile apart from plain "called".
		//
		// NOT "callback". Callback means a specific time the customer asked to be
		// rung back at, and the queue serves those ahead of everything else. "Not
		// Ready Yet" carries no time, so routing it to callback filled the callback
		// list with leads nobody had promised to ring, and buried the ones who had.
		// Only "Callback Scheduled", which collects a time, belongs there.
		return "not_ready"
	case strings.Contains(d, "not interested"):
		return "called"
	case strings.Contains(d, "interested"):
		// A warm lead worth chasing — its own status so it doesn't hide inside the
		// generic "called" pile the way it used to.
		return "interested"
	case strings.Contains(d, "wrong number"):
		return "invalid"
	case strings.Contains(d, "unreachable"), strings.Contains(d, "no answer"):
		return "no_answer"
	// Collections & support outcomes. Without these they all collapsed to the generic
	// "called", so a paid or promised account looked identical to an unworked one.
	case strings.Contains(d, "paid"):
		// Paid off — a positive close (mirrors "converted" for a marketing lead).
		return "converted"
	case strings.Contains(d, "resolved"), strings.Contains(d, "closed"):
		return "closed"
	case strings.Contains(d, "promise to pay"), strings.Contains(d, "dispute"):
		// Needs a follow-up call — surface it like a callback so it doesn't sink into
		// the "called" pile a supervisor can't act on.
		return "callback"
	}
	switch strings.ToLower(strings.TrimSpace(outcome)) {
	case "missed", "no_answer", "voicemail":
		return "no_answer"
	case "":
		return "called"
	}
	return "called"
}

// advanceLeadStatus moves a lead to the status a call implies WITHOUT re-recording the
// call (it is already in the ledger) — the light half of syncLeadFromCall used by the
// phone-matched rescue below. Guarded to status='pending' so it only ever RESCUES a
// lead that was called but never advanced; it never downgrades a lead already worked.
func advanceLeadStatus(ctx context.Context, db *core.DB, leadID int64, status, disposition string, calledAt any) {
	// Stamps last_disposition (durably) + last_called_at; stamping last_called_at is
	// also what drops the lead out of the worker's candidate query on the next sweep.
	if _, err := db.PGExec(ctx,
		`UPDATE call_center_leads
		    SET status           = $1,
		        last_disposition = COALESCE(NULLIF($4,''), last_disposition),
		        last_called_at   = COALESCE($2::timestamptz, last_called_at, NOW()),
		        callback_at      = CASE WHEN $1 IN ('callback','not_ready') THEN callback_at ELSE NULL END,
		        updated_at       = NOW()
		  WHERE id = $3 AND status = 'pending'`,
		status, calledAt, leadID, disposition); err != nil {
		// The rescue worker advances thousands of leads per sweep; a discarded error
		// here meant a systematic failure (a bad cast, a constraint) looked exactly
		// like "nothing needed advancing".
		slog.Error("advanceLeadStatus: update lead", "lead", leadID, "status", status, "err", err)
	}
}

// StartLeadAdvanceWorker fixes the 97% of calls that carry no lead_id. A call from Zoho
// Voice, the Call Log page, or the queue lands in helpdesk_calls matched only by number,
// so syncLeadFromCall (which needs an explicit lead_id) never ran and the lead sat in
// 'pending' though it had plainly been called — the reason an agent could dial 80 of her
// own leads and still show 500+ "pending". This rescues them: every couple of minutes it
// finds pending leads whose NUMBER has a newer call and advances the lead to what that
// call concluded, so one call moves the person however it was logged. Pending-only, so it
// never walks back a lead an agent has already worked; upgrades on a re-call are handled
// live by syncLeadFromCall on the explicit log.
func StartLeadAdvanceWorker(db *core.DB) {
	run := func() {
		// Same containment as the call-back worker: one bad lead must not retire the
		// rescue sweep permanently while the hub still reports it running.
		defer recoverPanic("lead_advance")
		ctx := context.Background()
		WorkerBeat(ctx, db, "lead_advance", "running", "", "")
		total := 0
		// seen guards against ever re-processing a lead in one sweep: if an advance
		// can't move a lead for any reason, its id is already seen, the batch yields no
		// fresh ids, and we stop — instead of looping on it until the backstop.
		seen := map[int64]bool{}
		for {
			rows, err := db.PGQuery(ctx, `
				SELECT l.id, lc.outcome, lc.disposition, lc.started_at
				  FROM call_center_leads l
				  JOIN LATERAL (
				    SELECT outcome, disposition, started_at
				      FROM helpdesk_calls hc
				     WHERE hc.voided_at IS NULL AND hc.merged_into_call_id IS NULL
				       AND `+normalizedPhoneExpr("hc.customer_phone")+` = `+normalizedPhoneExpr("l.customer_phone")+`
				       AND `+normalizedPhoneExpr("l.customer_phone")+` <> ''
				     ORDER BY hc.started_at DESC
				     LIMIT 1
				  ) lc ON true
				  -- The agent's own most recent disposition on this lead, if any. A lead the
				  -- agent explicitly logged was already advanced by syncLeadFromCall; the
				  -- rescue is only for leads with NO explicit disposition (the phone-matched
				  -- 97%). In particular a deliberate "Call Dropped" means "keep pending, retry"
				  -- — so this worker must not re-derive its status from a later raw dial and
				  -- knock it to no_answer/called, which is exactly what moved a dropped lead
				  -- off pending.
				  LEFT JOIN LATERAL (
				    SELECT outcome AS last_dispo
				      FROM call_center_dispositions d
				     WHERE d.lead_id = l.id
				     ORDER BY d.created_at DESC
				     LIMIT 1
				  ) ld ON true
				 WHERE l.status = 'pending'
				   AND (l.last_called_at IS NULL OR l.last_called_at < lc.started_at)
				   AND COALESCE(ld.last_dispo,'') NOT ILIKE '%drop%'
				 LIMIT 500`)
			if err != nil {
				WorkerBeat(ctx, db, "lead_advance", "error", err.Error(), err.Error())
				return
			}
			fresh := 0
			for _, r := range rows {
				id := toInt64(r["id"])
				if seen[id] {
					continue
				}
				seen[id] = true
				fresh++
				disp := str(r["disposition"])
				var dp *string
				if disp != "" {
					dp = &disp
				}
				status := leadStatusFromCall(str(r["outcome"]), dp)
				advanceLeadStatus(ctx, db, id, status, disp, r["started_at"])
				total++
			}
			// No fresh candidates this batch → converged (or the rest can't advance).
			// Backstop on total is a second belt on top of the seen-set.
			if fresh == 0 || total >= 40000 {
				break
			}
		}
		WorkerBeat(ctx, db, "lead_advance", "ok", fmt.Sprintf("%d lead(s) advanced from calls", total), "")
	}
	run()
	ticker := time.NewTicker(2 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		run()
	}
}

// syncLeadFromCall advances a call-centre lead after a call has been logged
// against it, and mirrors the call into call_center_dispositions so the existing
// lead-funnel analytics keep working.
//
// Fire-and-forget by design: the call is already recorded, and a lead that fails
// to advance is a smaller problem than an error thrown back at an agent who has
// just finished a conversation.
func syncLeadFromCall(ctx context.Context, db *core.DB, leadID int64,
	outcome string, disposition *string, callbackAt string, agentID *int64, durationSec *int, callID int64) {

	status := leadStatusFromCall(outcome, disposition)

	// Did this call establish an outcome at all? Everything leadStatusFromCall can
	// return does, EXCEPT 'pending' — the code for "Call Dropped", where the line
	// picked up and died within seconds so nothing was established. Recording that as
	// the lead's status would read as "never worked" and lose what we knew before.
	//
	// 'no_answer' deliberately COUNTS as an outcome: nobody picked up is a fact about
	// the last call, and the status field is what the Leads screen shows. The promise
	// itself is not lost with it — callback_at below is left standing on a no-answer,
	// and the outbound queue dials from the CONTACT row's callback_at, never from this
	// status, so the customer is still rung back.
	//
	// Derived from the mapped status rather than re-matching the label, so it cannot
	// drift out of step with the mapping above.
	outcomeKnown := status != "pending"

	// The business disposition (falling back to the raw outcome) — now stored durably
	// on the lead itself, so its history survives a later void/merge of the call.
	dispo := outcome
	if disposition != nil && strings.TrimSpace(*disposition) != "" {
		dispo = *disposition
	}
	// The reporting table speaks canonical CODES (see ccDispositionCode + migration 193),
	// while the lead keeps the human label above for display.
	dispoCode := ccDispositionCode(dispo)

	res, err := db.PGExec(ctx, `
		UPDATE call_center_leads
		   -- Forward-only: status alone stays behind the rank guard, so a no-answer
		   -- logged against a CONVERTED lead can't knock it back to 'no_answer' —
		   -- dropping it out of the converted count and blocking forwardLeadToSales,
		   -- which accepts only 'interested'. Compared inside the statement so it
		   -- cannot race another writer.
		   -- An OPEN PROMISE is not funnel progress. 'callback' ranks 3 and
		   -- 'not_ready' 2, above 'called' (1) and 'no_answer' (1), so a promised call
		   -- that was actually made lost the rank comparison and the lead stayed on
		   -- 'callback' — reading as still-owed a call that had already been made.
		   -- 25 leads were frozen that way on 2026-09-22 (migration 275), and 48 more
		   -- sat on 'callback' whose last call was a plain no-answer (migration 278).
		   --
		   -- So while a lead is merely HOLDING a promise, the status follows whatever
		   -- the last call established ($6) — including "nobody answered", which is a
		   -- fact about that call and what the Leads screen should show.
		   --
		   -- Two things this deliberately does NOT do. It does not discard the promise:
		   -- callback_at below still stands on a no-answer, and the outbound queue
		   -- dials from the CONTACT row's callback_at rather than this status, so the
		   -- customer is still rung back. And it is not a general escape from the rank
		   -- guard: 'interested' and 'converted' are earned, and still cannot be walked
		   -- backwards, which is what that guard was built to protect.
		   SET status           = CASE
		                            WHEN $5::int >= `+ccLeadStatusRankSQL+` THEN $1
		                            WHEN $6::boolean AND status IN ('callback','not_ready') THEN $1
		                            ELSE status END,
		       last_disposition = COALESCE(NULLIF($4,''), last_disposition),
		       last_called_at   = NOW(),
		       updated_at       = NOW(),
		       -- callback_at is a live operational promise, not funnel progress, so it
		       -- is NOT behind the rank guard above — a call that actually happens
		       -- must always be allowed to resolve it. Refreshed/kept while the call
		       -- IS itself a callback/"not ready yet" promise; left untouched on a
		       -- no-answer or a dropped line (nothing was discussed, so the earlier
		       -- promise still stands — a bare no-answer used to wipe it out here,
		       -- same bug ccApplyDisposition had for the outbound queue); cleared
		       -- everywhere else, because every other status means the promised call
		       -- happened and was resolved one way or another. Previously this whole
		       -- statement was skipped outright whenever the new status ranked below
		       -- the lead's current one (e.g. a promised callback answered "Not
		       -- Interested" ranks BELOW 'callback'), which silently froze
		       -- last_called_at and callback_at too — so the lead kept showing an
		       -- overdue callback for a call that had already happened and been logged.
		       callback_at      = CASE WHEN $1 IN ('callback','not_ready')
		                               THEN CASE WHEN $3 <> '' THEN $3::timestamptz ELSE callback_at END
		                               WHEN $1 IN ('pending','no_answer') THEN callback_at
		                               ELSE NULL END
		 WHERE id = $2`,
		status, leadID, callbackAt, dispo, ccLeadStatusRank[status], outcomeKnown)
	if err != nil {
		slog.Error("syncLeadFromCall: update lead", "lead", leadID, "err", err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		// The lead id itself did not match any row — status/callback tracking for
		// this call was lost. The call itself is still recorded below.
		slog.Warn("syncLeadFromCall: lead not found", "lead", leadID, "proposed_status", status)
	}

	// Keep the lead-funnel table in step — canonical code + handle time, so connect
	// rate, PTP and avg-handle report correctly (see migration 193). NULLIF keeps a
	// no-duration dial out of the average rather than dragging it to zero.
	if _, err := db.PGExec(ctx, `
		INSERT INTO call_center_dispositions (lead_id, agent_id, outcome, duration_sec, call_id)
		VALUES ($1, $2, $3, NULLIF($4,0), NULLIF($5,0))`, leadID, agentID, dispoCode, durationSec, callID); err != nil {
		slog.Error("syncLeadFromCall: insert disposition", "lead", leadID, "err", err)
	}

	// Carry the progress into the sales pipeline. Without this the call centre's
	// work stays in its own book and Sales keeps seeing 'new'.
	syncCRMContactStage(ctx, db, leadID, status, dispo, agentID)

	// A lead marked do-not-call goes on the DNC list, exactly as the old Leads
	// form did — that obligation does not depend on which screen logged the call.
	if status == "dnc" {
		if rows, _ := db.PGQuery(ctx,
			`SELECT customer_phone FROM call_center_leads WHERE id=$1`, leadID); len(rows) > 0 {
			// Canonical form on write, like every other DNC writer — storing the lead's
			// raw phone is how the list ended up holding the same number in several
			// shapes, which is why none of the suppression checks matched.
			if np := normalizePhone(str(rows[0]["customer_phone"])); len(np) == 10 {
				if _, err := db.PGExec(ctx,
					`INSERT INTO dnc_list (phone, reason, added_by)
					 VALUES ($1, 'Customer requested', $2) ON CONFLICT (phone) DO NOTHING`,
					np, agentID); err != nil {
					slog.Error("syncLeadFromCall: add to DNC", "lead", leadID, "err", err)
				}
			} else {
				slog.Warn("syncLeadFromCall: do-not-call NOT suppressed — unusable phone",
					"lead", leadID)
			}
		}
	}
}

// crmStageForCall maps what happened on a call-centre call to the sales pipeline
// stage, and the rank used to keep movement forward-only.
//
// The two lead books were unconnected: the call centre worked call_center_leads while
// Sales read crm_contacts.lead_stage, so the pipeline showed 'new' no matter what the
// agents did. Joining them first qualified anyone an agent reached, which filled the
// qualified book with refusals: of the 603 leads qualified in the week to 13 Sept 2026,
// 288 had said Not Interested and 51 Interested.
//
// So, as agreed with the business on 14 Sept 2026: only a lead who says they are
// interested is qualified (shown to people as "Interested"). A scheduled callback is not
// interest — the person could not talk — and neither is "not ready yet"; both stay
// contacted, as does anyone reached with no outcome or not reached at all. A refusal
// (not interested, not eligible, do not call, wrong number) disqualifies.
func crmStageForCall(status, disposition string) (stage string, rank int) {
	d := strings.ToLower(strings.TrimSpace(disposition))
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "converted":
		return "converted", 3
	case "interested":
		return "qualified", 2
	case "dnc", "closed", "invalid":
		return "disqualified", 3
	case "called":
		// "called" covers every connected call without a status of its own, and
		// leadStatusFromCall files "Not Interested" here, so the disposition decides.
		if strings.Contains(d, "not interested") {
			return "disqualified", 3
		}
		return "contacted", 1
	case "callback", "not_ready", "no_answer", "pending":
		return "contacted", 1
	}
	return "", 0
}

// crmCallDisqualifyPrefix marks a disqualification made by a call rather than a person,
// so a later call can undo what an earlier call did without overruling a human decision.
const crmCallDisqualifyPrefix = "Call centre: "

// crmCallMoveAllowed decides whether a call may move a lead from its current stage.
//
// Forward-only, with two exceptions. A lead a call disqualified ("not interested" in
// March) is reopened by a later call where they say they are interested — but a lead a
// person disqualified is not. And a refusal on the phone never closes a lead Sales is
// already working past Interested; Sales decides those.
func crmCallMoveAllowed(current, disqualifyReason, stage string, rank int) bool {
	if current == "disqualified" && stage == "qualified" {
		return strings.HasPrefix(disqualifyReason, crmCallDisqualifyPrefix)
	}
	if stage == "disqualified" && crmStageRank[current] == 2 && current != "qualified" {
		return false
	}
	return crmStageRank[current] < rank
}

// The stages after qualified (handed_to_sales … approved) are Sales' own progress; a
// later dial must never pull them back to 'qualified', so they rank with qualified.
// A call can still close them out (converted/disqualified, rank 3).
var crmStageRank = map[string]int{
	"new": 0, "contacted": 1, "qualified": 2,
	"handed_to_sales": 2, "documents_requested": 2, "application_submitted": 2, "approved": 2,
	"converted": 3, "disqualified": 3,
}

// syncCRMContactStage advances the linked CRM contact so call-centre work shows
// up in the sales pipeline, and records the move in crm_lead_events.
//
// Forward-only: a contact already converted is never dragged back by a later
// dial. Fire-and-forget, like the rest of syncLeadFromCall — the call is already
// recorded, and a pipeline that lags is a smaller problem than an error thrown at
// an agent who has just finished a conversation.
func syncCRMContactStage(ctx context.Context, db *core.DB, leadID int64, status, disposition string, agentID *int64) {
	stage, rank := crmStageForCall(status, disposition)
	if stage == "" {
		return
	}
	const contactSQL = `
		SELECT c.id, c.lead_stage, COALESCE(c.disqualify_reason, '') AS disqualify_reason
		  FROM call_center_leads l JOIN crm_contacts c ON c.id = l.contact_id
		 WHERE l.id = $1`
	rows, err := db.PGQuery(ctx, contactSQL, leadID)
	if err != nil {
		return
	}
	if len(rows) == 0 {
		// A lead imported after the two books were joined has no contact yet. It
		// earns one the moment it is actually worked — an untouched imported
		// number is not a sales prospect and would only inflate the CRM book.
		if !crmLinkLeadToContact(ctx, db, leadID) {
			return
		}
		if rows, err = db.PGQuery(ctx, contactSQL, leadID); err != nil || len(rows) == 0 {
			return
		}
	}
	contactID, current := toInt64(rows[0]["id"]), str(rows[0]["lead_stage"])
	if !crmCallMoveAllowed(current, str(rows[0]["disqualify_reason"]), stage, rank) {
		return
	}

	outcome := strings.TrimSpace(disposition)
	if outcome == "" {
		outcome = status
	}
	// The dates and reason follow the stage, so a lead reopened by an "interested" call
	// no longer carries the disqualification it has just left.
	if _, err := db.PGExec(ctx, `
		UPDATE crm_contacts
		   SET lead_stage        = $2,
		       stage_changed_at  = NOW(),
		       updated_at        = NOW(),
		       qualified_at      = CASE WHEN $2 = 'qualified' AND qualified_at IS NULL THEN NOW() ELSE qualified_at END,
		       disqualified_at   = CASE WHEN $2 = 'disqualified' THEN NOW() WHEN $2 = 'qualified' THEN NULL ELSE disqualified_at END,
		       disqualify_reason = CASE WHEN $2 = 'disqualified' THEN $3 WHEN $2 = 'qualified' THEN NULL ELSE disqualify_reason END
		 WHERE id = $1`,
		contactID, stage, crmCallDisqualifyPrefix+outcome); err != nil {
		slog.Error("syncCRMContactStage: update", "contact", contactID, "err", err)
		return
	}
	db.PGExec(ctx, //nolint:errcheck
		`INSERT INTO crm_lead_events (contact_id, event, from_stage, to_stage, note, created_by)
		 VALUES ($1,'stage_changed',$2,$3,$4,$5)`,
		contactID, current, stage, "Moved by a call-centre call: "+outcome, agentID)

	// The moment a call first qualifies a not-yet-qualified lead IS the hand-off to Sales.
	// Historically this path moved the lead silently and the audited forwards ledger
	// (call_center_lead_forwards) stayed empty because the interactive forwardLeadToSales
	// action was never used. Record the hand-off here so the durable trail — a forwards
	// row, forwarded_at, and a 'forwarded_to_sales' event (which the activities trigger
	// fans onto the timeline as a hand-off) — is produced on the path leads actually take.
	if stage == "qualified" && crmStageRank[current] < 2 {
		// A qualified lead has entered the sales pipeline, so it earns a durable canonical
		// party (an existing customer if one matches, else a fresh prospect party). Cold,
		// un-qualified dials never reach here, so app.parties is not inflated.
		db.PGExec(ctx, `SELECT app.ensure_lead_party($1)`, contactID) //nolint:errcheck
		recordCallHandoff(ctx, db, leadID, contactID, current, outcome, agentID)
	}
}

// recordCallHandoff writes the call-centre -> Sales hand-off record when a call first
// qualifies a lead. Idempotent (one open forward per lead) and fire-and-forget, matching
// the rest of syncLeadFromCall: a missed ledger row must never throw back at an agent who
// has just finished a call. The lead's own fields (name, phone, campaign, product
// interest) populate the forward, so Sales sees where it came from.
func recordCallHandoff(ctx context.Context, db *core.DB, leadID, contactID int64, fromStage, outcome string, agentID *int64) {
	if rows, _ := db.PGQuery(ctx,
		`SELECT 1 FROM call_center_lead_forwards WHERE lead_id=$1 AND resolved_at IS NULL LIMIT 1`, leadID); len(rows) > 0 {
		return // already handed off and not yet resolved
	}
	// Errors are logged, not discarded: this is the ledger Sales works from, and a
	// hand-off that silently failed to record is indistinguishable from one that was
	// never qualified.
	res, err := db.PGExec(ctx,
		`INSERT INTO call_center_lead_forwards
		   (lead_id, contact_id, forwarded_by, customer_name, customer_phone, customer_cif,
		    cc_campaign_id, marketing_campaign_id, product_interest, status, notes)
		 SELECT l.id, l.contact_id, $2, l.customer_name, l.customer_phone, NULLIF(l.customer_cif,''),
		        l.campaign_id, l.marketing_campaign_id, c.product_interest, 'forwarded',
		        'Auto: qualified by a call-centre call'
		   FROM call_center_leads l LEFT JOIN crm_contacts c ON c.id = l.contact_id
		  WHERE l.id = $1`, leadID, agentID)
	if err != nil {
		slog.Error("recordCallHandoff: forward not recorded", "lead", leadID, "err", err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return // nothing inserted — no hand-off to announce
	}
	if _, err := db.PGExec(ctx,
		`UPDATE call_center_leads SET forwarded_at = COALESCE(forwarded_at, NOW()) WHERE id=$1`, leadID); err != nil {
		slog.Error("recordCallHandoff: stamp forwarded_at", "lead", leadID, "err", err)
	}
	if _, err := db.PGExec(ctx,
		`INSERT INTO crm_lead_events (contact_id, event, from_stage, to_stage, note, created_by)
		 VALUES ($1,'forwarded_to_sales',$2,'qualified',$3,$4)`,
		contactID, fromStage, "Auto hand-off: qualified by a call-centre call ("+outcome+")", agentID); err != nil {
		slog.Error("recordCallHandoff: timeline event", "contact", contactID, "err", err)
	}

	// Tell Sales. ccDistribute announces every hand-out, but this path — the one
	// leads actually take — notified nobody, so a qualified lead could sit unclaimed
	// indefinitely with nothing escalating. Grouped, so a busy afternoon collapses
	// into one digest rather than a ping per lead, and fire-and-forget like the rest
	// of this function.
	go NotifyRoles(context.WithoutCancel(ctx), db, []string{"sales_head"}, NotifPayload{
		EventType: "cc_lead_forwarded",
		Title:     "Lead forwarded from the call centre",
		Body:      "A call-centre call qualified a lead. Open the hand-off tracker to assign it.",
		ActionURL: "/call-center/forwards",
		EntityRef: fmt.Sprintf("cc_forward:lead:%d", leadID),
		GroupKey:  "cc:forwarded",
		Priority:  "high",
	})
}

// crmLinkLeadToContact gives a worked lead its place in the CRM book: an existing
// contact if the number identifies one unambiguously, otherwise a new one.
//
// The ambiguity guard matters. Every one of the seven numbers that overlapped
// between the two books at join time matched TWO contacts, because a phone can
// belong to a household. Linking on a guess would attach one person's lead
// progress to another's record, so a shared number gets a fresh contact instead.
func crmLinkLeadToContact(ctx context.Context, db *core.DB, leadID int64) bool {
	rows, err := db.PGQuery(ctx, `
		SELECT id, customer_name, customer_phone, email, assigned_to, marketing_campaign_id
		  FROM call_center_leads WHERE id = $1 AND COALESCE(customer_phone,'') <> ''`, leadID)
	if err != nil || len(rows) == 0 {
		return false
	}
	phone := str(rows[0]["customer_phone"])
	mktCampaign := rows[0]["marketing_campaign_id"] // may be nil (non-campaign lead)

	// Exactly one contact on this number → link to it, and carry the campaign lineage
	// onto the CRM contact if it has none yet. Attribution used to be stamped only when
	// a supervisor forwarded the lead, so a campaign lead that was worked and advanced
	// (but never formally forwarded) reached Sales with no idea which campaign produced
	// it. COALESCE never overwrites an attribution already recorded by a forward.
	if m, err := db.PGQuery(ctx, `
		SELECT id FROM crm_contacts
		 WHERE `+normalizedPhoneExpr("phone")+` = `+normalizedPhoneExpr("$1")+`
		 LIMIT 2`, phone); err == nil && len(m) == 1 {
		if _, err := db.PGExec(ctx,
			`UPDATE call_center_leads SET contact_id = $2 WHERE id = $1`,
			leadID, toInt64(m[0]["id"])); err == nil {
			db.PGExec(ctx, //nolint:errcheck
				`UPDATE crm_contacts
				    SET source_campaign_id = COALESCE(source_campaign_id, $2),
				        source_cc_lead_id  = COALESCE(source_cc_lead_id, $3),
				        updated_at         = NOW()
				  WHERE id = $1`, toInt64(m[0]["id"]), mktCampaign, leadID)
			return true
		}
		return false
	}

	name := strings.TrimSpace(str(rows[0]["customer_name"]))
	first, last := name, ""
	if i := strings.Index(name, " "); i > 0 {
		first, last = name[:i], strings.TrimSpace(name[i+1:])
	}
	if first == "" {
		first = "Lead"
	}
	created, err := db.PGQuery(ctx, `
		INSERT INTO crm_contacts (first_name, last_name, phone, email, source, lead_source,
		                          source_type, lead_stage, lead_owner_id, status,
		                          source_campaign_id, source_cc_lead_id)
		VALUES ($1,$2,$3,NULLIF(TRIM($4),''),'call_centre','call_centre','self_sourced','new',$5,'lead',$6,$7)
		RETURNING id`, first, last, phone, str(rows[0]["email"]), rows[0]["assigned_to"], mktCampaign, leadID)
	if err != nil || len(created) == 0 {
		slog.Error("crmLinkLeadToContact: create contact", "lead", leadID, "err", err)
		return false
	}
	_, err = db.PGExec(ctx, `UPDATE call_center_leads SET contact_id = $2 WHERE id = $1`,
		leadID, toInt64(created[0]["id"]))
	return err == nil
}

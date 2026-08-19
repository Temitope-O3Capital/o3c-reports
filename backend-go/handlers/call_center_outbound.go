package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// StartCallbackReminderWorker alerts an agent when a call-back they scheduled comes
// due. Every minute it finds pending callbacks whose time has arrived and that haven't
// been alerted yet, pushes an in-app + email notification to the assigned agent, and
// stamps callback_notified_at so the alarm fires exactly once per callback.
func StartCallbackReminderWorker(db *core.DB) {
	run := func() {
		ctx := context.Background()
		WorkerBeat(ctx, db, "callback_reminders", "running", "", "")
		rows, err := db.PGQuery(ctx, `
			SELECT id, assigned_to, COALESCE(NULLIF(customer_name,''), phone) AS who, phone
			FROM call_center_contacts
			WHERE status='pending' AND assigned_to IS NOT NULL
			  AND callback_at IS NOT NULL AND callback_at <= NOW()
			  AND callback_notified_at IS NULL
			ORDER BY callback_at
			LIMIT 200`)
		if err != nil {
			WorkerBeat(ctx, db, "callback_reminders", "error", err.Error(), err.Error())
			return
		}
		n := 0
		for _, r := range rows {
			uid := toInt64(r["assigned_to"])
			if uid == 0 {
				continue
			}
			who, phone := str(r["who"]), str(r["phone"])
			Notify(ctx, db, NotifPayload{
				EventType: EvtCallbackDue,
				UserID:    uid,
				Title:     "Call-back due now",
				Body:      "Time to call " + who + " · " + phone,
				ActionURL: "/call-center/queue?bucket=ready",
				EntityRef: "callback:" + str(r["id"]),
				Priority:  "high", // stands out in the bell — it's an alarm
			})
			db.PGExec(ctx, `UPDATE call_center_contacts SET callback_notified_at=NOW() WHERE id=$1`, toInt64(r["id"])) //nolint:errcheck
			n++
		}
		WorkerBeat(ctx, db, "callback_reminders", "ok", fmt.Sprintf("%d callback(s) alerted", n), "")
	}
	run()
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		run()
	}
}

// ensureCCContactColumns adds provenance columns so the queue can distinguish
// where each contact came from (zoho_crm | collections | manual | support) and
// link back to a source record (e.g. a support ticket ref). Idempotent.
func ensureCCContactColumns(db *core.DB) {
	ctx := context.Background()
	for _, s := range []string{
		`ALTER TABLE call_center_contacts ADD COLUMN IF NOT EXISTS source TEXT`,
		`ALTER TABLE call_center_contacts ADD COLUMN IF NOT EXISTS ref TEXT`,
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
	db.PGExec(ctx, //nolint:errcheck
		`UPDATE call_center_contacts c
		    SET attempts          = t.n,
		        connects          = t.conn,
		        last_called_at    = t.last_at,
		        last_call_outcome = t.last_outcome,
		        updated_at        = NOW()
		   FROM (
		     SELECT COUNT(*)                                            AS n,
		            COUNT(*) FILTER (WHERE outcome = 'completed')        AS conn,
		            MAX(started_at)                                      AS last_at,
		            (ARRAY_AGG(NULLIF(outcome,'') ORDER BY started_at DESC))[1] AS last_outcome
		       FROM helpdesk_calls
		      WHERE norm_phone(customer_phone) = norm_phone($1)
		   ) t
		  WHERE norm_phone(c.phone) = norm_phone($1)
		    AND norm_phone($1) <> ''`, phone)
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
	r.Patch("/leads/{id}", ccUpdateLead(db))
	r.Get("/leads/{id}/calls", ccLeadCalls(db)) // this lead's call history (so a logged call is visible here)
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
	r.Get("/contacts/{id}/calls", ccContactCalls(db))
	r.Post("/contacts/{id}/log-call", ccLogCall(db))
	r.Get("/dispositions", ccListDispositions()) // canonical outcome vocabulary

	// Agent presence heartbeat — the workspace pings while open (auto-online) and
	// beacons on close (auto-offline); powers "distribute to online agents".
	r.Post("/presence/ping", ccPresencePing(db))
	r.Post("/presence/offline", ccPresenceOffline(db))

	// Inbound — 53% of inbound calls go unanswered and had no follow-up path at all.
	r.Get("/inbound", ccInboundList(db))
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
			respondErr(w, 500, "Query failed")
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

		// Build the shared WHERE once so the COUNT and the page use identical filters —
		// this is what makes a campaign of any size paginate correctly rather than
		// silently truncating at the page limit.
		cond := ""
		var args []any
		n := 1

		// An agent sees only her own assigned leads; heads (call_center_stats) and the
		// exec see-all roles see everyone's and can distribute/assign.
		if user := core.UserFromCtx(r.Context()); user != nil && !user.HasPage("call_center_stats") && !user.CanSeeAllRows() {
			cond += fmt.Sprintf(" AND l.assigned_to=$%d", n)
			args = append(args, user.ID)
			n++
		}
		if campaignID != "" {
			cond += fmt.Sprintf(" AND l.campaign_id=$%d", n)
			args = append(args, campaignID)
			n++
		}
		if status != "" {
			cond += fmt.Sprintf(" AND l.status=$%d", n)
			args = append(args, status)
			n++
		}
		if agentID != "" {
			cond += fmt.Sprintf(" AND l.assigned_to=$%d", n)
			args = append(args, agentID)
			n++
		}
		if search != "" {
			if clause, sargs, nn := buildCustomerSearch(search,
				[]string{"l.customer_name", "l.customer_phone", "l.employer"}, "l.customer_phone", n); clause != "" {
				cond += " AND " + clause
				args = append(args, sargs...)
				n = nn
			}
		}
		if from := qstr(r, "from"); from != "" {
			cond += fmt.Sprintf(" AND l.created_at::date >= $%d::date", n)
			args = append(args, from)
			n++
		}
		if to := qstr(r, "to"); to != "" {
			cond += fmt.Sprintf(" AND l.created_at::date <= $%d::date", n)
			args = append(args, to)
			n++
		}

		var total int64
		if err := db.PG.QueryRowContext(r.Context(),
			`SELECT COUNT(*) FROM call_center_leads l WHERE 1=1`+cond, args...).Scan(&total); err != nil {
			respondErr(w, 500, "Count failed")
			return
		}

		q := `SELECT l.id, l.campaign_id, l.customer_cif, l.customer_name,
		             l.customer_phone, l.employer, l.email, l.address, l.lead_score, l.status,
		             l.assigned_to, l.last_called_at, l.callback_at, l.notes,
		             l.created_at, l.updated_at,
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
		           WHERE h.lead_id = l.id AND h.merged_into_call_id IS NULL
		           ORDER BY h.started_at DESC NULLS LAST LIMIT 1
		      ) lc ON TRUE
		      WHERE 1=1` + cond +
			fmt.Sprintf(" ORDER BY l.updated_at DESC LIMIT $%d OFFSET $%d", n, n+1)
		rows, err := db.PGQuery(r.Context(), q, append(append([]any{}, args...), limit, offset)...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"data": rows, "total": total, "limit": limit, "offset": offset,
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
		rows, err := db.PGQuery(r.Context(), `
			WITH lp AS (
			  SELECT NULLIF(right(regexp_replace(COALESCE(customer_phone,''),'\D','','g'),10),'') AS ph
			    FROM call_center_leads WHERE id = $1
			)
			SELECT h.id, h.started_at, h.direction, h.outcome, h.duration_sec,
			       COALESCE(h.agent_name,'')   AS agent_name,
			       COALESCE(h.notes,'')        AS notes,
			       COALESCE(h.disposition,'')  AS disposition,
			       h.recording_filename
			  FROM helpdesk_calls h, lp
			 WHERE (h.lead_id = $1
			        OR (lp.ph IS NOT NULL
			            AND right(regexp_replace(COALESCE(h.customer_phone,''),'\D','','g'),10) = lp.ph))
			   AND COALESCE(h.merged_into_call_id, 0) = 0
			 ORDER BY h.started_at DESC NULLS LAST
			 LIMIT 50`, id)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		jsonRows(w, rows)
	}
}

func ccCreateLead(db *core.DB) http.HandlerFunc {
	type body struct {
		CampaignID    *int64  `json:"campaign_id"`
		CustomerCIF   *string `json:"customer_cif"`
		CustomerName  string  `json:"customer_name"`
		CustomerPhone *string `json:"customer_phone"`
		Employer      *string `json:"employer"`
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
			 (campaign_id, customer_cif, customer_name, customer_phone, employer, lead_score, assigned_to)
			 VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
			b.CampaignID, b.CustomerCIF, b.CustomerName, b.CustomerPhone,
			b.Employer, b.LeadScore, b.AssignedTo)
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
		CustomerCIF  *string `json:"customer_cif"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
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
		if b.CustomerCIF != nil {
			q += fmt.Sprintf(", customer_cif=NULLIF($%d,'')", n)
			args = append(args, strings.TrimSpace(*b.CustomerCIF))
			n++
		}
		if b.Status != nil {
			q += fmt.Sprintf(", status=$%d", n)
			args = append(args, *b.Status)
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
			q += fmt.Sprintf(", assigned_to=$%d", n)
			args = append(args, *b.AssignedTo)
			n++
		}
		args = append(args, id)
		q += fmt.Sprintf(" WHERE id=$%d RETURNING *", n)

		rows, err := db.PGQuery(r.Context(), q, args...)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Lead not found")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func ccStats(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

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
			       COUNT(d.id) FILTER (WHERE d.outcome='converted')   AS conversions,
			       COUNT(d.id) FILTER (WHERE d.created_at::date = CURRENT_DATE) AS calls_today
			FROM o3c_users u
			JOIN call_center_dispositions d ON d.agent_id = u.id
			WHERE u.deleted_at IS NULL
			GROUP BY u.id, u.full_name
			ORDER BY calls_made DESC
			LIMIT 20`)

		outcomes, _ := db.PGQuery(ctx, `
			SELECT outcome, COUNT(*) AS count
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
			respondErr(w, 500, "Query failed")
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
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil || b.Phone == "" {
			respondErr(w, 400, "phone is required")
			return
		}
		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(),
			`INSERT INTO dnc_list (phone, reason, added_by)
			 VALUES ($1,$2,$3)
			 ON CONFLICT (phone) DO UPDATE SET reason=$2, added_by=$3, added_at=NOW()
			 RETURNING *`,
			b.Phone, b.Reason, user.ID)
		if err != nil {
			respondErr(w, 500, "Insert failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func ccRemoveDNC(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		_, err := db.PGExec(r.Context(), `DELETE FROM dnc_list WHERE id=$1`, id)
		if err != nil {
			respondErr(w, 500, "Delete failed")
			return
		}
		w.WriteHeader(204)
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
			respondErr(w, 500, "Query failed")
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
		if u := core.UserFromCtx(r.Context()); u != nil && !u.HasPage("call_center_stats") && !u.CanSeeAllRows() {
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
			) RETURNING id`, where, n), args...)
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
		if user == nil || (user.Role != "call_center_head" && !core.IsManagement(user.Role)) {
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
	mgmtRoles := map[string]bool{
		"md": true, "coo": true, "cfo": true, "cmo": true,
		"admin": true, "management": true, "head_ops": true, "head_it": true,
	}
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user.Role != "call_center_head" && !mgmtRoles[user.Role] {
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

		// Build IN clause dynamically — avoids driver array-type uncertainty
		clause := "$2"
		args := []any{b.AgentID, b.LeadIDs[0]}
		for i, id := range b.LeadIDs[1:] {
			clause += fmt.Sprintf(",$%d", i+3)
			args = append(args, id)
		}
		_, err := db.PGExec(r.Context(),
			fmt.Sprintf(`UPDATE call_center_leads SET assigned_to=$1, updated_at=NOW() WHERE id IN (%s)`, clause),
			args...)
		if err != nil {
			respondErr(w, 500, "Assign failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"assigned": len(b.LeadIDs)}) //nolint:errcheck
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
	mgmtRoles := map[string]bool{
		"md": true, "coo": true, "cfo": true, "cmo": true,
		"admin": true, "management": true, "head_ops": true, "head_it": true,
	}
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil || (user.Role != "call_center_head" && !mgmtRoles[user.Role]) {
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
		where := "assigned_to IS NULL AND status='pending'"
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
			 ) RETURNING id`, where, n), args...)
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
	}
	mgmtRoles := map[string]bool{
		"md": true, "coo": true, "cfo": true, "cmo": true,
		"admin": true, "management": true, "head_ops": true, "head_it": true,
	}
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user.Role != "call_center_head" && !mgmtRoles[user.Role] {
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
		if len(agentIDs) == 0 {
			respondErr(w, 400, "No call center agents found")
			return
		}

		// Fetch unassigned pending leads
		q := `SELECT id FROM call_center_leads WHERE assigned_to IS NULL AND status='pending'`
		var args []any
		if b.CampaignID != nil {
			q += " AND campaign_id=$1"
			args = append(args, *b.CampaignID)
		}
		q += " ORDER BY lead_score DESC, created_at ASC"
		leadRows, err := db.PGQuery(ctx, q, args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
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
		for agentID, ids := range groups {
			clause := "$2"
			upArgs := []any{agentID, ids[0]}
			for i, id := range ids[1:] {
				clause += fmt.Sprintf(",$%d", i+3)
				upArgs = append(upArgs, id)
			}
			if _, err := tx.ExecContext(ctx,
				fmt.Sprintf(`UPDATE call_center_leads SET assigned_to=$1, updated_at=NOW() WHERE id IN (%s)`, clause),
				upArgs...); err != nil {
				respondErr(w, 500, "Distribute failed")
				return
			}
		}
		if err := tx.Commit(); err != nil {
			respondErr(w, 500, "Distribute failed")
			return
		}

		// Fetch agent names for the response breakdown
		nameClause := "$1"
		nameArgs := []any{agentIDs[0]}
		for i, id := range agentIDs[1:] {
			nameClause += fmt.Sprintf(",$%d", i+2)
			nameArgs = append(nameArgs, id)
		}
		nameRows, _ := db.PGQuery(ctx,
			fmt.Sprintf(`SELECT id, full_name FROM o3c_users WHERE id IN (%s)`, nameClause),
			nameArgs...)
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
		for agentID, ids := range groups {
			breakdown = append(breakdown, map[string]any{
				"agent_id":   agentID,
				"agent_name": nameMap[agentID],
				"count":      len(ids),
			})
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"distributed": len(leadRows),
			"breakdown":   breakdown,
			"online_only": onlineOnly,
		})
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
			  AND norm_phone NOT IN (SELECT phone FROM dnc_list WHERE phone IS NOT NULL)
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

// ccSyncCollections feeds overdue accounts into the queue as collections calls,
// carrying real DPD, outstanding balance and product so the panel shows genuine
// collections context (not the empty ₦0/DPD 0 that marketing leads produce).
// current_dr_balance is naira → stored ×100 as kobo. Deduped per-purpose so a
// customer already queued for marketing can still appear under collections.
func ccSyncCollections(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		res, err := db.PGExec(r.Context(), `
			INSERT INTO call_center_contacts
			  (customer_name, phone, cif, product_name, priority,
			   outstanding_kobo, dpd, is_existing_customer, loan_product, next_payment_date,
			   status, purpose, source)
			SELECT DISTINCT ON (norm_phone)
			  COALESCE(clean_name,''), phone, cif, product_line,
			  CASE WHEN days_overdue > 90 THEN 'High' WHEN days_overdue > 30 THEN 'Medium' ELSE 'Low' END,
			  ROUND(COALESCE(current_dr_balance,0) * 100)::bigint,
			  days_overdue, true, product_line, payment_due_date,
			  'pending', 'collections', 'collections'
			FROM (
			  SELECT NULLIF(TRIM(c.full_name),'')                                  AS clean_name,
			         c.phone                                                       AS phone,
			         right(regexp_replace(COALESCE(c.phone,''),'\D','','g'),10)     AS norm_phone,
			         a.cif                                                          AS cif,
			         a.product_line                                                 AS product_line,
			         a.days_overdue                                                 AS days_overdue,
			         a.current_dr_balance                                           AS current_dr_balance,
			         a.payment_due_date                                             AS payment_due_date
			  FROM app.accounts a
			  JOIN app.customers c ON c.cif = a.cif
			  -- Only genuine collections targets: overdue AND still owing a positive
			  -- balance (excludes stale/settled rows that keep an old days_overdue).
			  WHERE a.days_overdue > 0 AND COALESCE(a.current_dr_balance,0) > 0
			    AND COALESCE(c.phone,'') <> ''
			) x
			WHERE length(norm_phone) = 10
			  AND norm_phone NOT IN (SELECT phone FROM dnc_list WHERE phone IS NOT NULL)
			  AND NOT EXISTS (
			    SELECT 1 FROM call_center_contacts t
			    WHERE right(regexp_replace(COALESCE(t.phone,''),'\D','','g'),10) = x.norm_phone
			      AND COALESCE(t.purpose,'marketing') = 'collections'
			  )
			ORDER BY norm_phone, days_overdue DESC`)
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
				   (customer_name, phone, cif, product_name, priority, is_existing_customer, status, purpose, source)
				 SELECT $1,$2,NULLIF($3,''),$4,'Medium',(NULLIF($3,'') IS NOT NULL),'pending',$5,'manual'
				 WHERE length(right(regexp_replace($2,'\D','','g'),10))=10
				   AND right(regexp_replace($2,'\D','','g'),10) NOT IN (SELECT phone FROM dnc_list WHERE phone IS NOT NULL)
				   AND NOT EXISTS (
				     SELECT 1 FROM call_center_contacts t
				     WHERE right(regexp_replace(COALESCE(t.phone,''),'\D','','g'),10) = right(regexp_replace($2,'\D','','g'),10)
				       AND COALESCE(t.purpose,'marketing') = $5
				   )`,
				strings.TrimSpace(c.Name), c.Phone, strings.TrimSpace(c.CIF), product, purpose)
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
				   (campaign_id, customer_name, customer_phone, email, address, lead_score, status)
				 SELECT $1, $2, $3, NULLIF($4,''), NULLIF($5,''), 0, 'pending'
				 WHERE NOT EXISTS (
				      SELECT 1 FROM call_center_leads t
				      WHERE right(regexp_replace(COALESCE(t.customer_phone,''),'\D','','g'),10)
				          = right(regexp_replace($3,'\D','','g'),10)
				    )`,
				b.CampaignID, name, phone, strings.TrimSpace(l.Email), strings.TrimSpace(l.Address))
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
		rows, err := db.PGQuery(r.Context(),
			`INSERT INTO call_center_contacts
			   (customer_name, phone, cif, product_name, priority, is_existing_customer, status, purpose, source, ref, callback_at, notes, assigned_to)
			 VALUES ($1,$2,NULLIF($3,''),'Support Call-back','High',(NULLIF($3,'') IS NOT NULL),'pending','support','support',NULLIF($4,''),NULLIF($5,'')::timestamptz,NULLIF($6,''),$7)
			 RETURNING id`,
			name, phone, cif, ref, strings.TrimSpace(b.CallbackAt), strings.TrimSpace(b.Notes), assignedTo)
		if err != nil {
			respondErr(w, 500, "Could not add call-back: "+err.Error())
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

func ccListQueue(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		priority := qstr(r, "priority")
		disposition := qstr(r, "disposition")
		dpdRange := qstr(r, "dpd")
		search := qstr(r, "search")
		purpose := qstr(r, "purpose")
		bucket := qstr(r, "bucket")
		limit := qint(r, "limit", 200, 1, 500)
		cooldown := qint(r, "cooldown_days", ccCooldownDays, 0, 90)

		// Derived flags travel with each row so the UI can badge a contact without
		// re-deriving the thresholds and drifting from the ordering below.
		sel := fmt.Sprintf(`SELECT id, customer_name, phone, cif, product_name,
		             priority, outstanding_kobo, dpd, is_existing_customer,
		             loan_product, next_payment_date, last_disposition, last_called_at,
		             attempts, connects, last_call_outcome, disposition_code, callback_at,
		             COALESCE(last_called_at > NOW() - INTERVAL '%d days', FALSE) AS is_cooling,
		             (attempts >= %d AND connects = 0)                             AS is_exhausted,
		             (callback_at IS NOT NULL AND callback_at <= NOW())            AS callback_due,
		             COALESCE(purpose,'marketing') AS purpose, COALESCE(source,'zoho_crm') AS source, ref
		      FROM call_center_contacts
		      WHERE status = 'pending'
		        AND phone NOT IN (SELECT phone FROM dnc_list)`, cooldown, ccExhaustedAttempts)
		q := sel
		var args []any
		n := 1
		cond := ""

		// Row scope: an agent's queue shows ONLY the contacts assigned to her; heads
		// (call_center_stats) see the whole queue and may focus one agent via ?agent_id=.
		if user := core.UserFromCtx(r.Context()); user != nil && !user.HasPage("call_center_stats") && !user.CanSeeAllRows() {
			cond += fmt.Sprintf(" AND assigned_to=$%d", n)
			args = append(args, user.ID)
			n++
		} else if av := qstr(r, "agent_id"); av != "" {
			cond += fmt.Sprintf(" AND assigned_to=$%d", n)
			args = append(args, av)
			n++
		}

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
			// A due callback is always ready — the customer set the time, so neither the
			// cooldown nor an exhausted-number rule should hold it back.
			bucketCond = fmt.Sprintf(" AND ((callback_at IS NOT NULL AND callback_at <= NOW())"+
				" OR ((last_called_at IS NULL OR last_called_at <= NOW() - INTERVAL '%d days')"+
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
			                            OR ((last_called_at IS NULL
			                              OR last_called_at <= NOW() - INTERVAL '%d days')
			                            AND NOT (attempts >= %d AND connects = 0)))      AS ready,
			        COUNT(*) FILTER (WHERE callback_at IS NOT NULL AND callback_at <= NOW()) AS callbacks_due,
			        COUNT(*) FILTER (WHERE callback_at IS NOT NULL)       AS callbacks
			 FROM call_center_contacts
			 WHERE status = 'pending' AND phone NOT IN (SELECT phone FROM dnc_list)`,
				cooldown, ccExhaustedAttempts, cooldown, ccExhaustedAttempts)+cond, args...); len(sr) > 0 {
			summary = sr[0]
		}
		// Per-purpose backlog is computed WITHOUT the purpose filter so the
		// segmentation tabs always show each segment's count, even when one is active.
		if pr, _ := db.PGQuery(r.Context(),
			`SELECT COALESCE(purpose,'marketing') AS purpose, COUNT(*) AS n
			 FROM call_center_contacts
			 WHERE status='pending' AND phone NOT IN (SELECT phone FROM dnc_list)
			 GROUP BY 1`); len(pr) > 0 {
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
		q += fmt.Sprintf(` ORDER BY (callback_at IS NULL OR callback_at > NOW()),
		         (attempts >= %d AND connects = 0),
		         COALESCE(last_called_at > NOW() - INTERVAL '%d days', FALSE),
		         last_called_at ASC NULLS FIRST,
		         CASE priority WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END,
		         dpd DESC, id LIMIT $%d`, ccExhaustedAttempts, cooldown, n)
		args = append(args, limit)

		rows, err := db.PGQuery(r.Context(), q, args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
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
		rows, err := db.PGQuery(r.Context(),
			`WITH c AS (
			   SELECT right(regexp_replace(COALESCE(phone,''),'\D','','g'),10) AS np
			   FROM call_center_contacts WHERE id=$1
			 )
			 SELECT hc.id,
			        hc.started_at                                        AS called_at,
			        COALESCE(hc.duration_sec,0)                          AS duration_seconds,
			        COALESCE(NULLIF(hc.outcome,''),'Call')               AS disposition,
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
			respondErr(w, 500, "Query failed")
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

		// Pull the contact so the call lands in the ledger with customer context.
		var name, phone, cif, purpose string
		if rows, _ := db.PGQuery(ctx,
			`SELECT COALESCE(customer_name,'') n, COALESCE(phone,'') p, COALESCE(cif,'') c,
			        COALESCE(NULLIF(purpose,''),'marketing') pu
			 FROM call_center_contacts WHERE id=$1`, id); len(rows) > 0 {
			name, phone, cif, purpose = str(rows[0]["n"]), str(rows[0]["p"]), str(rows[0]["c"]), str(rows[0]["pu"])
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
		outcome := "missed"
		if disp.Connected {
			outcome = "completed"
		}
		notes := strings.TrimSpace(disp.Label + " — " + b.Notes)
		if _, err := db.PGExec(ctx,
			`INSERT INTO helpdesk_calls
			   (agent_id, agent_name, customer_name, customer_cif, customer_phone,
			    direction, duration_sec, outcome, notes, purpose, source_system)
			 VALUES ($1,$2,$3,$4,$5,'outbound',0,$6,$7,$8,'call_center')`,
			agentID, agentName, name, cif, phone, outcome, notes, purpose); err != nil {
			respondErr(w, 500, "Insert failed")
			return
		}

		// A promise-to-pay belongs in the Collections promise book, not a call log —
		// route it there (keyed by CIF) so it actually reaches Collections.
		if b.PTPAmountKobo != nil && *b.PTPAmountKobo > 0 && b.PTPDate != nil && *b.PTPDate != "" && cif != "" {
			db.PGExec(ctx, //nolint:errcheck
				`INSERT INTO collection_promises (cif_number, agent_user_id, promised_amount_kobo, promised_date, created_at)
				 VALUES ($1,$2,$3,$4,NOW())`,
				cif, agentID, *b.PTPAmountKobo, *b.PTPDate)
		}

		// Apply the disposition's consequences — close it out, mark it invalid, schedule
		// the callback, suppress the number. This is what makes logging worth an agent's
		// time; before, every disposition left the contact exactly where it was.
		var userID *int64
		if user != nil {
			userID = &user.ID
		}
		ccApplyDisposition(ctx, db, id, disp, phone, b.CallbackAt, userID)

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
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil || len(b.IDs) == 0 {
			respondErr(w, 400, "ids are required")
			return
		}

		clause := "$1"
		args := []any{b.IDs[0]}
		for i, id := range b.IDs[1:] {
			clause += fmt.Sprintf(",$%d", i+2)
			args = append(args, id)
		}
		if _, err := db.PGExec(r.Context(),
			fmt.Sprintf(`UPDATE call_center_contacts SET status='skipped', updated_at=NOW() WHERE id IN (%s)`, clause),
			args...); err != nil {
			respondErr(w, 500, "Skip failed")
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"skipped": len(b.IDs)}) //nolint:errcheck
	}
}

// ── DNC extras ────────────────────────────────────────────────────────────────

func ccDNCKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT
			  COUNT(*)                                                                AS total_dnc,
			  COUNT(*) FILTER (WHERE added_at >= date_trunc('month', NOW()))         AS added_this_month,
			  0                                                                       AS bulk_removes
			FROM dnc_list`)
		if err != nil || len(rows) == 0 {
			respondErr(w, 500, "Query failed")
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
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil || len(b.Phones) == 0 {
			respondErr(w, 400, "phones are required")
			return
		}

		clause := "$1"
		args := []any{b.Phones[0]}
		for i, phone := range b.Phones[1:] {
			clause += fmt.Sprintf(",$%d", i+2)
			args = append(args, phone)
		}
		res, err := db.PGExec(r.Context(),
			fmt.Sprintf(`DELETE FROM dnc_list WHERE phone IN (%s)`, clause),
			args...)
		if err != nil {
			respondErr(w, 500, "Delete failed")
			return
		}
		removed, _ := res.RowsAffected()

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"removed": removed}) //nolint:errcheck
	}
}

func ccPerformanceKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dateFrom, _ := validDate(r, "date_from")
		dateTo, _ := validDate(r, "date_to")
		agent := qstr(r, "agent")

		from := "call_center_dispositions d"
		where := "1=1"
		var args []any
		n := 1

		if agent != "" {
			from += " LEFT JOIN o3c_users u ON u.id = d.agent_id"
			where += fmt.Sprintf(" AND u.full_name ILIKE $%d", n)
			args = append(args, "%"+agent+"%")
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
			  COUNT(*) FILTER (WHERE d.outcome NOT IN ('no_answer', 'voicemail'))  AS connected,
			  COUNT(*) FILTER (WHERE d.outcome = 'ptp')                            AS ptp_count,
			  CASE WHEN COUNT(*) > 0 THEN
			    ROUND(100.0 * COUNT(*) FILTER (WHERE d.outcome = 'converted') / COUNT(*), 1)
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
			SELECT outcome AS disposition, COUNT(*) AS count
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
			  COUNT(d.id) FILTER (WHERE d.outcome NOT IN ('no_answer', 'voicemail'))  AS connected,
			  COUNT(d.id) FILTER (WHERE d.outcome = 'ptp')                            AS ptp_count,
			  CASE WHEN COUNT(d.id) > 0 THEN
			    ROUND(100.0 * COUNT(d.id) FILTER (WHERE d.outcome = 'converted') / COUNT(d.id), 1)
			  ELSE 0 END                                                               AS conversion_pct,
			  COALESCE(AVG(d.duration_sec), 0)                                        AS avg_handle_seconds
			FROM o3c_users u
			JOIN call_center_dispositions d ON d.agent_id = u.id
			WHERE u.deleted_at IS NULL AND %s
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
	case strings.Contains(d, "not ready"):
		// A timing objection, not a refusal — stays workable.
		return "callback"
	case strings.Contains(d, "not interested"):
		return "called"
	case strings.Contains(d, "interested"):
		return "called"
	case strings.Contains(d, "wrong number"):
		return "invalid"
	case strings.Contains(d, "unreachable"), strings.Contains(d, "no answer"):
		return "no_answer"
	}
	switch strings.ToLower(strings.TrimSpace(outcome)) {
	case "missed", "no_answer", "voicemail":
		return "no_answer"
	case "":
		return "called"
	}
	return "called"
}

// syncLeadFromCall advances a call-centre lead after a call has been logged
// against it, and mirrors the call into call_center_dispositions so the existing
// lead-funnel analytics keep working.
//
// Fire-and-forget by design: the call is already recorded, and a lead that fails
// to advance is a smaller problem than an error thrown back at an agent who has
// just finished a conversation.
func syncLeadFromCall(ctx context.Context, db *core.DB, leadID int64,
	outcome string, disposition *string, callbackAt string, agentID *int64) {

	status := leadStatusFromCall(outcome, disposition)

	if _, err := db.PGExec(ctx, `
		UPDATE call_center_leads
		   SET status         = $1,
		       last_called_at = NOW(),
		       updated_at     = NOW(),
		       callback_at    = CASE WHEN $3 <> '' THEN $3::timestamptz ELSE callback_at END
		 WHERE id = $2`, status, leadID, callbackAt); err != nil {
		slog.Error("syncLeadFromCall: update lead", "lead", leadID, "err", err)
		return
	}

	// Keep the lead-funnel table in step. The disposition is the business result,
	// falling back to the raw outcome when the agent did not pick one.
	dispo := outcome
	if disposition != nil && strings.TrimSpace(*disposition) != "" {
		dispo = *disposition
	}
	if _, err := db.PGExec(ctx, `
		INSERT INTO call_center_dispositions (lead_id, agent_id, outcome)
		VALUES ($1, $2, $3)`, leadID, agentID, dispo); err != nil {
		slog.Error("syncLeadFromCall: insert disposition", "lead", leadID, "err", err)
	}

	// A lead marked do-not-call goes on the DNC list, exactly as the old Leads
	// form did — that obligation does not depend on which screen logged the call.
	if status == "dnc" {
		if rows, _ := db.PGQuery(ctx,
			`SELECT customer_phone FROM call_center_leads WHERE id=$1`, leadID); len(rows) > 0 {
			if phone := str(rows[0]["customer_phone"]); phone != "" {
				db.PGExec(ctx, //nolint:errcheck
					`INSERT INTO dnc_list (phone, reason, added_by)
					 VALUES ($1, 'Customer requested', $2) ON CONFLICT (phone) DO NOTHING`,
					phone, agentID)
			}
		}
	}
}

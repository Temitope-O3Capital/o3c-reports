// Package handlers — Helpdesk module
//
// NOTE for main.go:
//   Public (no auth): /api/helpdesk/inbound/email, /api/helpdesk/inbound/sms, /api/helpdesk/csat/*
//   Protected (auth): remaining /api/helpdesk/* routes
//   Call: RegisterHelpdesk(r, db)
//
// Registration pattern (in main.go):
//
//   // Public (outside auth group):
//   r.Route("/api/helpdesk", func(r chi.Router) {
//       handlers.RegisterHelpdeskPublic(r, db)
//   })
//   // Protected (inside auth group):
//   r.Route("/api/helpdesk", func(r chi.Router) {
//       handlers.RegisterHelpdeskProtected(r, db)
//   })
//
// OR use the combined helper:
//   handlers.RegisterHelpdesk(r, db)   // mounts all routes directly on r

package handlers

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/mail"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// ── Route registration ────────────────────────────────────────────────────────

// RegisterHelpdeskPublic mounts no-auth helpdesk endpoints.
// Call this BEFORE the JWT auth middleware group in main.go.
func RegisterHelpdeskPublic(r chi.Router, db *core.DB) {
	r.Post("/inbound/email", hdInboundEmail(db))
	r.Post("/inbound/sms", hdInboundSMS(db))
	r.Get("/csat/{token}", hdCSATGet(db))
	r.Post("/csat/{token}", hdCSATSubmit(db))
}

// RegisterHelpdesk mounts auth-protected helpdesk endpoints.
// Call this INSIDE the JWT auth middleware group in main.go.
func ensureHelpdeskColumns(ctx context.Context, db *core.DB) {
	alters := []string{
		`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS first_response_at TIMESTAMPTZ`,
		`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ`,
		`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ`,
		`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS sla_due_at TIMESTAMPTZ`,
		`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS first_response_due TIMESTAMPTZ`,
		`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS sla_breached BOOLEAN DEFAULT FALSE`,
		`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS csat_score INT`,
		`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS csat_token TEXT`,
		`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS department TEXT`,
		`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS customer_email TEXT`,
		`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS customer_phone TEXT`,
		`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS customer_cif TEXT`,
		`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS customer_name TEXT`,
		`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS ticket_ref TEXT`,
		`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS source_system TEXT NOT NULL DEFAULT 'o3_crm'`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_hd_tickets_ref ON helpdesk_tickets(ticket_ref) WHERE ticket_ref IS NOT NULL`,
		`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS sla_warning_sent BOOLEAN DEFAULT FALSE`,
		`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS unassigned_alert_sent BOOLEAN DEFAULT FALSE`,
		// Zoho Desk ticket owner (assignee). Captured from the sync so ownership
		// survives even when the Zoho agent has no matching workspace user account.
		`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS zoho_assignee_id TEXT`,
		`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS zoho_assignee_name TEXT`,
		`ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS zoho_assignee_email TEXT`,
	}
	for _, sql := range alters {
		db.PGExec(ctx, sql) //nolint:errcheck
	}
}

// StartSLABreachMonitor runs every 60 s, finds tickets whose SLA has expired but
// sla_breached is not yet set, marks them, and notifies the assigned agent + call_center_head.
func StartSLABreachMonitor(db *core.DB) {
	go func() {
		ticker := time.NewTicker(60 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			ctx := context.Background()
			rows, err := db.PGQuery(ctx, `
				UPDATE helpdesk_tickets
				SET sla_breached=true, updated_at=NOW()
				WHERE sla_due_at < NOW()
				  AND (sla_breached IS NULL OR sla_breached=false)
				  AND status NOT IN ('resolved','closed')
				RETURNING id, ticket_ref, assigned_to`)
			if err != nil {
				slog.Error("SLA breach monitor: update failed", "err", err)
				continue
			}
			for _, row := range rows {
				ticketID := toInt64(row["id"])
				ticketRef := str(row["ticket_ref"])
				assignedTo := toInt64(row["assigned_to"])
				hdRecordEvent(ctx, db, ticketID, 0, "sla_breached", "", ticketRef)
				payload := NotifPayload{
					EventType: EvtTicketSLABreach,
					Title:     fmt.Sprintf("SLA breached: %s", ticketRef),
					Body:      fmt.Sprintf("Ticket %s has breached its SLA and requires immediate attention.", ticketRef),
					ActionURL: fmt.Sprintf("/helpdesk/%d", ticketID),
					EntityRef: ticketRef,
				}
				if assignedTo > 0 {
					go Notify(ctx, db, NotifPayload{EventType: payload.EventType, UserID: assignedTo, Title: payload.Title, Body: payload.Body, ActionURL: payload.ActionURL, EntityRef: payload.EntityRef})
				}
				go NotifyRole(ctx, db, "call_center_head", payload)
			}

			// SLA warning: 30 min before breach
			warnRows, _ := db.PGQuery(ctx, `
				UPDATE helpdesk_tickets
				SET sla_warning_sent=TRUE, updated_at=NOW()
				WHERE sla_due_at BETWEEN NOW() AND NOW() + INTERVAL '30 minutes'
				  AND (sla_warning_sent IS NULL OR sla_warning_sent=FALSE)
				  AND (sla_breached IS NULL OR sla_breached=FALSE)
				  AND status NOT IN ('resolved','closed')
				RETURNING id, ticket_ref, assigned_to`)
			for _, row := range warnRows {
				ticketID := toInt64(row["id"])
				ticketRef := str(row["ticket_ref"])
				assignedTo := toInt64(row["assigned_to"])
				p := NotifPayload{
					EventType: EvtTicketSLAWarning,
					Title:     fmt.Sprintf("SLA warning: %s", ticketRef),
					Body:      fmt.Sprintf("Ticket %s will breach its SLA in less than 30 minutes.", ticketRef),
					ActionURL: fmt.Sprintf("/helpdesk/%d", ticketID),
					EntityRef: ticketRef,
				}
				if assignedTo > 0 {
					go Notify(ctx, db, NotifPayload{EventType: p.EventType, UserID: assignedTo, Title: p.Title, Body: p.Body, ActionURL: p.ActionURL, EntityRef: p.EntityRef})
				}
				go NotifyRole(ctx, db, "call_center_head", p)
			}

			// Unassigned alert: tickets open > 1 hour with no assigned agent
			unassignRows, _ := db.PGQuery(ctx, `
				UPDATE helpdesk_tickets
				SET unassigned_alert_sent=TRUE, updated_at=NOW()
				WHERE assigned_to IS NULL
				  AND status NOT IN ('resolved','closed')
				  AND created_at < NOW() - INTERVAL '1 hour'
				  AND (unassigned_alert_sent IS NULL OR unassigned_alert_sent=FALSE)
				RETURNING id, ticket_ref`)
			for _, row := range unassignRows {
				ticketID := toInt64(row["id"])
				ticketRef := str(row["ticket_ref"])
				go NotifyRole(ctx, db, "call_center_head", NotifPayload{
					EventType: EvtTicketUnassignedAlert,
					Title:     fmt.Sprintf("Unassigned ticket: %s", ticketRef),
					Body:      fmt.Sprintf("Ticket %s has been open for over 1 hour with no assigned agent.", ticketRef),
					ActionURL: fmt.Sprintf("/helpdesk/%d", ticketID),
					EntityRef: ticketRef,
				})
			}
		}
	}()
}

func RegisterHelpdesk(r chi.Router, db *core.DB) {
	ensureHelpdeskColumns(context.Background(), db)
	ensureKBFeedbackSchema(context.Background(), db)
	ensureCallScriptsSchema(context.Background(), db)
	go StartSLABreachMonitor(db)

	r.Group(func(r chi.Router) {
		r.Use(core.RequirePages("helpdesk"))

		r.Get("/stats", hdStats(db))
		r.Get("/supervisor", hdSupervisor(db))
		r.Post("/tickets", hdCreateTicket(db))
		r.Get("/tickets", hdListTickets(db))
		r.Get("/tickets/search", hdSearchTickets(db))
		r.Get("/tickets/summary", hdQueueSummary(db))
		// Bulk actions — must be before /{id} so chi resolves them first
		r.Post("/tickets/bulk-assign", hdBulkAssignTickets(db))
		r.Post("/tickets/bulk-close", hdBulkCloseTickets(db))
		r.Post("/tickets/bulk-priority", hdBulkPriorityTickets(db))
		r.Post("/tickets/distribute", hdDistributeTickets(db))
		r.Post("/tickets/{id}/claim", hdClaimTicket(db))
		r.Get("/tickets/{id}", hdGetTicket(db))
		r.Patch("/tickets/{id}", hdUpdateTicket(db))
		r.Post("/tickets/{id}/messages", hdSendMessage(db))
		r.Post("/tickets/{id}/promise", hdTicketPromise(db))
		r.Post("/tickets/{id}/merge", hdMergeTicket(db))
		r.Get("/canned-responses", hdListCanned(db))
		r.Post("/canned-responses", hdCreateCanned(db))
		r.Post("/canned-responses/{id}/use", hdUseCanned(db))
		r.Put("/canned-responses/{id}", hdUpdateCanned(db))
		r.Delete("/canned-responses/{id}", hdDeleteCanned(db))
		r.Get("/sla-policies", hdListSLA(db))
		r.Put("/sla-policies/{id}", hdUpdateSLA(db))
		r.Get("/calls", hdListCalls(db))
		r.Post("/calls", hdLogCall(db))
		r.Get("/calls/stats", hdCallStats(db))

		// Knowledge Base
		r.Get("/kb", hdKBList(db))
		r.Post("/kb", hdKBCreate(db))
		r.Get("/kb/search", hdKBSearch(db))
		r.Get("/kb/{id}", hdKBGet(db))
		r.Put("/kb/{id}", hdKBUpdate(db))
		r.Delete("/kb/{id}", hdKBDelete(db))
		r.Post("/kb/{id}/view", hdKBIncView(db))
		r.Put("/kb/{id}/status", hdKBSetStatus(db))

		// Analytics endpoints consumed by Stats page
		r.Get("/agents", hdListAgents(db))
		r.Get("/csat-trend", hdCSATTrend(db))
		r.Get("/handle-time-by-type", hdHandleTimeByType(db))
		r.Get("/resolution-by-agent", hdResolutionByAgent(db))
		r.Get("/type-distribution", hdTypeDistribution(db))

		// Inbound call auto-ticket webhook (Zoho Voice)
		r.Get("/inbound/call", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })
		r.Post("/inbound/call", hdInboundCall(db))

		// Ticket enriched context (customer360 data)
		r.Get("/tickets/{id}/context", hdTicketContext(db))
		r.Get("/tickets/{id}/calls", hdTicketCalls(db))

		// KB article feedback
		r.Post("/kb/{id}/feedback", hdKBFeedback(db))
		// KB compliance approval
		r.Put("/kb/{id}/approve", hdKBApprove(db))

		// Extended stats analytics
		r.Get("/stats/leaderboard", hdStatsLeaderboard(db))
		r.Get("/stats/sla-by-agent", hdStatsSLAByAgent(db))
		r.Get("/stats/busiest-hours", hdStatsBusiestHours(db))
		r.Get("/stats/channel-breakdown", hdStatsChannelBreakdown(db))

		// Agent helpdesk status (Available / On Call / Break / Offline)
		r.Put("/agents/{id}/status", hdSetAgentStatus(db))

		// Call Center settings (e.g. daily call target) — supervisors set them.
		r.Get("/cc-settings", hdCCSettings(db))
		r.Put("/cc-settings", hdSetCCSettings(db))

		// Routing rules CRUD
		r.Get("/routing-rules", hdListRoutingRules(db))
		r.Post("/routing-rules", hdCreateRoutingRule(db))
		r.Put("/routing-rules/{id}", hdUpdateRoutingRule(db))
		r.Delete("/routing-rules/{id}", hdDeleteRoutingRule(db))

		// MS Graph email ingest — poll helpdesk inbox and create tickets
		r.Post("/email-ingest", hdMSGraphIngest(db))

		// CBN Consumer Protection report
		r.Get("/reports/cbn-consumer-protection", hdCBNReport(db))

		// Call scripts
		r.Get("/call-scripts", hdListCallScripts(db))
		r.Get("/call-scripts/by-type", hdGetCallScriptByType(db))
		r.Post("/call-scripts", hdCreateCallScript(db))
		r.Put("/call-scripts/{id}", hdUpdateCallScript(db))
		r.Delete("/call-scripts/{id}", hdDeleteCallScript(db))

		// Agent dashboard
		r.Get("/my-dashboard", hdMyDashboard(db))

		// Care module dashboard — KPIs scoped to the email (mail) channel.
		r.Get("/care-dashboard", hdCareDashboard(db))

		// Customer history — a customer's other tickets + calls (read-only context
		// so Care knows the customer before replying to their mail).
		r.Get("/customer-history", hdCustomerHistory(db))

		// Caller lookup — phone number → caller 360 (identity + open tickets +
		// recent calls) for an in-app screen pop. Matched on last 10 digits.
		r.Get("/caller-lookup", hdCallerLookup(db))

		// Care supervisor — team mail load, unassigned pool, per-agent stats.
		r.Get("/care-supervisor", hdCareSupervisor(db))

		// Care backlog — round-robin distribute the unassigned mail pool to agents.
		r.Post("/care-distribute", hdCareDistribute(db))

		// Care analytics — mail-channel trends, agent leaderboard, CSAT, peak hours.
		r.Get("/care-analytics", hdCareAnalytics(db))
	})
}

// hdCareAnalytics returns time-series and team analytics for the Care module
// (email channel): volume & resolution trends, first-response trend, per-agent
// leaderboard, CSAT, status mix and peak inbound hours. Window is ?days (default 30).
func hdCareAnalytics(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		days := qint(r, "days", 30, 1, 365)
		since := fmt.Sprintf("NOW() - INTERVAL '%d days'", days)

		one := func(sql string) any {
			rows, _ := db.PGQuery(ctx, sql)
			if len(rows) > 0 {
				return rows[0]["n"]
			}
			return nil
		}
		received := one(`SELECT COUNT(*) AS n FROM helpdesk_tickets WHERE channel='email' AND created_at >= ` + since)
		resolved := one(`SELECT COUNT(*) AS n FROM helpdesk_tickets WHERE channel='email' AND resolved_at IS NOT NULL AND resolved_at >= ` + since)
		openBacklog := one(`SELECT COUNT(*) AS n FROM helpdesk_tickets WHERE channel='email' AND status NOT IN ('resolved','closed')`)
		avgFirst := one(`SELECT ROUND(AVG(EXTRACT(EPOCH FROM (first_response_at - created_at))/60.0)) AS n
			FROM helpdesk_tickets WHERE channel='email' AND first_response_at IS NOT NULL AND created_at >= ` + since)
		avgResolution := one(`SELECT ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))/3600.0)::numeric, 1) AS n
			FROM helpdesk_tickets WHERE channel='email' AND resolved_at IS NOT NULL AND resolved_at >= ` + since)
		csatAvg := one(`SELECT ROUND(AVG(csat_score)::numeric, 2) AS n FROM helpdesk_tickets
			WHERE channel='email' AND csat_score IS NOT NULL AND csat_submitted_at >= ` + since)
		csatCount := one(`SELECT COUNT(*) AS n FROM helpdesk_tickets
			WHERE channel='email' AND csat_score IS NOT NULL AND csat_submitted_at >= ` + since)

		// Daily volume: received vs resolved (one row per day in-window, zero-filled).
		volume, _ := db.PGQuery(ctx, fmt.Sprintf(`
			WITH d AS (SELECT generate_series((CURRENT_DATE - INTERVAL '%d days')::date, CURRENT_DATE, '1 day')::date AS day)
			SELECT TO_CHAR(d.day, 'YYYY-MM-DD') AS date,
			  COALESCE((SELECT COUNT(*) FROM helpdesk_tickets t WHERE t.channel='email' AND t.created_at::date = d.day), 0) AS received,
			  COALESCE((SELECT COUNT(*) FROM helpdesk_tickets t WHERE t.channel='email' AND t.resolved_at::date = d.day), 0) AS resolved
			FROM d ORDER BY d.day`, days-1))

		// First-response trend (avg minutes by day, only days with data).
		respTrend, _ := db.PGQuery(ctx, `
			SELECT TO_CHAR(created_at::date, 'YYYY-MM-DD') AS date,
			  ROUND(AVG(EXTRACT(EPOCH FROM (first_response_at - created_at))/60.0)) AS avg_first_mins
			FROM helpdesk_tickets
			WHERE channel='email' AND first_response_at IS NOT NULL AND created_at >= `+since+`
			GROUP BY created_at::date ORDER BY created_at::date`)

		// Peak inbound hours (0–23) over the window.
		byHour, _ := db.PGQuery(ctx, `
			SELECT EXTRACT(HOUR FROM m.created_at)::int AS hour, COUNT(*) AS n
			FROM helpdesk_messages m JOIN helpdesk_tickets t ON t.id = m.ticket_id
			WHERE t.channel='email' AND m.direction='inbound' AND m.created_at >= `+since+`
			GROUP BY 1 ORDER BY 1`)

		// Status mix of email tickets in-window.
		statusMix, _ := db.PGQuery(ctx, `
			SELECT status, COUNT(*) AS n FROM helpdesk_tickets
			WHERE channel='email' AND created_at >= `+since+`
			GROUP BY status ORDER BY n DESC`)

		// Agent leaderboard (resolved in-window; response/handle/CSAT).
		agents, _ := db.PGQuery(ctx, `
			SELECT u.full_name AS agent_name,
			  COUNT(*) FILTER (WHERE t.resolved_at IS NOT NULL AND t.resolved_at >= `+since+`)                         AS resolved,
			  ROUND(AVG(EXTRACT(EPOCH FROM (t.first_response_at - t.created_at))/60.0)
			        FILTER (WHERE t.first_response_at IS NOT NULL AND t.created_at >= `+since+`))                      AS avg_first_response_mins,
			  ROUND(AVG(EXTRACT(EPOCH FROM (t.resolved_at - t.created_at))/60.0)
			        FILTER (WHERE t.resolved_at IS NOT NULL AND t.resolved_at >= `+since+`))                           AS avg_handle_mins,
			  ROUND(AVG(t.csat_score)::numeric, 2)
			        FILTER (WHERE t.csat_score IS NOT NULL AND t.csat_submitted_at >= `+since+`)                       AS csat
			FROM helpdesk_tickets t JOIN o3c_users u ON u.id = t.assigned_to
			WHERE t.channel='email'
			GROUP BY u.id, u.full_name
			HAVING COUNT(*) FILTER (WHERE t.resolved_at IS NOT NULL AND t.resolved_at >= `+since+`) > 0
			    OR COUNT(*) FILTER (WHERE t.status NOT IN ('resolved','closed')) > 0
			ORDER BY resolved DESC, u.full_name LIMIT 50`)

		for _, s := range []*[]core.Row{&volume, &respTrend, &byHour, &statusMix, &agents} {
			if *s == nil {
				*s = []core.Row{}
			}
		}

		var resolutionRate any
		if rv, ok := received.(int64); ok && rv > 0 {
			if sv, ok := resolved.(int64); ok {
				resolutionRate = float64(sv) / float64(rv) * 100.0
			}
		}

		respond(w, map[string]any{
			"summary": map[string]any{
				"received":                received,
				"resolved":                resolved,
				"resolution_rate":         resolutionRate,
				"open_backlog":            openBacklog,
				"avg_first_response_mins": avgFirst,
				"avg_resolution_hours":    avgResolution,
				"csat_avg":                csatAvg,
				"csat_count":              csatCount,
			},
			"volume":         volume,
			"response_trend": respTrend,
			"by_hour":        byHour,
			"status_mix":     statusMix,
			"agents":         agents,
			"days":           days,
		}, "care")
	}
}

// hdCareSupervisor returns team-level mail metrics for the Care module: headline
// KPIs, the unassigned pool, and per-agent load (all scoped to the email channel).
func hdCareSupervisor(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		count := func(sql string) int64 {
			rows, _ := db.PGQuery(ctx, sql)
			if len(rows) > 0 {
				return toInt64(rows[0]["n"])
			}
			return 0
		}
		open := count(`SELECT COUNT(*) AS n FROM helpdesk_tickets WHERE channel='email' AND status NOT IN ('resolved','closed')`)
		unassigned := count(`SELECT COUNT(*) AS n FROM helpdesk_tickets WHERE channel='email' AND status NOT IN ('resolved','closed') AND assigned_to IS NULL`)
		resolvedToday := count(`SELECT COUNT(*) AS n FROM helpdesk_tickets WHERE channel='email' AND status IN ('resolved','closed') AND resolved_at::date=CURRENT_DATE`)
		slaAtRisk := count(`SELECT COUNT(*) AS n FROM helpdesk_tickets WHERE channel='email' AND status NOT IN ('resolved','closed') AND sla_due_at IS NOT NULL AND sla_due_at <= NOW() + INTERVAL '2 hours'`)
		awaiting := count(`
			SELECT COUNT(*) AS n FROM helpdesk_tickets t
			WHERE t.channel='email' AND t.status NOT IN ('resolved','closed')
			  AND (SELECT m.direction FROM helpdesk_messages m WHERE m.ticket_id=t.id ORDER BY m.created_at DESC LIMIT 1) = 'inbound'`)

		agents, _ := db.PGQuery(ctx, `
			SELECT u.full_name AS agent_name,
			  COUNT(*) FILTER (WHERE t.status NOT IN ('resolved','closed'))                                    AS open,
			  COUNT(*) FILTER (WHERE t.status IN ('resolved','closed') AND t.resolved_at::date=CURRENT_DATE)    AS resolved_today,
			  ROUND(AVG(EXTRACT(EPOCH FROM (t.first_response_at - t.created_at))/60.0)
			        FILTER (WHERE t.first_response_at IS NOT NULL))                                            AS avg_first_response_mins,
			  COUNT(*) FILTER (WHERE t.status NOT IN ('resolved','closed') AND t.sla_due_at IS NOT NULL
			        AND t.sla_due_at <= NOW() + INTERVAL '2 hours')                                            AS sla_at_risk
			FROM helpdesk_tickets t
			JOIN o3c_users u ON u.id = t.assigned_to
			WHERE t.channel='email'
			GROUP BY u.id, u.full_name
			ORDER BY open DESC, u.full_name`)

		unassignedList, _ := db.PGQuery(ctx, `
			SELECT id, ticket_ref, subject, NULLIF(customer_name,'') AS customer_name,
			       created_at, COALESCE(updated_at, created_at) AS last_at, priority
			FROM helpdesk_tickets
			WHERE channel='email' AND status NOT IN ('resolved','closed') AND assigned_to IS NULL
			ORDER BY created_at ASC LIMIT 25`)

		if agents == nil {
			agents = []core.Row{}
		}
		if unassignedList == nil {
			unassignedList = []core.Row{}
		}
		respond(w, map[string]any{
			"open":               open,
			"unassigned":         unassigned,
			"awaiting_reply":     awaiting,
			"resolved_today":     resolvedToday,
			"sla_at_risk":        slaAtRisk,
			"agents":             agents,
			"unassigned_tickets": unassignedList,
		}, "care")
	}
}

// hdCareDistribute round-robins the unassigned open email backlog across a set of
// Care agents so a supervisor can clear the queue in one action. Oldest mail is
// assigned first. If no agent_ids are supplied it falls back to every active
// call-centre agent/head. Head/admin only.
func hdCareDistribute(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		caller := core.UserFromCtx(ctx)
		if caller == nil || (caller.Role != "call_center_head" && caller.Role != "admin") {
			respondErr(w, 403, "insufficient role")
			return
		}
		var b struct {
			AgentIDs []int64 `json:"agent_ids"`
			Max      int     `json:"max"`
		}
		_ = json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck

		// Resolve the agent pool (validated, active). Default: all active CC agents/heads.
		type agent struct {
			id   int64
			name string
		}
		var pool []agent
		if len(b.AgentIDs) > 0 {
			ph := make([]string, len(b.AgentIDs))
			args := make([]any, len(b.AgentIDs))
			for i, id := range b.AgentIDs {
				ph[i] = fmt.Sprintf("$%d", i+1)
				args[i] = id
			}
			rows, _ := db.PGQuery(ctx, fmt.Sprintf(
				`SELECT id, full_name FROM o3c_users WHERE is_active=TRUE AND deleted_at IS NULL AND id IN (%s) ORDER BY id`,
				strings.Join(ph, ",")), args...)
			for _, row := range rows {
				pool = append(pool, agent{toInt64(row["id"]), fmt.Sprint(row["full_name"])})
			}
		} else {
			rows, _ := db.PGQuery(ctx,
				`SELECT id, full_name FROM o3c_users WHERE is_active=TRUE AND deleted_at IS NULL
				   AND role IN ('call_center_agent','call_center_head') ORDER BY id`)
			for _, row := range rows {
				pool = append(pool, agent{toInt64(row["id"]), fmt.Sprint(row["full_name"])})
			}
		}
		if len(pool) == 0 {
			respondErr(w, 422, "no active agents available to distribute to")
			return
		}

		max := b.Max
		if max <= 0 || max > 1000 {
			max = 200
		}
		// Oldest unassigned open email first — these have waited longest.
		rows, err := db.PGQuery(ctx,
			`SELECT id FROM helpdesk_tickets
			   WHERE channel='email' AND status NOT IN ('resolved','closed') AND assigned_to IS NULL
			   ORDER BY created_at ASC LIMIT $1`, max)
		if err != nil {
			respondErr(w, 500, "failed to read backlog")
			return
		}

		perAgent := make(map[string]int, len(pool))
		assigned := 0
		for i, row := range rows {
			a := pool[i%len(pool)]
			if _, err := db.PGExec(ctx,
				`UPDATE helpdesk_tickets SET assigned_to=$1, updated_at=NOW()
				   WHERE id=$2 AND assigned_to IS NULL`, a.id, toInt64(row["id"])); err == nil {
				assigned++
				perAgent[a.name]++
			}
		}
		respond(w, map[string]any{
			"assigned":  assigned,
			"agents":    len(pool),
			"per_agent": perAgent,
		}, "care")
	}
}

// lastNDigits keeps only the digits of s and returns the trailing n of them —
// so "+234 802 387 6102" and "08023876102" both normalise to "8023876102".
func lastNDigits(s string, n int) string {
	d := make([]rune, 0, len(s))
	for _, c := range s {
		if c >= '0' && c <= '9' {
			d = append(d, c)
		}
	}
	if len(d) > n {
		d = d[len(d)-n:]
	}
	return string(d)
}

// hdCallerLookup resolves a phone number to the caller's 360 — identity (from the
// Accounts source-of-truth, else CRM leads), their open support tickets, and
// recent calls — for an in-app screen pop. Matched on the last 10 digits.
func hdCallerLookup(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		raw := qstr(r, "phone")
		norm := lastNDigits(raw, 10)
		if norm == "" {
			respondErr(w, 422, "phone is required")
			return
		}
		var name, cif, email, phone string
		found, existing := false, false

		// 1. Accounts — identity source of truth (an existing customer).
		if rows, _ := db.PGQuery(ctx, `
			SELECT first_name AS fn, last_name AS ln, cif, email, phone
			FROM app.customers
			WHERE right(regexp_replace(COALESCE(phone,''), '\D', '', 'g'), 10) = $1
			LIMIT 1`, norm); len(rows) > 0 {
			name = strings.TrimSpace(str(rows[0]["fn"]) + " " + str(rows[0]["ln"]))
			cif, email, phone = str(rows[0]["cif"]), str(rows[0]["email"]), str(rows[0]["phone"])
			found, existing = true, true
		}
		// 2. CRM leads fallback.
		if !found {
			if rows, _ := db.PGQuery(ctx, `
				SELECT trim(concat(coalesce(first_name,''),' ',coalesce(last_name,''))) AS name,
				       coalesce(cif_number,'') AS cif, coalesce(email,'') AS email, coalesce(phone,'') AS phone
				FROM crm_contacts
				WHERE right(regexp_replace(coalesce(phone,''), '\D', '', 'g'), 10) = $1
				LIMIT 1`, norm); len(rows) > 0 {
				name = strings.TrimSpace(str(rows[0]["name"]))
				cif, email, phone = str(rows[0]["cif"]), str(rows[0]["email"]), str(rows[0]["phone"])
				found = true
			}
		}
		if phone == "" {
			phone = raw
		}

		// Open support tickets (web/social) for this caller.
		tickets, _ := db.PGQuery(ctx, `
			SELECT id, ticket_ref, subject, status, priority, created_at
			FROM helpdesk_tickets
			WHERE status NOT IN ('closed','resolved')
			  AND (channel IS NULL OR channel NOT IN ('email','call'))
			  AND ( ($1 <> '' AND customer_cif = $1)
			     OR right(regexp_replace(COALESCE(customer_phone,''), '\D', '', 'g'), 10) = $2 )
			ORDER BY created_at DESC LIMIT 10`, cif, norm)

		// Recent calls to/from this number.
		calls, _ := db.PGQuery(ctx, `
			SELECT id, INITCAP(direction) AS direction, outcome, duration_sec, started_at, agent_name
			FROM helpdesk_calls
			WHERE right(regexp_replace(COALESCE(customer_phone,''), '\D', '', 'g'), 10) = $1
			ORDER BY started_at DESC LIMIT 10`, norm)

		if tickets == nil {
			tickets = []core.Row{}
		}
		if calls == nil {
			calls = []core.Row{}
		}
		respond(w, map[string]any{
			"found":                found,
			"is_existing_customer": existing,
			"name":                 name,
			"cif":                  cif,
			"email":                email,
			"phone":                phone,
			"open_tickets":         tickets,
			"recent_calls":         calls,
		}, "lookup")
	}
}

// hdCustomerHistory returns a customer's other tickets (matched by CIF or email)
// and recent calls, for the read-only context panel in the Care Inbox.
func hdCustomerHistory(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		cif := qstr(r, "cif")
		email := qstr(r, "email")
		exclude := qstr(r, "exclude")
		if cif == "" && email == "" {
			respond(w, map[string]any{"tickets": []any{}, "calls": []any{}}, "history")
			return
		}
		tickets, _ := db.PGQuery(ctx, `
			SELECT t.id, t.ticket_ref, t.channel, t.status, t.priority, t.subject,
			       t.created_at, COALESCE(t.updated_at, t.created_at) AS last_at,
			       u.full_name AS assigned_to_name
			FROM helpdesk_tickets t
			LEFT JOIN o3c_users u ON u.id = t.assigned_to
			WHERE (($1 <> '' AND t.customer_cif = $1)
			    OR ($2 <> '' AND lower(t.customer_email) = lower($2)))
			  AND ($3 = '' OR t.id::text <> $3)
			ORDER BY COALESCE(t.updated_at, t.created_at) DESC LIMIT 30`, cif, email, exclude)
		var calls []core.Row
		if cif != "" {
			calls, _ = db.PGQuery(ctx, `
				SELECT id, direction, outcome, duration_sec, agent_name, customer_name, started_at
				FROM helpdesk_calls WHERE customer_cif=$1 ORDER BY started_at DESC LIMIT 15`, cif)
		}
		if tickets == nil {
			tickets = []core.Row{}
		}
		if calls == nil {
			calls = []core.Row{}
		}
		respond(w, map[string]any{"tickets": tickets, "calls": calls}, "history")
	}
}

// hdCareDashboard returns mail-workload KPIs for the Care module (email-channel
// tickets): open, awaiting-reply, unassigned, resolved-today, SLA-at-risk,
// average first response, and a recent-mail list.
func hdCareDashboard(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		count := func(sql string) int64 {
			rows, _ := db.PGQuery(ctx, sql)
			if len(rows) > 0 {
				return toInt64(rows[0]["n"])
			}
			return 0
		}
		openMails := count(`SELECT COUNT(*) AS n FROM helpdesk_tickets WHERE channel='email' AND status NOT IN ('resolved','closed')`)
		unassigned := count(`SELECT COUNT(*) AS n FROM helpdesk_tickets WHERE channel='email' AND status NOT IN ('resolved','closed') AND assigned_to IS NULL`)
		resolvedToday := count(`SELECT COUNT(*) AS n FROM helpdesk_tickets WHERE channel='email' AND status IN ('resolved','closed') AND resolved_at::date=CURRENT_DATE`)
		slaAtRisk := count(`SELECT COUNT(*) AS n FROM helpdesk_tickets WHERE channel='email' AND status NOT IN ('resolved','closed') AND sla_due_at IS NOT NULL AND sla_due_at <= NOW() + INTERVAL '2 hours'`)
		awaiting := count(`
			SELECT COUNT(*) AS n FROM helpdesk_tickets t
			WHERE t.channel='email' AND t.status NOT IN ('resolved','closed')
			  AND (SELECT m.direction FROM helpdesk_messages m WHERE m.ticket_id=t.id ORDER BY m.created_at DESC LIMIT 1) = 'inbound'`)

		var avgFirst any
		if rows, _ := db.PGQuery(ctx, `
			SELECT ROUND(AVG(EXTRACT(EPOCH FROM (first_response_at - created_at))/60.0)) AS n
			FROM helpdesk_tickets
			WHERE channel='email' AND first_response_at IS NOT NULL
			  AND created_at >= NOW() - INTERVAL '30 days'`); len(rows) > 0 {
			avgFirst = rows[0]["n"]
		}

		recent, _ := db.PGQuery(ctx, `
			SELECT id, ticket_ref, subject, status, priority,
			       NULLIF(customer_name,'') AS customer_name, customer_cif,
			       created_at, updated_at AS last_message_at
			FROM helpdesk_tickets
			WHERE channel='email'
			ORDER BY updated_at DESC LIMIT 8`)
		if recent == nil {
			recent = []core.Row{}
		}

		respond(w, map[string]any{
			"open_mails":              openMails,
			"unassigned":              unassigned,
			"awaiting_reply":          awaiting,
			"resolved_today":          resolvedToday,
			"sla_at_risk":             slaAtRisk,
			"avg_first_response_mins": avgFirst,
			"recent":                  recent,
		}, "care")
	}
}

func hdMyDashboard(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		ctx := r.Context()

		statsRows, _ := db.PGQuery(ctx, `
			SELECT
				COUNT(CASE WHEN status NOT IN ('resolved','closed') THEN 1 END)                                                                   AS open_tickets,
				COUNT(CASE WHEN status NOT IN ('resolved','closed') AND sla_due_at IS NOT NULL AND sla_due_at < NOW() THEN 1 END)                 AS sla_breached,
				COUNT(CASE WHEN status = 'resolved' AND updated_at::date = CURRENT_DATE THEN 1 END)                                               AS resolved_today,
				COUNT(CASE WHEN created_at::date = CURRENT_DATE THEN 1 END)                                                                       AS tickets_today,
				COALESCE(ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))/60.0) FILTER (WHERE resolved_at IS NOT NULL)), 0)               AS avg_handle_time_mins,
				ROUND(AVG(csat_score) FILTER (WHERE csat_score IS NOT NULL)::numeric, 1)                                                          AS csat_score
			FROM helpdesk_tickets
			WHERE assigned_to = $1 AND (channel IS NULL OR channel NOT IN ('email','call'))`, user.ID)

		// Open tickets — awaiting-my-reply first (customer spoke last), then SLA
		// breaches, then newest. last_message_direction lets the UI badge which
		// tickets are actually waiting on this agent vs the customer.
		recentRows, _ := db.PGQuery(ctx, `
			SELECT t.id, t.ticket_ref, t.subject, t.customer_name, t.status, t.priority, t.created_at, t.sla_due_at,
			       COALESCE(lm.last_dir, 'inbound') AS last_message_direction,
			       (COALESCE(lm.last_dir, 'inbound') <> 'outbound') AS awaiting_me
			FROM helpdesk_tickets t
			LEFT JOIN LATERAL (
				SELECT m.direction AS last_dir FROM helpdesk_messages m
				WHERE m.ticket_id = t.id ORDER BY m.created_at DESC LIMIT 1
			) lm ON TRUE
			WHERE t.assigned_to = $1 AND t.status NOT IN ('closed','resolved')
			  AND (t.channel IS NULL OR t.channel NOT IN ('email','call'))
			ORDER BY awaiting_me DESC,
			         (t.sla_due_at IS NOT NULL AND t.sla_due_at < NOW()) DESC,
			         t.created_at DESC
			LIMIT 12`, user.ID)
		if recentRows == nil {
			recentRows = []core.Row{}
		}

		// ── Forward-looking "My Day" work counts ──────────────────────────────
		// Tickets where the customer spoke last → the agent owes a reply.
		var awaitingMyReply int64
		if rows, _ := db.PGQuery(ctx, `
			SELECT COUNT(*) AS n
			FROM helpdesk_tickets t
			LEFT JOIN LATERAL (
				SELECT m.direction AS last_dir FROM helpdesk_messages m
				WHERE m.ticket_id = t.id ORDER BY m.created_at DESC LIMIT 1
			) lm ON TRUE
			WHERE t.assigned_to = $1 AND t.status NOT IN ('resolved','closed')
			  AND (t.channel IS NULL OR t.channel NOT IN ('email','call'))
			  AND COALESCE(lm.last_dir, 'inbound') <> 'outbound'`, user.ID); len(rows) > 0 {
			awaitingMyReply = toInt64(rows[0]["n"])
		}
		// Outbound contacts still waiting to be dialled (shared queue).
		var queuePending int64
		if rows, _ := db.PGQuery(ctx, `SELECT COUNT(*) AS n FROM call_center_contacts WHERE status = 'pending'`); len(rows) > 0 {
			queuePending = toInt64(rows[0]["n"])
		}
		// Callbacks this agent has promised (populates as outbound dispositions land
		// in the call ledger).
		var callbacksDue int64
		if user != nil {
			if rows, _ := db.PGQuery(ctx, `SELECT COUNT(*) AS n FROM helpdesk_calls WHERE agent_id = $1 AND outcome ILIKE '%callback%'`, user.ID); len(rows) > 0 {
				callbacksDue = toInt64(rows[0]["n"])
			}
		}

		// CSAT trend (14 days) — {date, score}. Only days with a scored survey appear.
		csatTrend, _ := db.PGQuery(ctx, `
			SELECT TO_CHAR(csat_submitted_at::date, 'YYYY-MM-DD') AS date,
			       ROUND(AVG(csat_score)::numeric, 2) AS score
			FROM helpdesk_tickets
			WHERE assigned_to = $1 AND csat_score IS NOT NULL
			  AND csat_submitted_at >= CURRENT_DATE - INTERVAL '14 days'
			GROUP BY csat_submitted_at::date
			ORDER BY csat_submitted_at::date`, user.ID)
		if csatTrend == nil {
			csatTrend = []core.Row{}
		}

		// Avg handle time by ticket type — {type, avg_mins}.
		handleByType, _ := db.PGQuery(ctx, `
			SELECT COALESCE(NULLIF(ticket_type,''), 'Other') AS type,
			       ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))/60.0)) AS avg_mins
			FROM helpdesk_tickets
			WHERE assigned_to = $1 AND resolved_at IS NOT NULL
			GROUP BY 1
			ORDER BY avg_mins DESC`, user.ID)
		if handleByType == nil {
			handleByType = []core.Row{}
		}

		// ── This agent's call activity (Zoho calls, matched by agent name) ────────
		agentName := ""
		if user != nil {
			agentName = user.FullName
		}
		callToday, _ := db.PGQuery(ctx, `
			SELECT
			  COUNT(*)                                                                                  AS calls_today,
			  COUNT(*) FILTER (WHERE COALESCE(outcome,'') NOT IN ('missed','no_answer','voicemail','')) AS connected_today,
			  COUNT(*) FILTER (WHERE outcome IN ('missed','no_answer','voicemail'))                     AS missed_today,
			  COALESCE(ROUND(AVG(duration_sec)),0)::int                                                 AS avg_talk_sec
			FROM helpdesk_calls
			WHERE agent_name = $1 AND started_at::date = CURRENT_DATE`, agentName)

		callByDay, _ := db.PGQuery(ctx, `
			SELECT started_at::date AS day,
			       COUNT(*)                                                              AS total,
			       COUNT(*) FILTER (WHERE outcome IN ('missed','no_answer','voicemail')) AS missed
			FROM helpdesk_calls
			WHERE agent_name = $1 AND started_at >= CURRENT_DATE - INTERVAL '13 days'
			GROUP BY day ORDER BY day`, agentName)
		if callByDay == nil {
			callByDay = []core.Row{}
		}

		recentCalls, _ := db.PGQuery(ctx, `
			SELECT id, INITCAP(direction) AS direction,
			       COALESCE(NULLIF(customer_name,''), NULLIF(customer_phone,''), 'Unknown') AS customer,
			       outcome, duration_sec, started_at
			FROM helpdesk_calls
			WHERE agent_name = $1
			ORDER BY started_at DESC LIMIT 15`, agentName)
		if recentCalls == nil {
			recentCalls = []core.Row{}
		}

		myCalls := map[string]any{"calls_today": int64(0), "connected_today": int64(0), "missed_today": int64(0), "avg_talk_sec": int64(0)}
		if len(callToday) > 0 {
			myCalls = callToday[0]
		}

		// Yesterday's calls up to the current time — a fair intraday "pace vs
		// yesterday" comparison (not partial-today vs full-yesterday).
		var callsYesterday int64
		if rows, _ := db.PGQuery(ctx, `
			SELECT COUNT(*) AS n FROM helpdesk_calls
			WHERE agent_name=$1 AND started_at::date = CURRENT_DATE - 1
			  AND started_at::time <= NOW()::time`, agentName); len(rows) > 0 {
			callsYesterday = toInt64(rows[0]["n"])
		}

		// My rank today among agents by call volume (+ team size).
		var rankToday, teamSize int64
		if rows, _ := db.PGQuery(ctx, `
			WITH t AS (
			  SELECT agent_name, COUNT(*) AS c FROM helpdesk_calls
			  WHERE started_at::date = CURRENT_DATE AND NULLIF(agent_name,'') IS NOT NULL
			  GROUP BY agent_name)
			SELECT COALESCE((SELECT rnk FROM (SELECT agent_name, RANK() OVER (ORDER BY c DESC) rnk FROM t) x WHERE agent_name=$1), 0) AS rank,
			       (SELECT COUNT(*) FROM t) AS team`, agentName); len(rows) > 0 {
			rankToday = toInt64(rows[0]["rank"])
			teamSize = toInt64(rows[0]["team"])
		}

		// My calls by hour today (live activity strip).
		byHourToday, _ := db.PGQuery(ctx, `
			SELECT EXTRACT(HOUR FROM started_at)::int AS hour,
			       COUNT(*)                                                              AS total,
			       COUNT(*) FILTER (WHERE outcome IN ('missed','no_answer','voicemail')) AS missed
			FROM helpdesk_calls
			WHERE agent_name = $1 AND started_at::date = CURRENT_DATE
			GROUP BY hour ORDER BY hour`, agentName)
		if byHourToday == nil {
			byHourToday = []core.Row{}
		}

		result := map[string]any{
			"open_tickets":         int64(0),
			"sla_breached":         int64(0),
			"resolved_today":       int64(0),
			"tickets_today":        int64(0),
			"avg_handle_time_mins": int64(0),
			"csat_score":           nil, // null → frontend shows "—" (no survey responses yet)
			"recent_tickets":       recentRows,
			"csat_trend":           csatTrend,
			"handle_time_by_type":  handleByType,
			"my_calls":             myCalls,
			"call_by_day":          callByDay,
			"recent_calls":         recentCalls,
			"calls_yesterday":      callsYesterday,
			"rank_today":           rankToday,
			"team_size":            teamSize,
			"by_hour_today":        byHourToday,
			"awaiting_my_reply":    awaitingMyReply,
			"queue_pending":        queuePending,
			"callbacks_due":        callbacksDue,
			"daily_call_target":    ccSettingInt(ctx, db, "daily_call_target", 60),
			"my_status":            "available",
		}
		if user != nil {
			if rows, _ := db.PGQuery(ctx, `SELECT COALESCE(helpdesk_status,'available') AS s FROM o3c_users WHERE id=$1`, user.ID); len(rows) > 0 {
				result["my_status"] = str(rows[0]["s"])
			}
		}
		if len(statsRows) > 0 {
			result["open_tickets"] = statsRows[0]["open_tickets"]
			result["sla_breached"] = statsRows[0]["sla_breached"]
			result["resolved_today"] = statsRows[0]["resolved_today"]
			result["tickets_today"] = statsRows[0]["tickets_today"]
			result["avg_handle_time_mins"] = statsRows[0]["avg_handle_time_mins"]
			result["csat_score"] = statsRows[0]["csat_score"]
		}

		respond(w, result, "pg")
	}
}

// ── Tickets ───────────────────────────────────────────────────────────────────

func hdCreateTicket(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			Channel       string          `json:"channel"`
			Subject       string          `json:"subject"`
			CustomerCIF   *string         `json:"customer_cif"`
			CustomerName  *string         `json:"customer_name"`
			CustomerEmail *string         `json:"customer_email"`
			CustomerPhone *string         `json:"customer_phone"`
			Priority      *string         `json:"priority"`
			Department    *string         `json:"department"`
			MessageText   string          `json:"message_text"`
			MessageHTML   *string         `json:"message_html"`
			TicketType    *string         `json:"ticket_type"`
			Queue         *string         `json:"queue"`
			CustomFields  json.RawMessage `json:"custom_fields"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Channel == "" {
			respondErr(w, 422, "channel is required")
			return
		}
		if b.Subject == "" {
			respondErr(w, 422, "subject is required")
			return
		}
		if b.MessageText == "" {
			respondErr(w, 422, "message_text is required")
			return
		}

		priority := "normal"
		if b.Priority != nil && *b.Priority != "" {
			priority = *b.Priority
		}

		// Look up SLA for priority (DB trigger will also set it from ticket_type)
		slaDueAt := hdComputeSLADue(r.Context(), db, priority)
		firstResponseDue := hdComputeFirstResponseDue(r.Context(), db, priority) // H2

		// C1: Generate CSAT token at ticket creation so CSAT emails can be sent immediately on resolve.
		csatToken := hdNewUUID()

		// Custom fields: pass as JSON string for JSONB column; nil if absent
		var customFieldsArg any
		if len(b.CustomFields) > 0 && string(b.CustomFields) != "null" && string(b.CustomFields) != "{}" {
			customFieldsArg = string(b.CustomFields)
		}

		user := core.UserFromCtx(r.Context())

		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO helpdesk_tickets
			    (channel, status, priority, subject, customer_cif, customer_name,
			     customer_email, customer_phone, department, sla_due_at, first_response_due,
			     ticket_type, queue, custom_fields, csat_token)
			VALUES ($1,'open',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
			RETURNING *`,
			b.Channel, priority, b.Subject,
			ptrOrNil(b.CustomerCIF), ptrOrNil(b.CustomerName),
			ptrOrNil(b.CustomerEmail), ptrOrNil(b.CustomerPhone),
			ptrOrNil(b.Department), slaDueAt, firstResponseDue,
			ptrOrNil(b.TicketType), ptrOrNil(b.Queue), customFieldsArg, csatToken)
		if err != nil {
			slog.Error("hdCreateTicket: insert ticket", "err", err)
			respondErr(w, 500, "Could not create ticket")
			return
		}
		ticket := rows[0]
		ticketID := toInt64(ticket["id"])

		// Give the new ticket an owner immediately (load-balanced) so it doesn't land
		// in the unowned pile. Best-effort — a no-op if no agent is eligible.
		actorID := int64(0)
		if user != nil {
			actorID = user.ID
		}
		if a := hdAutoAssignTicket(r.Context(), db, ticketID, actorID); a != nil {
			ticket["assigned_to"] = *a
		}

		// Insert first message
		msgRows, err := db.PGQuery(r.Context(), `
			INSERT INTO helpdesk_messages
			    (ticket_id, direction, channel, author_user_id, author_name,
			     body_text, body_html, is_internal_note)
			VALUES ($1,'outbound',$2,$3,$4,$5,$6,false)
			RETURNING *`,
			ticketID, b.Channel, user.ID, user.FullName,
			b.MessageText, ptrOrNil(b.MessageHTML))
		if err != nil {
			slog.Error("hdCreateTicket: insert message", "err", err)
		}

		// Record created event
		hdRecordEvent(r.Context(), db, ticketID, user.ID, "created", "", str(ticket["ticket_ref"]))

		// Send via channel
		ctx := r.Context()
		if b.CustomerEmail != nil && *b.CustomerEmail != "" {
			go hdSendTicketEmail(context.Background(), db, ticket, b.MessageText, ptrStr(b.MessageHTML), "", "", "", nil)
		}
		if b.CustomerPhone != nil && *b.CustomerPhone != "" && b.Channel == "sms" {
			go sendSMS(context.Background(), db, *b.CustomerPhone, b.MessageText)
		}
		_ = ctx

		msg := map[string]any{}
		if len(msgRows) > 0 {
			msg = msgRows[0]
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"ticket":  ticket,
			"message": msg,
		})
	}
}

func hdListTickets(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		page := qint(r, "page", 1, 1, 10000)
		perPage := qint(r, "per_page", 25, 1, 200)
		offset := (page - 1) * perPage

		where := "1=1"
		var args []any
		n := 1

		// Row-level scope: leaf agents see their own tickets (any status) plus the
		// still-open unassigned pool they can claim; senior/head roles see all.
		if u := core.UserFromCtx(r.Context()); u != nil && !u.CanSeeAllRows() {
			where += fmt.Sprintf(" AND (t.assigned_to=$%d OR (t.assigned_to IS NULL AND t.status NOT IN ('resolved','closed')))", n)
			args = append(args, u.ID)
			n++
		}

		if v := normalizeHelpdeskFilter(qstr(r, "status")); v != "" {
			where += fmt.Sprintf(" AND t.status=$%d", n)
			args = append(args, v)
			n++
		}
		if v := normalizeHelpdeskFilter(qstr(r, "priority")); v != "" {
			where += fmt.Sprintf(" AND t.priority=$%d", n)
			args = append(args, v)
			n++
		}
		if v := normalizeHelpdeskFilter(qstr(r, "channel")); v != "" {
			where += fmt.Sprintf(" AND t.channel=$%d", n)
			args = append(args, v)
			n++
		}
		// Support queue excludes email (Care) and call (call activity, not tickets).
		where += channelExcludeClause(qstr(r, "exclude_channel"), "t")
		if v := normalizeHelpdeskFilter(qstr(r, "department")); v != "" {
			where += fmt.Sprintf(" AND t.department=$%d", n)
			args = append(args, v)
			n++
		}
		if v := qstr(r, "customer_cif"); v != "" {
			where += fmt.Sprintf(" AND t.customer_cif=$%d", n)
			args = append(args, v)
			n++
		}
		if v := qstr(r, "assigned_to"); v != "" {
			switch v {
			case "unassigned":
				where += " AND t.assigned_to IS NULL"
			case "me":
				if u := core.UserFromCtx(r.Context()); u != nil {
					where += fmt.Sprintf(" AND t.assigned_to=$%d", n)
					args = append(args, u.ID)
					n++
				}
			default:
				where += fmt.Sprintf(" AND t.assigned_to=$%d", n)
				args = append(args, v)
				n++
			}
		}
		// Tokenised search: each whitespace-separated word must match at least one
		// field, so "Temitope Babatunde", "Babatunde Temitope" and "Temi Baba" all
		// hit the same customer — word order, extra spaces and partials don't matter.
		if v := coalesce(qstr(r, "search"), qstr(r, "q")); strings.TrimSpace(v) != "" {
			toks := strings.Fields(v)
			if len(toks) > 8 {
				toks = toks[:8]
			}
			for _, tok := range toks {
				where += fmt.Sprintf(` AND (t.subject ILIKE $%d OR t.customer_name ILIKE $%d OR t.customer_cif ILIKE $%d OR t.ticket_ref ILIKE $%d OR t.customer_phone ILIKE $%d OR t.customer_email ILIKE $%d)`, n, n, n, n, n, n)
				args = append(args, "%"+tok+"%")
				n++
			}
		}
		if v := qstr(r, "date_from"); v != "" {
			where += fmt.Sprintf(" AND t.created_at::date >= $%d", n)
			args = append(args, v)
			n++
		}
		if v := qstr(r, "date_to"); v != "" {
			where += fmt.Sprintf(" AND t.created_at::date <= $%d", n)
			args = append(args, v)
			n++
		}
		if tt := qstr(r, "ticket_type"); tt != "" {
			where += fmt.Sprintf(" AND t.ticket_type = $%d", n)
			args = append(args, tt)
			n++
		}
		// Health-strip buckets — static predicates (no user text reaches SQL) so the
		// clickable queue metrics filter the list to exactly what they count.
		switch normalizeHelpdeskFilter(qstr(r, "bucket")) {
		case "open":
			where += " AND t.status NOT IN ('resolved','closed')"
		case "unassigned":
			where += " AND t.assigned_to IS NULL AND t.status NOT IN ('resolved','closed')"
		case "awaiting_us", "awaiting": // we haven't replied yet (customer spoke last, or brand-new with no reply)
			where += " AND t.status NOT IN ('resolved','closed') AND COALESCE((SELECT m.direction FROM helpdesk_messages m WHERE m.ticket_id=t.id ORDER BY m.created_at DESC LIMIT 1),'inbound') <> 'outbound'"
		case "awaiting_customer": // we replied → waiting on the customer
			where += " AND t.status NOT IN ('resolved','closed') AND (SELECT m.direction FROM helpdesk_messages m WHERE m.ticket_id=t.id ORDER BY m.created_at DESC LIMIT 1) = 'outbound'"
		case "overdue":
			where += " AND t.sla_due_at IS NOT NULL AND t.sla_due_at < NOW() AND t.status NOT IN ('resolved','closed')"
		}

		filterArgs := append([]any(nil), args...)
		total := 0
		if tr, _ := db.PGQuery(r.Context(),
			fmt.Sprintf("SELECT COUNT(*) AS n FROM helpdesk_tickets t WHERE %s", where), filterArgs...); len(tr) > 0 {
			total = int(toInt64(tr[0]["n"]))
		}

		// Sort — fixed whitelist (no user text reaches SQL). Default: newest first.
		// "sla" surfaces the most-at-risk open tickets; "priority" ranks by severity;
		// "updated" floats the most recently active threads.
		orderBy := "t.created_at DESC"
		switch normalizeHelpdeskFilter(qstr(r, "sort")) {
		case "oldest":
			orderBy = "t.created_at ASC"
		case "waiting": // awaiting-our-reply first, longest-waiting at the top
			orderBy = "(COALESCE((SELECT m.direction FROM helpdesk_messages m WHERE m.ticket_id=t.id ORDER BY m.created_at DESC LIMIT 1),'inbound') = 'outbound') ASC, COALESCE(msg.last_message_at, t.created_at) ASC"
		case "sla":
			orderBy = "(t.status IN ('resolved','closed')), (t.sla_due_at IS NULL), t.sla_due_at ASC, t.created_at DESC"
		case "priority":
			orderBy = "CASE lower(t.priority) WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'normal' THEN 3 WHEN 'low' THEN 4 ELSE 5 END, t.created_at DESC"
		case "updated":
			orderBy = "msg.last_message_at DESC NULLS LAST, t.created_at DESC"
		}

		args = append(args, perPage, offset)
		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT
				t.id, t.ticket_ref, t.channel, t.status, t.priority, t.subject,
				t.customer_name, t.customer_cif, t.customer_email, t.assigned_to, t.department,
				t.sla_due_at, t.created_at, t.first_response_at,
				LEFT(t.description, 160) AS description_preview,
				u.full_name AS assigned_to_name,
				msg.message_count, msg.last_message_at, msg.last_message_preview, msg.last_message_direction,
				(t.sla_due_at IS NOT NULL AND t.sla_due_at < NOW() AND t.status NOT IN ('resolved','closed')) AS sla_breached
			FROM helpdesk_tickets t
			LEFT JOIN o3c_users u ON t.assigned_to=u.id
			LEFT JOIN LATERAL (
				SELECT COUNT(*) AS message_count,
				       MAX(created_at) AS last_message_at,
				       (SELECT LEFT(body_text,120) FROM helpdesk_messages WHERE ticket_id=t.id ORDER BY created_at DESC LIMIT 1) AS last_message_preview,
				       (SELECT direction    FROM helpdesk_messages WHERE ticket_id=t.id ORDER BY created_at DESC LIMIT 1) AS last_message_direction
				FROM helpdesk_messages WHERE ticket_id=t.id
			) msg ON true
			WHERE %s
			ORDER BY %s
			LIMIT $%d OFFSET $%d`, where, orderBy, n, n+1), args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"total":    total,
			"page":     page,
			"per_page": perPage,
			"pages":    int((total + perPage - 1) / perPage),
			"data":     rows,
			"tickets":  rows,
		})
	}
}

func normalizeHelpdeskFilter(v string) string {
	return strings.ToLower(strings.ReplaceAll(strings.TrimSpace(v), "-", "_"))
}

// hdQueueSummary powers the Ticket Queue health strip: a single scan returning
// the counts a queue actually triages on (open, unassigned, mine, SLA-at-risk,
// awaiting first reply). It honours the same row-level scope and exclude_channel
// filter as hdListTickets so the numbers always match the list below them.
func hdQueueSummary(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		where := "1=1"
		var args []any
		n := 1

		// Same leaf-agent scoping as the list: own tickets + claimable pool.
		if u := core.UserFromCtx(r.Context()); u != nil && !u.CanSeeAllRows() {
			where += fmt.Sprintf(" AND (t.assigned_to=$%d OR (t.assigned_to IS NULL AND t.status NOT IN ('resolved','closed')))", n)
			args = append(args, u.ID)
			n++
		}
		where += channelExcludeClause(qstr(r, "exclude_channel"), "t")
		if v := normalizeHelpdeskFilter(qstr(r, "channel")); v != "" {
			where += fmt.Sprintf(" AND t.channel=$%d", n)
			args = append(args, v)
			n++
		}

		// $me for the "mine" count — 0 when unauthenticated (route is protected, so
		// this is just defensive).
		var meID int64
		if u := core.UserFromCtx(r.Context()); u != nil {
			meID = u.ID
		}
		args = append(args, meID)
		meArg := n

		// Triage on who spoke last (populated) instead of SLA (almost never set on
		// imported tickets). lm.last_dir = direction of each ticket's newest message.
		open := "t.status NOT IN ('resolved','closed')"
		q := fmt.Sprintf(`
			SELECT
				COUNT(*) FILTER (WHERE %[1]s) AS open,
				COUNT(*) FILTER (WHERE t.assigned_to IS NULL AND %[1]s) AS unassigned,
				COUNT(*) FILTER (WHERE t.assigned_to=$%[2]d AND %[1]s) AS mine,
				COUNT(*) FILTER (WHERE COALESCE(lm.last_dir,'inbound') <> 'outbound' AND %[1]s) AS awaiting_us,
				COUNT(*) FILTER (WHERE lm.last_dir = 'outbound' AND %[1]s) AS awaiting_customer,
				COUNT(*) FILTER (WHERE t.sla_due_at IS NOT NULL AND t.sla_due_at < NOW() AND %[1]s) AS overdue
			FROM helpdesk_tickets t
			LEFT JOIN LATERAL (
				SELECT m.direction AS last_dir FROM helpdesk_messages m
				WHERE m.ticket_id=t.id ORDER BY m.created_at DESC LIMIT 1
			) lm ON true
			WHERE %[3]s`, open, meArg, where)

		rows, err := db.PGQuery(r.Context(), q, args...)
		if err != nil || len(rows) == 0 {
			respondErr(w, 500, "Query failed")
			return
		}
		row := rows[0]
		respond(w, map[string]any{
			"open":              toInt64(row["open"]),
			"unassigned":        toInt64(row["unassigned"]),
			"mine":              toInt64(row["mine"]),
			"awaiting_us":       toInt64(row["awaiting_us"]),
			"awaiting_customer": toInt64(row["awaiting_customer"]),
			"overdue":           toInt64(row["overdue"]),
		}, "helpdesk")
	}
}

// channelExcludeClause builds a safe "exclude these channels" predicate from a
// comma-separated list (e.g. "email,call"). Each value is strictly validated to
// [a-z_] and then inlined — no free user text reaches SQL. alias is the table
// alias ("" for a bare table, or e.g. "t"). Returns "" when nothing valid.
func channelExcludeClause(raw, alias string) string {
	if raw == "" {
		return ""
	}
	var vals []string
	for _, part := range strings.Split(raw, ",") {
		ec := normalizeHelpdeskFilter(part)
		if ec == "" {
			continue
		}
		ok := true
		for _, c := range ec {
			if !((c >= 'a' && c <= 'z') || c == '_') {
				ok = false
				break
			}
		}
		if ok {
			vals = append(vals, "'"+ec+"'")
		}
	}
	if len(vals) == 0 {
		return ""
	}
	col := "channel"
	if alias != "" {
		col = alias + ".channel"
	}
	return " AND (" + col + " IS NULL OR " + col + " NOT IN (" + strings.Join(vals, ",") + "))"
}

// sqlInLower builds a safe "lower(col) IN (...)" predicate from a comma-separated
// list (e.g. "Inbound,Outbound" or "completed,missed"). Each value is lowercased
// and strictly validated to [a-z_] before inlining — no free user text reaches
// SQL. Returns "" when the list is empty or all-invalid (i.e. no filter).
func sqlInLower(col, raw string) string {
	if raw == "" {
		return ""
	}
	var vals []string
	for _, part := range strings.Split(raw, ",") {
		v := strings.ToLower(strings.TrimSpace(part))
		if v == "" {
			continue
		}
		ok := true
		for _, c := range v {
			if !((c >= 'a' && c <= 'z') || c == '_') {
				ok = false
				break
			}
		}
		if ok {
			vals = append(vals, "'"+v+"'")
		}
	}
	if len(vals) == 0 {
		return ""
	}
	return fmt.Sprintf(" AND lower(%s) IN (%s)", col, strings.Join(vals, ","))
}

// ── Bulk ticket actions ───────────────────────────────────────────────────────

func hdBulkAssignTickets(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		caller := core.UserFromCtx(r.Context())
		if caller == nil {
			respondErr(w, 403, "insufficient role")
			return
		}
		// Heads/admin can (re)assign any ticket; a regular agent may only act on
		// tickets currently assigned to them (matches the detail-panel transfer).
		priv := caller.Role == "call_center_head" || caller.Role == "admin"
		var b struct {
			TicketIDs []int64 `json:"ticket_ids"`
			AgentID   *int64  `json:"agent_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if len(b.TicketIDs) == 0 {
			respondErr(w, 422, "ticket_ids required")
			return
		}
		if b.AgentID != nil {
			rows, _ := db.PGQuery(r.Context(), `SELECT id FROM o3c_users WHERE id=$1 AND is_active=TRUE AND deleted_at IS NULL`, *b.AgentID)
			if len(rows) == 0 {
				respondErr(w, 422, "agent not found or inactive")
				return
			}
		}
		placeholders := make([]string, len(b.TicketIDs))
		args := []any{b.AgentID}
		for i, id := range b.TicketIDs {
			placeholders[i] = fmt.Sprintf("$%d", i+2)
			args = append(args, id)
		}
		where := fmt.Sprintf("id IN (%s)", strings.Join(placeholders, ","))
		if !priv {
			args = append(args, caller.ID)
			where += fmt.Sprintf(" AND assigned_to = $%d", len(args))
		}
		urows, err := db.PGQuery(r.Context(),
			"UPDATE helpdesk_tickets SET assigned_to=$1, updated_at=NOW() WHERE "+where+" RETURNING id", args...)
		if err != nil {
			respondErr(w, 500, "Update failed")
			return
		}
		var updatedIDs []int64
		for _, row := range urows {
			updatedIDs = append(updatedIDs, toInt64(row["id"]))
		}
		newVal := "unassigned"
		if b.AgentID != nil {
			newVal = fmt.Sprintf("%d", *b.AgentID)
		}
		hdBulkRecordEvent(r.Context(), db, updatedIDs, caller.ID, "assigned", "", newVal)
		// Notify the agent the tickets were assigned to (both channels).
		if b.AgentID != nil && *b.AgentID > 0 {
			n := len(updatedIDs)
			word := "ticket has"
			if n != 1 {
				word = "tickets have"
			}
			go Notify(context.Background(), db, NotifPayload{
				EventType: "ticket_assigned",
				UserID:    *b.AgentID,
				Title:     "Tickets assigned to you",
				Body:      fmt.Sprintf("%d %s been assigned to you.", n, word),
				ActionURL: "/helpdesk/tickets",
			})
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"updated": len(updatedIDs)}) //nolint:errcheck
	}
}

// ── Load-balanced auto-assignment ──────────────────────────────────────────────
//
// Tickets pile up unowned because nothing routes them: the routing-rules table has
// a CRUD UI but is never evaluated, so every ticket lands unassigned until a human
// claims it — which is why the open backlog is ~96% unowned. These helpers give
// every open ticket an owner: new tickets are auto-assigned to the least-loaded
// active agent at intake, and a supervisor can distribute the existing unowned
// backlog on demand. "Least loaded" = fewest currently-open (not resolved/closed)
// tickets, so load self-corrects as agents go on leave or clear their queue.

// hdAgentLoad is one eligible agent and their current open-ticket count.
type hdAgentLoad struct {
	id   int64
	open int
}

// hdEligibleAgents returns active call-center staff with their current open load,
// least-loaded first. Empty when nobody is eligible.
func hdEligibleAgents(ctx context.Context, db *core.DB) []hdAgentLoad {
	rows, err := db.PGQuery(ctx, `
		SELECT u.id, COUNT(t.id) AS open_cnt
		FROM o3c_users u
		LEFT JOIN helpdesk_tickets t
		  ON t.assigned_to = u.id AND t.status NOT IN ('resolved','closed')
		WHERE u.deleted_at IS NULL AND u.is_active = TRUE
		  AND u.role ILIKE '%call_center%'
		GROUP BY u.id
		ORDER BY open_cnt ASC, u.id ASC`)
	if err != nil {
		return nil
	}
	out := make([]hdAgentLoad, 0, len(rows))
	for _, r := range rows {
		out = append(out, hdAgentLoad{id: toInt64(r["id"]), open: int(toInt64(r["open_cnt"]))})
	}
	return out
}

// hdPickLeastLoadedAgent returns the id of the active agent with the fewest open
// tickets, or nil when no agent is eligible.
func hdPickLeastLoadedAgent(ctx context.Context, db *core.DB) *int64 {
	agents := hdEligibleAgents(ctx, db)
	if len(agents) == 0 {
		return nil
	}
	id := agents[0].id
	return &id
}

// hdAutoAssignTicket assigns one open, unowned ticket to the least-loaded agent.
// Best-effort: records an event and notifies. Returns the agent id, or nil if there
// was no eligible agent or the ticket was already taken/closed.
func hdAutoAssignTicket(ctx context.Context, db *core.DB, ticketID, actorID int64) *int64 {
	agent := hdPickLeastLoadedAgent(ctx, db)
	if agent == nil {
		return nil
	}
	res, err := db.PGExec(ctx, `
		UPDATE helpdesk_tickets SET assigned_to=$1, assigned_at=NOW(), updated_at=NOW()
		WHERE id=$2 AND assigned_to IS NULL AND status NOT IN ('resolved','closed')`,
		*agent, ticketID)
	if err != nil {
		return nil
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil // someone claimed it first, or it closed — no-op
	}
	hdRecordEvent(ctx, db, ticketID, actorID, "assigned", "", "auto:load_balanced")
	go Notify(context.Background(), db, NotifPayload{
		EventType: "ticket_assigned",
		UserID:    *agent,
		Title:     "Ticket assigned to you",
		Body:      "A ticket has been auto-assigned to you.",
		ActionURL: "/helpdesk/tickets",
	})
	return agent
}

// hdDistributeUnassigned load-balances up to `limit` unowned open tickets (oldest
// first) across active agents, least-loaded first. Returns the number actually
// assigned and per-agent counts. Records an audit event per batch.
func hdDistributeUnassigned(ctx context.Context, db *core.DB, limit int, actorID int64) (int, map[int64]int) {
	perAgent := map[int64]int{}
	agents := hdEligibleAgents(ctx, db)
	if len(agents) == 0 || limit <= 0 {
		return 0, perAgent
	}
	rows, err := db.PGQuery(ctx, `
		SELECT id FROM helpdesk_tickets
		WHERE assigned_to IS NULL AND status NOT IN ('resolved','closed')
		ORDER BY created_at ASC
		LIMIT $1`, limit)
	if err != nil || len(rows) == 0 {
		return 0, perAgent
	}
	// Greedy least-loaded assignment in memory (pool is tiny, so a linear min-scan
	// is fine); the DB UPDATE re-checks the guards so a concurrent claim can't double.
	assign := map[int64][]int64{}
	for _, r := range rows {
		tid := toInt64(r["id"])
		mi := 0
		for i := 1; i < len(agents); i++ {
			if agents[i].open < agents[mi].open {
				mi = i
			}
		}
		agents[mi].open++
		assign[agents[mi].id] = append(assign[agents[mi].id], tid)
	}
	total := 0
	for agentID, ids := range assign {
		res, err := db.PGExec(ctx, `
			UPDATE helpdesk_tickets SET assigned_to=$1, assigned_at=NOW(), updated_at=NOW()
			WHERE id = ANY($2) AND assigned_to IS NULL AND status NOT IN ('resolved','closed')`,
			agentID, ids)
		if err != nil {
			continue
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			continue
		}
		perAgent[agentID] = int(n)
		total += int(n)
		// Audit trail (batch) — bulk assignment previously left no history at all.
		db.PGExec(ctx, //nolint:errcheck
			`INSERT INTO helpdesk_events (ticket_id, user_id, event_type, old_value, new_value)
			 SELECT unnest($1::bigint[]), NULLIF($2,0)::bigint, 'assigned', NULL, 'distribute:load_balanced'`,
			ids, actorID)
		aid, cnt := agentID, int(n)
		go Notify(context.Background(), db, NotifPayload{
			EventType: "ticket_assigned",
			UserID:    aid,
			Title:     "Tickets assigned to you",
			Body:      fmt.Sprintf("%d tickets have been assigned to you.", cnt),
			ActionURL: "/helpdesk/tickets",
		})
	}
	return total, perAgent
}

// hdDistributeTickets — POST /tickets/distribute (head/admin): spread the unowned
// open backlog across active agents, least-loaded first.
func hdDistributeTickets(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		caller := core.UserFromCtx(r.Context())
		if caller == nil || (caller.Role != "call_center_head" && caller.Role != "admin") {
			respondErr(w, 403, "insufficient role")
			return
		}
		var b struct {
			Limit int `json:"limit"`
		}
		_ = json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck
		if b.Limit <= 0 || b.Limit > 100000 {
			b.Limit = 100000
		}
		if len(hdEligibleAgents(r.Context(), db)) == 0 {
			respondErr(w, 422, "no active call-center agents to assign to")
			return
		}
		total, perAgent := hdDistributeUnassigned(r.Context(), db, b.Limit, caller.ID)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"assigned": total, "per_agent": perAgent}) //nolint:errcheck
	}
}

func hdBulkCloseTickets(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		caller := core.UserFromCtx(r.Context())
		if caller == nil {
			respondErr(w, 403, "insufficient role")
			return
		}
		// Agents may close their own tickets; heads/admin may close any.
		priv := caller.Role == "call_center_head" || caller.Role == "admin"
		var b struct {
			TicketIDs []int64 `json:"ticket_ids"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if len(b.TicketIDs) == 0 {
			respondErr(w, 422, "ticket_ids required")
			return
		}
		placeholders := make([]string, len(b.TicketIDs))
		args := []any{}
		for i, id := range b.TicketIDs {
			placeholders[i] = fmt.Sprintf("$%d", i+1)
			args = append(args, id)
		}
		where := fmt.Sprintf("id IN (%s)", strings.Join(placeholders, ","))
		if !priv {
			args = append(args, caller.ID)
			where += fmt.Sprintf(" AND assigned_to = $%d", len(args))
		}
		urows, err := db.PGQuery(r.Context(),
			"UPDATE helpdesk_tickets SET status='closed', closed_at=NOW(), updated_at=NOW() WHERE "+where+" RETURNING id", args...)
		if err != nil {
			respondErr(w, 500, "Update failed")
			return
		}
		var updatedIDs []int64
		for _, row := range urows {
			updatedIDs = append(updatedIDs, toInt64(row["id"]))
		}
		hdBulkRecordEvent(r.Context(), db, updatedIDs, caller.ID, "status_changed", "", "closed")
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"updated": len(updatedIDs)}) //nolint:errcheck
	}
}

func hdBulkPriorityTickets(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		caller := core.UserFromCtx(r.Context())
		if caller == nil {
			respondErr(w, 403, "insufficient role")
			return
		}
		priv := caller.Role == "call_center_head" || caller.Role == "admin"
		var b struct {
			TicketIDs []int64 `json:"ticket_ids"`
			Priority  string  `json:"priority"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if len(b.TicketIDs) == 0 || b.Priority == "" {
			respondErr(w, 422, "ticket_ids and priority required")
			return
		}
		placeholders := make([]string, len(b.TicketIDs))
		args := []any{b.Priority}
		for i, id := range b.TicketIDs {
			placeholders[i] = fmt.Sprintf("$%d", i+2)
			args = append(args, id)
		}
		where := fmt.Sprintf("id IN (%s)", strings.Join(placeholders, ","))
		if !priv {
			args = append(args, caller.ID)
			where += fmt.Sprintf(" AND assigned_to = $%d", len(args))
		}
		urows, err := db.PGQuery(r.Context(),
			"UPDATE helpdesk_tickets SET priority=$1, updated_at=NOW() WHERE "+where+" RETURNING id", args...)
		if err != nil {
			respondErr(w, 500, "Update failed")
			return
		}
		var updatedIDs []int64
		for _, row := range urows {
			updatedIDs = append(updatedIDs, toInt64(row["id"]))
		}
		hdBulkRecordEvent(r.Context(), db, updatedIDs, caller.ID, "priority_changed", "", b.Priority)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"updated": len(updatedIDs)}) //nolint:errcheck
	}
}

func hdClaimTicket(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		ticketID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid ticket ID")
			return
		}
		if _, err := db.PGExec(ctx,
			`UPDATE helpdesk_tickets SET assigned_to=$1, assigned_at=NOW(), updated_at=NOW() WHERE id=$2`,
			user.ID, ticketID); err != nil {
			respondErr(w, 500, "Claim failed")
			return
		}
		hdRecordEvent(ctx, db, ticketID, user.ID, "assigned", "", fmt.Sprintf("%d", user.ID))
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"claimed": true, "assigned_to": user.ID}) //nolint:errcheck
	}
}

func hdGetTicket(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")

		tRows, err := db.PGQuery(r.Context(), `
			SELECT t.*, u.full_name AS assigned_to_name
			FROM helpdesk_tickets t
			LEFT JOIN o3c_users u ON t.assigned_to=u.id
			WHERE t.id=$1`, id)
		if err != nil || len(tRows) == 0 {
			respondErr(w, 404, "Ticket not found")
			return
		}
		ticket := tRows[0]

		// Row-level scope: a leaf agent may open only their own tickets or
		// unassigned ones (which they can claim), not another agent's.
		if u := core.UserFromCtx(r.Context()); u != nil && !u.CanSeeAllRows() {
			if at := toInt64(ticket["assigned_to"]); at != 0 && at != u.ID {
				respondErr(w, 403, "This ticket is assigned to another agent")
				return
			}
		}

		msgs, _ := db.PGQuery(r.Context(), `
			SELECT m.*, u.full_name AS author_user_name
			FROM helpdesk_messages m
			LEFT JOIN o3c_users u ON m.author_user_id=u.id
			WHERE m.ticket_id=$1
			ORDER BY m.created_at ASC`, id)

		events, _ := db.PGQuery(r.Context(), `
			SELECT e.*, u.full_name AS user_name
			FROM helpdesk_events e
			LEFT JOIN o3c_users u ON e.user_id=u.id
			WHERE e.ticket_id=$1
			ORDER BY e.ts ASC`, id)

		if msgs == nil {
			msgs = []core.Row{}
		}

		// Lazy conversation fill: the Zoho sync imports the ticket but NOT its threads,
		// so a freshly synced email ticket has no message rows yet — its body lives only
		// in the Zoho conversation. When an agent opens such a mail, fetch it now so the
		// pane isn't blank. Also refetch when the existing messages are summary-only
		// (no body_html) so an older truncated import is upgraded to the full body on
		// view. Bounded by a short timeout so a slow/absent Zoho can't hang the open,
		// and skipped for call tickets (no email thread to fetch).
		needFull := len(msgs) == 0
		if !needFull {
			hasFullBody := false
			for _, m := range msgs {
				if str(m["body_html"]) != "" {
					hasFullBody = true
					break
				}
			}
			needFull = !hasFullBody
		}
		if needFull {
			ref := str(ticket["ticket_ref"])
			if str(ticket["source_system"]) == "zoho_desk" && strings.HasPrefix(ref, "ZOHO-") &&
				str(ticket["channel"]) != "call" && zohoEnsureConfigured(r.Context(), db) {
				cctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
				if n, _ := zohoImportTicketConversations(cctx, db, toInt64(ticket["id"]), strings.TrimPrefix(ref, "ZOHO-"), str(ticket["channel"])); n > 0 {
					if refetched, _ := db.PGQuery(r.Context(), `
						SELECT m.*, u.full_name AS author_user_name
						FROM helpdesk_messages m
						LEFT JOIN o3c_users u ON m.author_user_id=u.id
						WHERE m.ticket_id=$1
						ORDER BY m.created_at ASC`, id); refetched != nil {
						msgs = refetched
					}
				}
				cancel()
			}
		}

		if events == nil {
			events = []core.Row{}
		}

		// Build customer context from CIF
		cif := str(ticket["customer_cif"])
		customerCtx := hdCustomerContext(r.Context(), db, cif)

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"ticket":           ticket,
			"messages":         msgs,
			"events":           events,
			"customer_context": customerCtx,
		})
	}
}

func hdUpdateTicket(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")

		tRows, _ := db.PGQuery(r.Context(), `SELECT * FROM helpdesk_tickets WHERE id=$1`, id)
		if len(tRows) == 0 {
			respondErr(w, 404, "Ticket not found")
			return
		}
		ticket := tRows[0]
		ticketID := toInt64(ticket["id"])

		var b map[string]any
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}

		user := core.UserFromCtx(r.Context())
		ctx := r.Context()
		// Single guarded caller id — auth makes user non-nil in practice, but the
		// status/priority/assignment branches used to deref user.ID unguarded while
		// the queue branch guarded it (P9). Normalise to one value.
		callerID := int64(0)
		if user != nil {
			callerID = user.ID
		}

		var setParts []string
		var args []any
		n := 1

		allowed := []string{"subject", "department", "tags", "ticket_type"}
		for _, col := range allowed {
			if v, ok := b[col]; ok {
				setParts = append(setParts, fmt.Sprintf("%s=$%d", col, n))
				args = append(args, v)
				n++
			}
		}

		// Queue change
		if newQueue, ok := b["queue"].(string); ok && newQueue != str(ticket["queue"]) {
			oldQueue := str(ticket["queue"])
			setParts = append(setParts, fmt.Sprintf("queue=$%d", n))
			args = append(args, newQueue)
			n++
			hdRecordEvent(ctx, db, ticketID, callerID, "queue_changed", oldQueue, newQueue)
		}

		// Status change
		if newStatus, ok := b["status"].(string); ok && newStatus != str(ticket["status"]) {
			if !hdValidStatus(newStatus) {
				respondErr(w, 422, "invalid status: "+newStatus)
				return
			}
			oldStatus := str(ticket["status"])
			setParts = append(setParts, fmt.Sprintf("status=$%d", n))
			args = append(args, newStatus)
			n++
			switch newStatus {
			case "resolved":
				setParts = append(setParts, "resolved_at=NOW()")
				// Send CSAT
				go hdSendCSATEmail(context.Background(), db, ticket)
			case "closed":
				setParts = append(setParts, "closed_at=NOW()")
			case "open", "in_progress", "pending", "escalated":
				// Reopening a resolved/closed ticket must clear the terminal
				// timestamps, or it stays counted as resolved/closed in every report
				// even though it's active again (P5).
				if oldStatus == "resolved" || oldStatus == "closed" {
					setParts = append(setParts, "resolved_at=NULL", "closed_at=NULL")
				}
			}
			// Escalation is a first-class state now (P4) — alert the supervisors so it
			// doesn't just sit in the queue unseen.
			if newStatus == "escalated" {
				go NotifyRole(context.Background(), db, "call_center_head", NotifPayload{
					EventType: "ticket_escalated",
					Title:     fmt.Sprintf("Ticket escalated: %s", str(ticket["ticket_ref"])),
					Body:      fmt.Sprintf("Ticket %s (%s) has been escalated and needs review.", str(ticket["ticket_ref"]), str(ticket["subject"])),
					ActionURL: fmt.Sprintf("/helpdesk/%d", ticketID),
					EntityRef: fmt.Sprintf("ticket:%d", ticketID),
				})
			}
			hdRecordEvent(ctx, db, ticketID, callerID, "status_changed", oldStatus, newStatus)
		}

		// Priority change
		if newPri, ok := b["priority"].(string); ok && newPri != str(ticket["priority"]) {
			oldPri := str(ticket["priority"])
			setParts = append(setParts, fmt.Sprintf("priority=$%d", n))
			args = append(args, newPri)
			n++
			// Recompute both SLA deadlines for the new priority.
			newSLA := hdComputeSLADue(ctx, db, newPri)
			if newSLA != nil {
				setParts = append(setParts, fmt.Sprintf("sla_due_at=$%d", n))
				args = append(args, newSLA)
				n++
			}
			newFRT := hdComputeFirstResponseDue(ctx, db, newPri)
			if newFRT != nil {
				setParts = append(setParts, fmt.Sprintf("first_response_due=$%d", n))
				args = append(args, newFRT)
				n++
			}
			// Moving the deadline invalidates any stored breach/warning flag — clear
			// them so the monitor re-evaluates against the new deadline (P8: otherwise
			// the list view and the persisted flag / CBN count diverge).
			setParts = append(setParts, "sla_breached=FALSE", "sla_warning_sent=FALSE")
			hdRecordEvent(ctx, db, ticketID, callerID, "priority_changed", oldPri, newPri)
		}

		// Assignment change
		if newAssign, ok := b["assigned_to"]; ok {
			oldAssign := fmt.Sprintf("%v", ticket["assigned_to"])
			var newAssignID int64
			switch v := newAssign.(type) {
			case float64:
				newAssignID = int64(v)
			case int64:
				newAssignID = v
			}
			if newAssignID > 0 {
				setParts = append(setParts, fmt.Sprintf("assigned_to=$%d, assigned_at=NOW()", n))
				args = append(args, newAssignID)
				n++
				// Get assignee name for event
				nameRows, _ := db.PGQuery(ctx, "SELECT full_name FROM o3c_users WHERE id=$1", newAssignID)
				newAssignName := ""
				if len(nameRows) > 0 {
					newAssignName = str(nameRows[0]["full_name"])
				}
				hdRecordEvent(ctx, db, ticketID, callerID, "assigned", oldAssign, newAssignName)
				// Notify new assignee via all enabled channels
				if newAssignID != callerID {
					go Notify(context.Background(), db, NotifPayload{
						EventType: EvtTicketAssigned,
						UserID:    newAssignID,
						Title:     fmt.Sprintf("Ticket assigned: %s", str(ticket["ticket_ref"])),
						Body:      fmt.Sprintf("You've been assigned ticket %s: %s", str(ticket["ticket_ref"]), str(ticket["subject"])),
						ActionURL: fmt.Sprintf("/helpdesk/%d", ticketID),
						EntityRef: fmt.Sprintf("ticket:%d", ticketID),
					})
				}
			} else {
				setParts = append(setParts, fmt.Sprintf("assigned_to=$%d, assigned_at=NULL", n))
				args = append(args, nil)
				n++
				hdRecordEvent(ctx, db, ticketID, callerID, "unassigned", oldAssign, "")
			}
		}

		if len(setParts) == 0 {
			respondErr(w, 422, "No fields to update")
			return
		}
		setParts = append(setParts, "updated_at=NOW()")
		args = append(args, id)
		_, err := db.PGExec(ctx, fmt.Sprintf("UPDATE helpdesk_tickets SET %s WHERE id=$%d",
			strings.Join(setParts, ","), n), args...)
		if err != nil {
			slog.Error("hdUpdateTicket", "err", err)
			respondErr(w, 500, "Update failed")
			return
		}

		updated, _ := db.PGQuery(ctx, `
			SELECT t.*, u.full_name AS assigned_to_name
			FROM helpdesk_tickets t LEFT JOIN o3c_users u ON t.assigned_to=u.id
			WHERE t.id=$1`, id)
		if len(updated) == 0 {
			respondErr(w, 404, "Not found")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(updated[0]) //nolint:errcheck
	}
}

func hdSendMessage(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")

		tRows, _ := db.PGQuery(r.Context(), `SELECT * FROM helpdesk_tickets WHERE id=$1`, id)
		if len(tRows) == 0 {
			respondErr(w, 404, "Ticket not found")
			return
		}
		ticket := tRows[0]
		ticketID := toInt64(ticket["id"])

		var b struct {
			BodyText       string           `json:"body_text"`
			BodyHTML       *string          `json:"body_html"`
			IsInternalNote bool             `json:"is_internal_note"`
			Channel        *string          `json:"channel"`
			Attachments    []MailAttachment `json:"attachments"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if strings.TrimSpace(b.BodyText) == "" {
			respondErr(w, 422, "body_text is required")
			return
		}
		if err := validateMailAttachments(b.Attachments); err != nil {
			respondErr(w, 422, err.Error())
			return
		}

		user := core.UserFromCtx(r.Context())
		ctx := r.Context()

		channel := str(ticket["channel"])
		if b.Channel != nil && *b.Channel != "" {
			channel = *b.Channel
		}

		attachJSON := "[]"
		if len(b.Attachments) > 0 {
			if raw, err := json.Marshal(b.Attachments); err == nil {
				attachJSON = string(raw)
			}
		}

		// Generate email Message-ID
		msgUUID := hdNewUUID()
		emailMsgID := fmt.Sprintf("<msg-%s@o3ccards.com>", msgUUID)

		// Get last message email_message_id for In-Reply-To
		lastMsgRows, _ := db.PGQuery(ctx, `
			SELECT email_message_id FROM helpdesk_messages
			WHERE ticket_id=$1 AND email_message_id IS NOT NULL
			ORDER BY created_at DESC LIMIT 1`, ticketID)
		inReplyTo := ""
		if len(lastMsgRows) > 0 {
			inReplyTo = str(lastMsgRows[0]["email_message_id"])
		}

		msgRows, err := db.PGQuery(ctx, `
			INSERT INTO helpdesk_messages
			    (ticket_id, direction, channel, author_user_id, author_name,
			     body_text, body_html, attachments, email_message_id, in_reply_to, is_internal_note)
			VALUES ($1,'outbound',$2,$3,$4,$5,$6,$7::jsonb,$8,NULLIF($9,''),$10)
			RETURNING *`,
			ticketID, channel, user.ID, user.FullName,
			b.BodyText, ptrOrNil(b.BodyHTML), attachJSON,
			emailMsgID, inReplyTo, b.IsInternalNote)
		if err != nil {
			slog.Error("hdSendMessage: insert", "err", err)
			respondErr(w, 500, "Could not insert message")
			return
		}
		msg := msgRows[0]

		// Set first_response_at if this is the first outbound reply
		if ticket["first_response_at"] == nil {
			db.PGExec(ctx, //nolint:errcheck
				"UPDATE helpdesk_tickets SET first_response_at=NOW(), updated_at=NOW() WHERE id=$1 AND first_response_at IS NULL",
				ticketID)
		} else {
			db.PGExec(ctx, "UPDATE helpdesk_tickets SET updated_at=NOW() WHERE id=$1", ticketID) //nolint:errcheck
		}

		// Send externally unless internal note
		if !b.IsInternalNote {
			customerEmail := str(ticket["customer_email"])
			customerPhone := str(ticket["customer_phone"])
			ticketChannel := str(ticket["channel"])

			if ticketChannel == "email" && customerEmail != "" {
				agentName := user.FullName
				go hdSendTicketEmail(context.Background(), db, ticket, b.BodyText, ptrStr(b.BodyHTML), emailMsgID, inReplyTo, agentName, b.Attachments)
			}
			if ticketChannel == "sms" && customerPhone != "" {
				go sendSMS(context.Background(), db, customerPhone, b.BodyText)
			}
			// New: deliver reply to customer via WhatsApp when channel is whatsapp
			if ticketChannel == "whatsapp" && customerPhone != "" {
				go sendWhatsApp(context.Background(), db, customerPhone, b.BodyText)
			}
		}
		// Notify the assigned agent when a new message arrives (if sender is not the assignee)
		if assignedID := toInt64(ticket["assigned_to"]); assignedID != 0 && assignedID != user.ID {
			ref := str(ticket["ticket_ref"])
			go Notify(context.Background(), db, NotifPayload{
				EventType: EvtTicketReplied,
				UserID:    assignedID,
				Title:     fmt.Sprintf("New message on ticket %s", ref),
				Body:      truncateStr(b.BodyText, 120),
				ActionURL: fmt.Sprintf("/helpdesk/%d", ticketID),
				EntityRef: fmt.Sprintf("ticket:%d", ticketID),
			})
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(msg) //nolint:errcheck
	}
}

func hdSearchTickets(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := strings.TrimSpace(qstr(r, "q"))
		if q == "" {
			respondErr(w, 422, "q is required")
			return
		}
		page := qint(r, "page", 1, 1, 10000)
		perPage := qint(r, "per_page", 25, 1, 200)
		if l := qint(r, "limit", 0, 0, 200); l > 0 { // accept ?limit= as an alias
			perPage = l
		}
		offset := (page - 1) * perPage

		// Tokenised substring match (partial words, CIF/ref fragments, normalized phone,
		// email) — the same matcher the ticket LIST uses, so /tickets/search and
		// /tickets behave identically. FTS (plainto_tsquery) could only match whole
		// word-stems, so "Temi" missed "Temitope" and identifiers/phones tokenised badly.
		tMatch, tArgs, tn := buildCustomerSearch(q,
			[]string{"t.subject", "t.customer_name", "t.customer_cif", "t.ticket_ref", "t.customer_email"},
			"t.customer_phone", 1)
		tArgs = append(tArgs, perPage, offset)
		ticketRows, _ := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT t.id, t.ticket_ref, t.subject, t.status, t.priority, t.channel,
			       t.customer_name, t.customer_cif, t.created_at, 'ticket' AS result_type
			FROM helpdesk_tickets t
			WHERE %s
			ORDER BY t.created_at DESC NULLS LAST
			LIMIT $%d OFFSET $%d`, tMatch, tn, tn+1), tArgs...)

		// Message body stays substring too (tokenised), so a partial phrase inside a
		// reply is found — useful for the merge-ticket lookup.
		mMatch, mArgs, mn := buildCustomerSearch(q, []string{"m.body_text"}, "", 1)
		mArgs = append(mArgs, perPage, offset)
		msgRows, _ := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT m.id, m.ticket_id, t.ticket_ref, LEFT(m.body_text,200) AS excerpt,
			       m.created_at, m.direction, 'message' AS result_type
			FROM helpdesk_messages m
			JOIN helpdesk_tickets t ON m.ticket_id=t.id
			WHERE %s
			ORDER BY m.created_at DESC NULLS LAST
			LIMIT $%d OFFSET $%d`, mMatch, mn, mn+1), mArgs...)

		if ticketRows == nil {
			ticketRows = []core.Row{}
		}
		if msgRows == nil {
			msgRows = []core.Row{}
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"tickets":  ticketRows,
			"messages": msgRows,
		})
	}
}

func hdMergeTicket(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		srcID := chi.URLParam(r, "id")
		var b struct {
			TargetTicketID int64 `json:"target_ticket_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.TargetTicketID == 0 {
			respondErr(w, 422, "target_ticket_id is required")
			return
		}
		srcIDInt, _ := strconv.ParseInt(srcID, 10, 64)
		if srcIDInt == b.TargetTicketID {
			respondErr(w, 422, "source and target ticket must differ")
			return
		}

		// Verify both tickets exist
		sRows, _ := db.PGQuery(r.Context(), "SELECT ticket_ref FROM helpdesk_tickets WHERE id=$1", srcID)
		tRows, _ := db.PGQuery(r.Context(), "SELECT ticket_ref FROM helpdesk_tickets WHERE id=$1", b.TargetTicketID)
		if len(sRows) == 0 || len(tRows) == 0 {
			respondErr(w, 404, "Source or target ticket not found")
			return
		}

		ctx := r.Context()
		user := core.UserFromCtx(r.Context())

		// Move messages
		db.PGExec(ctx, "UPDATE helpdesk_messages SET ticket_id=$1 WHERE ticket_id=$2", b.TargetTicketID, srcIDInt) //nolint:errcheck

		// Record event on both
		hdRecordEvent(ctx, db, srcIDInt, user.ID, "merged_into", str(sRows[0]["ticket_ref"]), str(tRows[0]["ticket_ref"]))
		hdRecordEvent(ctx, db, b.TargetTicketID, user.ID, "merged_from", str(sRows[0]["ticket_ref"]), str(tRows[0]["ticket_ref"]))

		// Close source
		db.PGExec(ctx, "UPDATE helpdesk_tickets SET status='closed', closed_at=NOW(), updated_at=NOW() WHERE id=$1", srcIDInt) //nolint:errcheck

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"merged":        true,
			"source_ticket": str(sRows[0]["ticket_ref"]),
			"target_ticket": str(tRows[0]["ticket_ref"]),
		})
	}
}

// ── Canned Responses ──────────────────────────────────────────────────────────

func ensureCannedSchema(ctx context.Context, db *core.DB) {
	db.PGExec(ctx, `ALTER TABLE helpdesk_canned_responses ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ`) //nolint:errcheck
}

// hdUseCanned bumps last_used_at so the most-used templates surface (called when
// an agent inserts a canned response into a reply).
func hdUseCanned(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ensureCannedSchema(r.Context(), db)
		id := chi.URLParam(r, "id")
		db.PGExec(r.Context(), `UPDATE helpdesk_canned_responses SET last_used_at=NOW() WHERE id=$1`, id) //nolint:errcheck
		w.WriteHeader(204)
	}
}

func hdListCanned(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ensureCannedSchema(r.Context(), db)
		where := "1=1"
		var args []any
		n := 1
		if v := qstr(r, "channel"); v != "" {
			where += fmt.Sprintf(" AND (channel=$%d OR channel='both')", n)
			args = append(args, v)
			n++
		}
		if v := qstr(r, "category"); v != "" {
			where += fmt.Sprintf(" AND category=$%d", n)
			args = append(args, v)
			n++
		}
		if v := r.URL.Query().Get("from"); v != "" {
			where += fmt.Sprintf(" AND c.created_at::date >= $%d::date", n)
			args = append(args, v)
			n++
		}
		if v := r.URL.Query().Get("to"); v != "" {
			where += fmt.Sprintf(" AND c.created_at::date <= $%d::date", n)
			args = append(args, v)
			n++
		}
		_ = n
		rows, err := db.PGQuery(r.Context(),
			fmt.Sprintf(`SELECT c.id, c.name AS title, c.category, c.body_text AS body,
			             c.last_used_at, c.created_at,
			             COALESCE(u.full_name, c.created_by::text, '') AS created_by
			             FROM helpdesk_canned_responses c
			             LEFT JOIN o3c_users u ON u.id = c.created_by
			             WHERE %s ORDER BY c.name ASC`, where), args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		jsonRows(w, rows)
	}
}

func hdCreateCanned(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			Name     string  `json:"name"`
			Channel  string  `json:"channel"`
			Subject  *string `json:"subject"`
			BodyText string  `json:"body_text"`
			BodyHTML *string `json:"body_html"`
			Category *string `json:"category"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if strings.TrimSpace(b.Name) == "" {
			respondErr(w, 422, "name is required")
			return
		}
		if strings.TrimSpace(b.BodyText) == "" {
			respondErr(w, 422, "body_text is required")
			return
		}
		if b.Channel == "" {
			b.Channel = "both"
		}
		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO helpdesk_canned_responses (name, channel, subject, body_text, body_html, category, created_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
			b.Name, b.Channel, ptrOrNil(b.Subject), b.BodyText, ptrOrNil(b.BodyHTML), ptrOrNil(b.Category), user.ID)
		if err != nil {
			respondErr(w, 500, "Create failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func hdUpdateCanned(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		allowed := []string{"name", "channel", "subject", "body_text", "body_html", "category"}
		parts, args := buildSet(body, allowed, 1)
		if len(parts) == 0 {
			respondErr(w, 422, "No fields to update")
			return
		}
		args = append(args, id)
		db.PGExec(r.Context(), fmt.Sprintf("UPDATE helpdesk_canned_responses SET %s WHERE id=$%d", //nolint:errcheck
			strings.Join(parts, ","), len(args)), args...)
		rows, _ := db.PGQuery(r.Context(), "SELECT * FROM helpdesk_canned_responses WHERE id=$1", id)
		if len(rows) == 0 {
			respondErr(w, 404, "Not found")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func hdDeleteCanned(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		rows, _ := db.PGQuery(r.Context(), "SELECT id FROM helpdesk_canned_responses WHERE id=$1", id)
		if len(rows) == 0 {
			respondErr(w, 404, "Not found")
			return
		}
		db.PGExec(r.Context(), "DELETE FROM helpdesk_canned_responses WHERE id=$1", id) //nolint:errcheck
		w.WriteHeader(204)
	}
}

// ── SLA Policies ─────────────────────────────────────────────────────────────

func hdListSLA(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), "SELECT * FROM helpdesk_sla_policies ORDER BY first_response_hours ASC")
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		jsonRows(w, rows)
	}
}

func hdUpdateSLA(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		allowed := []string{"name", "first_response_hours", "resolution_hours", "is_active"}
		parts, args := buildSet(body, allowed, 1)
		if len(parts) == 0 {
			respondErr(w, 422, "No fields to update")
			return
		}
		args = append(args, id)
		db.PGExec(r.Context(), fmt.Sprintf("UPDATE helpdesk_sla_policies SET %s WHERE id=$%d", //nolint:errcheck
			strings.Join(parts, ","), len(args)), args...)
		rows, _ := db.PGQuery(r.Context(), "SELECT * FROM helpdesk_sla_policies WHERE id=$1", id)
		if len(rows) == 0 {
			respondErr(w, 404, "Not found")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

// ── Stats ─────────────────────────────────────────────────────────────────────

func hdStats(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		// Optional date range — accepts date_from/date_to or from/to (callers differ).
		// Defaults to last 30 days for time-bounded metrics.
		dateFrom := qstr(r, "date_from")
		if dateFrom == "" {
			dateFrom = qstr(r, "from")
		}
		dateTo := qstr(r, "date_to")
		if dateTo == "" {
			dateTo = qstr(r, "to")
		}

		// Predicate for date-range filtering; falls back to last 30 days when unset
		var dateClause string
		var dateArgs []any
		if dateFrom != "" && dateTo != "" {
			dateClause = "AND created_at >= $1 AND created_at < $2::date + 1"
			dateArgs = []any{dateFrom, dateTo}
		} else {
			dateClause = "AND created_at >= NOW() - INTERVAL '30 days'"
			dateArgs = []any{}
		}

		// Optional channel exclusion — accepts a comma-separated list (e.g.
		// exclude_channel=email,call) so the Call Center view drops Care's mail and
		// the outbound-call "tickets" that are really call activity.
		chanClause := channelExcludeClause(qstr(r, "exclude_channel"), "")
		chanClauseT := channelExcludeClause(qstr(r, "exclude_channel"), "t")

		counts := map[string]int64{}
		if rows, _ := db.PGQuery(ctx, `
			SELECT status, COUNT(*) AS n
			FROM helpdesk_tickets
			WHERE status NOT IN ('closed')`+chanClause+`
			GROUP BY status`); rows != nil {
			for _, row := range rows {
				counts[str(row["status"])] = toInt64(row["n"])
			}
		}

		resolvedToday := int64(0)
		if rows, _ := db.PGQuery(ctx, `
			SELECT COUNT(*) AS n FROM helpdesk_tickets
			WHERE status='resolved' AND resolved_at::date=CURRENT_DATE`+chanClause); len(rows) > 0 {
			resolvedToday = toInt64(rows[0]["n"])
		}

		slaBreached := int64(0)
		if rows, _ := db.PGQuery(ctx, `
			SELECT COUNT(*) AS n FROM helpdesk_tickets
			WHERE sla_due_at IS NOT NULL AND sla_due_at < NOW()
			  AND status NOT IN ('resolved','closed')`+chanClause); len(rows) > 0 {
			slaBreached = toInt64(rows[0]["n"])
		}

		avgFirstResp := 0.0
		if rows, _ := db.PGQuery(ctx,
			`SELECT AVG(EXTRACT(EPOCH FROM (first_response_at - created_at))/3600) AS avg_hrs
			 FROM helpdesk_tickets
			 WHERE first_response_at IS NOT NULL `+dateClause+chanClause, dateArgs...); len(rows) > 0 {
			if v, ok := rows[0]["avg_hrs"].(float64); ok {
				avgFirstResp = v
			}
		}

		avgResolution := 0.0
		if rows, _ := db.PGQuery(ctx,
			`SELECT AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))/3600) AS avg_hrs
			 FROM helpdesk_tickets
			 WHERE resolved_at IS NOT NULL `+dateClause+chanClause, dateArgs...); len(rows) > 0 {
			if v, ok := rows[0]["avg_hrs"].(float64); ok {
				avgResolution = v
			}
		}

		avgCSAT := 0.0
		if rows, _ := db.PGQuery(ctx,
			`SELECT AVG(csat_score::float) AS avg
			 FROM helpdesk_tickets
			 WHERE csat_score IS NOT NULL `+dateClause+chanClause, dateArgs...); len(rows) > 0 {
			if v, ok := rows[0]["avg"].(float64); ok {
				avgCSAT = v
			}
		}

		// by_channel — return as array so frontend can .map() it
		var byChannel []map[string]any
		if rows, _ := db.PGQuery(ctx,
			`SELECT channel, COUNT(*) AS n FROM helpdesk_tickets
			 WHERE TRUE `+dateClause+chanClause+` GROUP BY channel ORDER BY n DESC`, dateArgs...); rows != nil {
			for _, row := range rows {
				byChannel = append(byChannel, map[string]any{
					"channel": str(row["channel"]),
					"count":   toInt64(row["n"]),
				})
			}
		}
		if byChannel == nil {
			byChannel = []map[string]any{}
		}

		// by_status — as array
		var byStatus []map[string]any
		for _, s := range []string{"open", "pending", "in_progress", "resolved", "closed"} {
			if n := counts[s]; n > 0 {
				byStatus = append(byStatus, map[string]any{"status": s, "count": n})
			}
		}
		if byStatus == nil {
			byStatus = []map[string]any{}
		}

		agents, _ := db.PGQuery(ctx,
			`SELECT u.full_name AS agent_name,
			        COUNT(*) FILTER (WHERE t.status NOT IN ('resolved','closed')) AS open_tickets,
			        COUNT(*) FILTER (WHERE t.status='resolved' AND t.resolved_at::date=CURRENT_DATE) AS resolved_today,
			        ROUND((AVG(t.csat_score::numeric) FILTER (WHERE t.csat_score IS NOT NULL)), 1) AS avg_csat,
			        ROUND(AVG(EXTRACT(EPOCH FROM (t.resolved_at - t.created_at))/60.0)
			              FILTER (WHERE t.resolved_at IS NOT NULL))                                  AS avg_handle_time_min,
			        COUNT(*) FILTER (WHERE EXISTS (
			          SELECT 1 FROM helpdesk_messages em
			          WHERE em.ticket_id=t.id AND em.author_user_id=u.id AND em.body_text ILIKE '[ESCALAT%'
			        ))                                                                                AS escalations
			 FROM helpdesk_tickets t
			 JOIN o3c_users u ON t.assigned_to=u.id
			 WHERE t.assigned_to IS NOT NULL `+dateClause+chanClauseT+`
			 GROUP BY u.id, u.full_name
			 ORDER BY u.full_name`, dateArgs...)
		if agents == nil {
			agents = []core.Row{}
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"open":                     counts["open"],
			"pending":                  counts["pending"],
			"in_progress":              counts["in_progress"],
			"resolved_today":           resolvedToday,
			"sla_breached":             slaBreached,
			"avg_first_response_hours": round2(avgFirstResp),
			"avg_resolution_hours":     round2(avgResolution),
			"avg_csat":                 round2(avgCSAT),
			"by_channel":               byChannel,
			"by_status":                byStatus,
			"agents":                   agents,
		})
	}
}

// ── CSAT ─────────────────────────────────────────────────────────────────────

func hdCSATGet(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := chi.URLParam(r, "token")
		rows, _ := db.PGQuery(r.Context(),
			"SELECT id, ticket_ref, customer_name, subject, csat_score, csat_comment, status FROM helpdesk_tickets WHERE csat_token=$1",
			token)
		if len(rows) == 0 {
			respondErr(w, 404, "Invalid CSAT token")
			return
		}
		ticket := rows[0]

		// If score is provided in query param (from email link click)
		if scoreStr := qstr(r, "score"); scoreStr != "" {
			score, err := strconv.Atoi(scoreStr)
			if err == nil && score >= 1 && score <= 5 {
				db.PGExec(r.Context(), //nolint:errcheck
					"UPDATE helpdesk_tickets SET csat_score=$1, updated_at=NOW() WHERE csat_token=$2 AND csat_score IS NULL",
					score, token)
				ticket["csat_score"] = int64(score)
			}
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"ticket_ref":    ticket["ticket_ref"],
			"customer_name": ticket["customer_name"],
			"subject":       ticket["subject"],
			"status":        ticket["status"],
			"csat_score":    ticket["csat_score"],
			"csat_comment":  ticket["csat_comment"],
		})
	}
}

func hdCSATSubmit(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := chi.URLParam(r, "token")
		var b struct {
			Score   int    `json:"score"`
			Comment string `json:"comment"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Score < 1 || b.Score > 5 {
			respondErr(w, 422, "score must be between 1 and 5")
			return
		}

		tRows, _ := db.PGQuery(r.Context(),
			"SELECT id, ticket_ref FROM helpdesk_tickets WHERE csat_token=$1", token)
		if len(tRows) == 0 {
			respondErr(w, 404, "Invalid CSAT token")
			return
		}
		ticketID := toInt64(tRows[0]["id"])

		pgResult, err := db.PGExec(r.Context(),
			"UPDATE helpdesk_tickets SET csat_score=$1, csat_comment=$2, csat_submitted_at=NOW(), updated_at=NOW() WHERE csat_token=$3 AND csat_score IS NULL",
			b.Score, b.Comment, token)
		if err != nil {
			respondErr(w, 500, "Update failed")
			return
		}
		if affected, _ := pgResult.RowsAffected(); affected == 0 {
			respondErr(w, 409, "Survey already submitted")
			return
		}

		hdRecordEvent(r.Context(), db, ticketID, 0, "csat_submitted",
			"", fmt.Sprintf("score=%d", b.Score))

		if b.Score <= 2 {
			ticketRef := str(tRows[0]["ticket_ref"])
			go NotifyRole(context.Background(), db, "call_center_head", NotifPayload{
				EventType: EvtCSATLowScore,
				Title:     fmt.Sprintf("Low CSAT score (%d/5) on %s", b.Score, ticketRef),
				Body:      fmt.Sprintf("Customer rated %d/5 for ticket %s. Comment: %s", b.Score, ticketRef, b.Comment),
				ActionURL: fmt.Sprintf("/helpdesk/%d", ticketID),
				EntityRef: ticketRef,
			})
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true}) //nolint:errcheck
	}
}

// ── Inbound webhooks (no auth) ─────────────────────────────────────────────────

func hdInboundEmail(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		// Read raw body first so we can verify the HMAC before consuming the multipart stream.
		rawBody, _ := io.ReadAll(r.Body)
		r.Body = io.NopCloser(bytes.NewReader(rawBody))

		if verifyKey := os.Getenv("SENDGRID_WEBHOOK_VERIFICATION_KEY"); verifyKey != "" {
			ts := r.Header.Get("X-Twilio-Email-Event-Webhook-Timestamp")
			sig := r.Header.Get("X-Twilio-Email-Event-Webhook-Signature")
			if !verifyInboundWebhookHMAC(verifyKey, ts, sig, rawBody) {
				w.WriteHeader(401)
				return
			}
		} else {
			slog.Warn("hdInboundEmail: SENDGRID_WEBHOOK_VERIFICATION_KEY not set; webhook is unauthenticated")
		}

		r.ParseMultipartForm(10 << 20) //nolint:errcheck

		from := hdFormVal(r, r.MultipartForm, "from")
		to := hdFormVal(r, r.MultipartForm, "to")
		subject := hdFormVal(r, r.MultipartForm, "subject")
		bodyText := hdFormVal(r, r.MultipartForm, "text")
		bodyHTML := hdFormVal(r, r.MultipartForm, "html")
		headersRaw := hdFormVal(r, r.MultipartForm, "headers")

		// Parse email headers
		msgID, inReplyTo, _ := hdParseEmailHeaders(headersRaw)

		// Parse sender email
		senderEmail := hdParseEmail(from)
		senderName := hdParseName(from)

		var ticketID int64
		var ticket map[string]any

		// 1. Try to find ticket from To address (e.g. ticket-TKT-00042@...)
		if ref := hdExtractTicketRef(to); ref != "" {
			if rows, _ := db.PGQuery(ctx, "SELECT * FROM helpdesk_tickets WHERE ticket_ref=$1", ref); len(rows) > 0 {
				ticket = rows[0]
				ticketID = toInt64(ticket["id"])
			}
		}

		// 2. Try to match by In-Reply-To
		if ticketID == 0 && inReplyTo != "" {
			if rows, _ := db.PGQuery(ctx, `
				SELECT t.* FROM helpdesk_messages m
				JOIN helpdesk_tickets t ON m.ticket_id=t.id
				WHERE m.email_message_id=$1
				ORDER BY m.created_at DESC LIMIT 1`, inReplyTo); len(rows) > 0 {
				ticket = rows[0]
				ticketID = toInt64(ticket["id"])
			}
		}

		// 3. Match by sender email to most recent open ticket
		if ticketID == 0 && senderEmail != "" {
			if rows, _ := db.PGQuery(ctx, `
				SELECT * FROM helpdesk_tickets
				WHERE customer_email=$1 AND status NOT IN ('resolved','closed')
				ORDER BY created_at DESC LIMIT 1`, senderEmail); len(rows) > 0 {
				ticket = rows[0]
				ticketID = toInt64(ticket["id"])
			}
		}

		// 4. Create new ticket
		if ticketID == 0 {
			// Try to find CIF by email
			customerCIF := ""
			if rows, _ := db.PGQuery(ctx, `SELECT cif FROM app.customers WHERE email=$1 LIMIT 1`, senderEmail); len(rows) > 0 {
				customerCIF = str(rows[0]["cif"])
			}

			sub := subject
			if sub == "" {
				sub = "Inbound email from " + senderEmail
			}
			newRows, err := db.PGQuery(ctx, `
				INSERT INTO helpdesk_tickets
				    (channel, status, priority, subject, customer_cif, customer_name, customer_email, email_thread_id)
				VALUES ('email','open','normal',$1,$2,$3,$4,$5)
				RETURNING *`,
				sub,
				ptrOrNilStr(customerCIF),
				ptrOrNilStr(senderName),
				senderEmail,
				ptrOrNilStr(msgID))
			if err != nil {
				slog.Error("hdInboundEmail: create ticket", "err", err)
				w.WriteHeader(200) // Always 200 to avoid SendGrid retries
				return
			}
			ticket = newRows[0]
			ticketID = toInt64(ticket["id"])
			hdRecordEvent(ctx, db, ticketID, 0, "created_inbound", "", str(ticket["ticket_ref"]))
		}

		// Insert message
		db.PGExec(ctx, //nolint:errcheck
			`INSERT INTO helpdesk_messages
			    (ticket_id, direction, channel, author_name, body_text, body_html, email_message_id, in_reply_to)
			VALUES ($1,'inbound','email',$2,$3,$4,NULLIF($5,''),NULLIF($6,''))`,
			ticketID, senderName, bodyText, bodyHTML, msgID, inReplyTo)

		db.PGExec(ctx, "UPDATE helpdesk_tickets SET updated_at=NOW() WHERE id=$1", ticketID) //nolint:errcheck

		// Notify assigned agent
		if ticket != nil {
			if assignedTo := toInt64(ticket["assigned_to"]); assignedTo > 0 {
				go sendNotification(context.Background(), db, assignedTo,
					"ticket_reply",
					fmt.Sprintf("New reply on %s", str(ticket["ticket_ref"])),
					fmt.Sprintf("%s replied to ticket %s", senderName, str(ticket["ticket_ref"])),
					"helpdesk_tickets", ticketID)
			}
		}

		w.WriteHeader(200)
	}
}

func hdInboundSMS(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		// Verify shared secret when configured.
		secret := coalesce(os.Getenv("HELPDESK_SMS_WEBHOOK_SECRET"), os.Getenv("SMS_WEBHOOK_SECRET"))
		if secret != "" {
			if !checkWebhookToken(r, secret) {
				w.WriteHeader(401)
				return
			}
		} else {
			slog.Warn("hdInboundSMS: no webhook secret configured; request proceeding unauthenticated")
		}

		var data map[string]any
		if err := json.NewDecoder(r.Body).Decode(&data); err != nil {
			w.WriteHeader(200)
			return
		}

		fromRaw := str(data["from"])
		bodyText := str(data["text"])
		providerMsgID := str(data["messageId"])

		phone := hdNormalizePhone(fromRaw)
		if phone == "" || bodyText == "" {
			w.WriteHeader(200)
			return
		}

		var ticketID int64
		var ticket map[string]any

		// Find most recent open ticket with this phone
		if rows, _ := db.PGQuery(ctx, `
			SELECT * FROM helpdesk_tickets
			WHERE customer_phone=$1 AND status NOT IN ('resolved','closed')
			ORDER BY created_at DESC LIMIT 1`, phone); len(rows) > 0 {
			ticket = rows[0]
			ticketID = toInt64(ticket["id"])
		}

		// Create new ticket if not found
		if ticketID == 0 {
			customerCIF := ""
			// Try MSSQL/Supabase lookup by phone (Accounts table)
			if rows, _ := db.PGQuery(ctx, `SELECT cif FROM app.customers WHERE phone=$1 LIMIT 1`, phone); len(rows) > 0 {
				customerCIF = str(rows[0]["cif"])
			}
			newRows, err := db.PGQuery(ctx, `
				INSERT INTO helpdesk_tickets
				    (channel, status, priority, subject, customer_cif, customer_phone)
				VALUES ('sms','open','normal',$1,$2,$3)
				RETURNING *`,
				"SMS from "+phone,
				ptrOrNilStr(customerCIF),
				phone)
			if err != nil {
				slog.Error("hdInboundSMS: create ticket", "err", err)
				w.WriteHeader(200)
				return
			}
			ticket = newRows[0]
			ticketID = toInt64(ticket["id"])
			hdRecordEvent(ctx, db, ticketID, 0, "created_inbound", "", str(ticket["ticket_ref"]))
		}

		// Insert message
		db.PGExec(ctx, //nolint:errcheck
			`INSERT INTO helpdesk_messages
			    (ticket_id, direction, channel, author_name, body_text, provider_message_id)
			VALUES ($1,'inbound','sms',$2,$3,$4)`,
			ticketID, phone, bodyText, providerMsgID)

		db.PGExec(ctx, "UPDATE helpdesk_tickets SET updated_at=NOW() WHERE id=$1", ticketID) //nolint:errcheck

		// Notify assigned agent
		if ticket != nil {
			if assignedTo := toInt64(ticket["assigned_to"]); assignedTo > 0 {
				go sendNotification(context.Background(), db, assignedTo,
					"ticket_reply",
					fmt.Sprintf("New SMS reply on %s", str(ticket["ticket_ref"])),
					fmt.Sprintf("Customer replied via SMS to ticket %s", str(ticket["ticket_ref"])),
					"helpdesk_tickets", ticketID)
			}
		}

		w.WriteHeader(200)
	}
}

// ── Internal helpers ──────────────────────────────────────────────────────────

func hdRecordEvent(ctx context.Context, db *core.DB, ticketID, userID int64, eventType, oldVal, newVal string) {
	var uid any
	if userID > 0 {
		uid = userID
	}
	db.PGExec(ctx, //nolint:errcheck
		`INSERT INTO helpdesk_events (ticket_id, user_id, event_type, old_value, new_value)
		 VALUES ($1,$2,$3,NULLIF($4,''),NULLIF($5,''))`,
		ticketID, uid, eventType, oldVal, newVal)
}

// hdBulkRecordEvent writes one audit event per ticket in a single batch insert. The
// bulk actions (assign/close/priority) previously left NO history at all, which is a
// real gap for a CBN-regulated call centre and undermines the CBN report that counts
// on ticket data.
func hdBulkRecordEvent(ctx context.Context, db *core.DB, ticketIDs []int64, actorID int64, eventType, oldVal, newVal string) {
	if len(ticketIDs) == 0 {
		return
	}
	db.PGExec(ctx, //nolint:errcheck
		`INSERT INTO helpdesk_events (ticket_id, user_id, event_type, old_value, new_value)
		 SELECT unnest($1::bigint[]), NULLIF($2,0)::bigint, $3, NULLIF($4,''), NULLIF($5,'')`,
		ticketIDs, actorID, eventType, oldVal, newVal)
}

// hdValidStatus reports whether s is a canonical ticket status. Permissive enough to
// cover every state the importer, UI and merge path produce, but it rejects free-form
// typos that would silently create ghost statuses no query filters on (P5).
func hdValidStatus(s string) bool {
	switch s {
	case "open", "in_progress", "pending", "escalated", "resolved", "closed", "cancelled", "merged":
		return true
	}
	return false
}

func hdComputeSLADue(ctx context.Context, db *core.DB, priority string) *time.Time {
	rows, err := db.PGQuery(ctx,
		"SELECT resolution_hours FROM helpdesk_sla_policies WHERE priority=$1 AND is_active=true LIMIT 1",
		priority)
	if err != nil || len(rows) == 0 {
		return nil
	}
	hours := toInt64(rows[0]["resolution_hours"])
	if hours <= 0 {
		return nil
	}
	t := time.Now().Add(time.Duration(hours) * time.Hour)
	return &t
}

// hdComputeFirstResponseDue returns the first-response SLA deadline for the given priority. H2.
func hdComputeFirstResponseDue(ctx context.Context, db *core.DB, priority string) *time.Time {
	rows, err := db.PGQuery(ctx,
		"SELECT first_response_hours FROM helpdesk_sla_policies WHERE priority=$1 AND is_active=true LIMIT 1",
		priority)
	if err != nil || len(rows) == 0 {
		return nil
	}
	hours := toInt64(rows[0]["first_response_hours"])
	if hours <= 0 {
		return nil
	}
	t := time.Now().Add(time.Duration(hours) * time.Hour)
	return &t
}

// hdSLATimesFrom computes the resolution and first-response SLA deadlines for a
// priority, measured from base (e.g. a ticket's created time). Returns nil for a
// deadline when there is no active policy for the priority. Unlike the hdCompute*
// helpers (which measure from now), this lets the importer/backfill anchor SLA to
// when the ticket was actually raised.
func hdSLATimesFrom(ctx context.Context, db *core.DB, priority string, base time.Time) (resolutionDue, firstResponseDue *time.Time) {
	rows, err := db.PGQuery(ctx,
		"SELECT resolution_hours, first_response_hours FROM helpdesk_sla_policies WHERE priority=$1 AND is_active=true LIMIT 1",
		priority)
	if err != nil || len(rows) == 0 {
		return nil, nil
	}
	if rh := toInt64(rows[0]["resolution_hours"]); rh > 0 {
		t := base.Add(time.Duration(rh) * time.Hour)
		resolutionDue = &t
	}
	if fh := toInt64(rows[0]["first_response_hours"]); fh > 0 {
		t := base.Add(time.Duration(fh) * time.Hour)
		firstResponseDue = &t
	}
	return resolutionDue, firstResponseDue
}

func hdCustomerContext(ctx context.Context, db *core.DB, cif string) map[string]any {
	result := map[string]any{
		"cif_number":        nil,
		"full_name":         nil,
		"account_status":    nil,
		"open_tickets":      int64(0),
		"dpd":               nil,
		"loan_balance_kobo": nil,
		"last_payment_date": nil,
	}
	if cif == "" {
		return result
	}
	result["cif_number"] = cif

	// Open tickets count
	if rows, _ := db.PGQuery(ctx, `
		SELECT COUNT(*) AS n FROM helpdesk_tickets
		WHERE customer_cif=$1 AND status NOT IN ('resolved','closed')`, cif); len(rows) > 0 {
		result["open_tickets"] = toInt64(rows[0]["n"])
	}

	// Account info from Supabase snapshot
	if rows, _ := db.PGQuery(ctx, `
		SELECT first_name AS "First Name", last_name AS "Last Name", account_created AS "Account Created Date"
		FROM app.customers WHERE cif=$1 LIMIT 1`, cif); len(rows) > 0 {
		firstName := str(rows[0]["First Name"])
		lastName := str(rows[0]["Last Name"])
		result["full_name"] = strings.TrimSpace(firstName + " " + lastName)
	}

	// Product/status info
	if rows, _ := db.PGQuery(ctx, `
		SELECT status AS "Account Status", product_name AS "Product Name"
		FROM app.accounts WHERE cif=$1 LIMIT 1`, cif); len(rows) > 0 {
		result["account_status"] = rows[0]["Account Status"]
	}

	// Loan info if available
	if rows, _ := db.PGQuery(ctx, `
		SELECT dpd, outstanding_balance_kobo, last_payment_date
		FROM loan_applications
		WHERE customer_cif=$1 AND status NOT IN ('cancelled','rejected')
		ORDER BY created_at DESC LIMIT 1`, cif); len(rows) > 0 {
		result["dpd"] = rows[0]["dpd"]
		result["loan_balance_kobo"] = rows[0]["outstanding_balance_kobo"]
		result["last_payment_date"] = rows[0]["last_payment_date"]
	}

	return result
}

func hdSendTicketEmail(ctx context.Context, db *core.DB, ticket map[string]any, bodyText, bodyHTML, msgID, inReplyTo, agentName string, attachments []MailAttachment) {
	toEmail := str(ticket["customer_email"])
	if toEmail == "" {
		return
	}
	toName := str(ticket["customer_name"])
	subject := fmt.Sprintf("Re: %s [%s]", str(ticket["subject"]), str(ticket["ticket_ref"]))

	// Show the agent's name in the FROM display so the customer knows who replied.
	// Replies still go to the shared inbox (care@o3cards.com) via the from address.
	fromName := "O3 Capital Support"
	if agentName != "" {
		fromName = agentName + " (O3 Capital)"
	}

	opts := SendMailOptions{
		To:          []MailAddress{{Email: toEmail, Name: toName}},
		FromName:    fromName,
		Subject:     subject,
		HTMLBody:    bodyHTML,
		TextBody:    bodyText,
		Category:    "helpdesk",
		Kind:        "helpdesk",
		RelatedType: "helpdesk_tickets",
		RelatedID:   toInt64(ticket["id"]),
		Attachments: attachments,
		CustomArgs: map[string]string{
			"ticket_ref": str(ticket["ticket_ref"]),
			"msg_id":     msgID,
		},
	}
	if bodyHTML == "" {
		opts.HTMLBody = "<p>" + escapeMailHTML(bodyText) + "</p>"
	}
	SendMail(ctx, db, opts)
}

func hdSendCSATEmail(ctx context.Context, db *core.DB, ticket map[string]any) {
	toEmail := str(ticket["customer_email"])
	if toEmail == "" {
		return
	}
	csatToken := str(ticket["csat_token"])
	if csatToken == "" {
		return
	}

	// Get APP_BASE_URL from settings
	base := ""
	if rows, _ := db.PGQuery(ctx, `SELECT value FROM settings WHERE key='app_base_url'`); len(rows) > 0 {
		base = strings.TrimRight(str(rows[0]["value"]), "/")
	}
	if base == "" {
		slog.Warn("hdSendCSATEmail: app_base_url not configured, skipping CSAT email")
		return
	}

	csatURL := fmt.Sprintf("%s/csat/%s", base, csatToken)
	customerName := str(ticket["customer_name"])
	if customerName == "" {
		customerName = "Customer"
	}
	ticketRef := str(ticket["ticket_ref"])
	subject := fmt.Sprintf("How did we do? — %s", ticketRef)
	html := fmt.Sprintf(`<p>Hi %s,</p>
<p>Your support request (<strong>%s</strong>) has been resolved. We'd love to know how we did!</p>
<p>Rate your experience (1–5 stars):</p>
<p>
  <a href="%s?score=1">&#11088; 1</a> &nbsp;
  <a href="%s?score=2">&#11088;&#11088; 2</a> &nbsp;
  <a href="%s?score=3">&#11088;&#11088;&#11088; 3</a> &nbsp;
  <a href="%s?score=4">&#11088;&#11088;&#11088;&#11088; 4</a> &nbsp;
  <a href="%s?score=5">&#11088;&#11088;&#11088;&#11088;&#11088; 5</a>
</p>
<p style="font-size:12px;color:#666">O3 Capital Customer Support</p>`,
		escapeMailHTML(customerName), escapeMailHTML(ticketRef),
		csatURL, csatURL, csatURL, csatURL, csatURL)
	text := fmt.Sprintf("Hi %s,\n\nYour support request (%s) has been resolved.\nRate your experience: %s\n\nO3 Capital Customer Support",
		customerName, ticketRef, csatURL)

	SendMail(ctx, db, SendMailOptions{
		To:          []MailAddress{{Email: toEmail, Name: customerName}},
		Subject:     subject,
		HTMLBody:    html,
		TextBody:    text,
		Category:    "helpdesk",
		Kind:        "csat",
		RelatedType: "helpdesk_tickets",
		RelatedID:   toInt64(ticket["id"]),
	})
}

// ── Parsing / normalization helpers ──────────────────────────────────────────

var ticketRefRE = regexp.MustCompile(`TKT-\d{5}`)

func hdExtractTicketRef(to string) string {
	m := ticketRefRE.FindString(strings.ToUpper(to))
	return m
}

func hdParseEmailHeaders(raw string) (msgID, inReplyTo, references string) {
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		lower := strings.ToLower(line)
		if strings.HasPrefix(lower, "message-id:") {
			msgID = strings.TrimSpace(line[len("message-id:"):])
		} else if strings.HasPrefix(lower, "in-reply-to:") {
			inReplyTo = strings.TrimSpace(line[len("in-reply-to:"):])
		} else if strings.HasPrefix(lower, "references:") {
			references = strings.TrimSpace(line[len("references:"):])
		}
	}
	return
}

func hdParseEmail(raw string) string {
	addr, err := mail.ParseAddress(raw)
	if err != nil {
		// Fall back to extracting bare email
		if i := strings.Index(raw, "<"); i >= 0 {
			if j := strings.Index(raw[i:], ">"); j >= 0 {
				return strings.TrimSpace(raw[i+1 : i+j])
			}
		}
		return strings.TrimSpace(raw)
	}
	return strings.ToLower(strings.TrimSpace(addr.Address))
}

func hdParseName(raw string) string {
	addr, err := mail.ParseAddress(raw)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(addr.Name)
}

func hdNormalizePhone(raw string) string {
	// Strip non-digits
	re := regexp.MustCompile(`\D`)
	digits := re.ReplaceAllString(raw, "")
	if len(digits) == 0 {
		return ""
	}
	// Nigerian: 080xxxxxxxx → 2348xxxxxxxx
	if len(digits) == 11 && strings.HasPrefix(digits, "0") {
		return "234" + digits[1:]
	}
	return digits
}

func hdFormVal(r *http.Request, form *multipart.Form, key string) string {
	if form != nil {
		if vals, ok := form.Value[key]; ok && len(vals) > 0 {
			return vals[0]
		}
	}
	return r.FormValue(key)
}

func hdNewUUID() string {
	// Use gen_random_uuid equivalent — crypto/rand based
	var buf [16]byte
	rand.Read(buf[:]) //nolint:errcheck
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		buf[0:4], buf[4:6], buf[6:8], buf[8:10], buf[10:16])
}

func ptrOrNil(s *string) any {
	if s == nil || strings.TrimSpace(*s) == "" {
		return nil
	}
	return *s
}

func ptrOrNilStr(s string) any {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return s
}

func ptrStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func round2(f float64) float64 {
	return float64(int(f*100+0.5)) / 100
}

// ── Call Log ──────────────────────────────────────────────────────────────────

func ensureCallLogSchema(ctx context.Context, db *core.DB) error {
	_, err := db.PGExec(ctx, `
		CREATE TABLE IF NOT EXISTS helpdesk_calls (
		  id             BIGSERIAL PRIMARY KEY,
		  agent_id       BIGINT REFERENCES o3c_users(id),
		  agent_name     TEXT NOT NULL DEFAULT '',
		  customer_name  TEXT NOT NULL DEFAULT '',
		  customer_cif   TEXT NOT NULL DEFAULT '',
		  customer_email TEXT NOT NULL DEFAULT '',
		  customer_phone TEXT NOT NULL DEFAULT '',
		  direction      TEXT NOT NULL DEFAULT 'inbound',
		  duration_sec   INT,
		  outcome        TEXT NOT NULL DEFAULT 'resolved',
		  notes          TEXT,
		  ticket_id      BIGINT REFERENCES helpdesk_tickets(id) ON DELETE SET NULL,
		  ticket_ref     TEXT,
		  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`)
	if err != nil {
		return err
	}
	db.PGExec(ctx, `CREATE INDEX IF NOT EXISTS idx_helpdesk_calls_started ON helpdesk_calls(started_at DESC)`)
	db.PGExec(ctx, `CREATE INDEX IF NOT EXISTS idx_helpdesk_calls_agent ON helpdesk_calls(agent_id, started_at DESC)`)
	db.PGExec(ctx, `ALTER TABLE helpdesk_calls ADD COLUMN IF NOT EXISTS customer_cif TEXT NOT NULL DEFAULT ''`)
	db.PGExec(ctx, `ALTER TABLE helpdesk_calls ADD COLUMN IF NOT EXISTS customer_email TEXT NOT NULL DEFAULT ''`)
	db.PGExec(ctx, `ALTER TABLE helpdesk_calls ADD COLUMN IF NOT EXISTS call_to TEXT`)
	db.PGExec(ctx, `ALTER TABLE helpdesk_calls ADD COLUMN IF NOT EXISTS recording_url TEXT`)
	db.PGExec(ctx, `ALTER TABLE helpdesk_calls ADD COLUMN IF NOT EXISTS ticket_type TEXT`)
	db.PGExec(ctx, `ALTER TABLE helpdesk_calls ADD COLUMN IF NOT EXISTS transcript TEXT`)
	db.PGExec(ctx, `ALTER TABLE helpdesk_calls ADD COLUMN IF NOT EXISTS zoho_call_id TEXT`)
	db.PGExec(ctx, `ALTER TABLE helpdesk_calls ADD COLUMN IF NOT EXISTS zoho_voice_id TEXT`)
	// Agent-logged call disposition (business result) + the agent's resolution note.
	// The customer complaint/summary continues to live in `notes` (already read by
	// the list, export and Customer360 activity), so old rows keep displaying.
	db.PGExec(ctx, `ALTER TABLE helpdesk_calls ADD COLUMN IF NOT EXISTS disposition TEXT`)
	db.PGExec(ctx, `ALTER TABLE helpdesk_calls ADD COLUMN IF NOT EXISTS resolution TEXT`)
	db.PGExec(ctx, `CREATE INDEX IF NOT EXISTS idx_helpdesk_calls_cif ON helpdesk_calls(customer_cif, started_at DESC)`)
	db.PGExec(ctx, `CREATE UNIQUE INDEX IF NOT EXISTS idx_hd_calls_zoho_id ON helpdesk_calls(zoho_call_id) WHERE zoho_call_id IS NOT NULL`)
	db.PGExec(ctx, `CREATE UNIQUE INDEX IF NOT EXISTS idx_hd_calls_zoho_voice ON helpdesk_calls(zoho_voice_id) WHERE zoho_voice_id IS NOT NULL`)
	return nil
}

func hdLogCall(db *core.DB) http.HandlerFunc {
	type body struct {
		CustomerName    string  `json:"customer_name"`
		CustomerCIF     string  `json:"customer_cif"`
		CustomerEmail   string  `json:"customer_email"`
		CustomerPhone   string  `json:"customer_phone"`
		Direction       string  `json:"direction"`
		DurationSec     *int    `json:"duration_sec"`
		DurationSeconds *int    `json:"duration_seconds"` // client sends this name
		Outcome         string  `json:"outcome"`
		Notes           *string `json:"notes"`        // customer complaint / summary
		Resolution      *string `json:"resolution"`   // agent response / resolution
		Disposition     string  `json:"disposition"`  // business result of the call
		TicketRef       string  `json:"ticket_ref"`
		TicketType      string  `json:"ticket_type"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureCallLogSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "Schema setup failed")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		user := core.UserFromCtx(r.Context())
		agentName := ""
		if user != nil {
			agentName = user.FullName
		}
		// Client sends "Inbound"/"Outbound" (capitalised); normalise before the guard
		// so an outbound call isn't silently filed as inbound.
		direction := strings.ToLower(strings.TrimSpace(b.Direction))
		if direction != "inbound" && direction != "outbound" {
			direction = "inbound"
		}
		// Accept either duration field name (client sends duration_seconds).
		durationSec := b.DurationSec
		if durationSec == nil {
			durationSec = b.DurationSeconds
		}
		outcome := b.Outcome
		if outcome == "" {
			outcome = "resolved"
		}
		// Look up ticket by ref if provided
		var ticketID *int64
		if strings.TrimSpace(b.TicketRef) != "" {
			rows, _ := db.PGQuery(r.Context(), `SELECT id FROM helpdesk_tickets WHERE ticket_ref=$1 LIMIT 1`, b.TicketRef)
			if len(rows) > 0 {
				if v, ok := rows[0]["id"]; ok {
					switch id := v.(type) {
					case int64:
						ticketID = &id
					case float64:
						i := int64(id)
						ticketID = &i
					}
				}
			}
		}
		if strings.TrimSpace(b.CustomerName) == "" && strings.TrimSpace(b.CustomerCIF) != "" {
			if rows, _ := db.PGQuery(r.Context(), `
				SELECT first_name AS "First Name", last_name AS "Last Name", phone, email
				FROM app.customers
				WHERE cif=$1 LIMIT 1`, b.CustomerCIF); len(rows) > 0 {
				b.CustomerName = strings.TrimSpace(str(rows[0]["First Name"]) + " " + str(rows[0]["Last Name"]))
				if b.CustomerPhone == "" {
					b.CustomerPhone = str(rows[0]["Phone"])
				}
				if b.CustomerEmail == "" {
					b.CustomerEmail = str(rows[0]["Email"])
				}
			}
		}
		var agentID *int64
		if user != nil {
			agentID = &user.ID
		}
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO helpdesk_calls
			  (agent_id, agent_name, customer_name, customer_cif, customer_email, customer_phone, direction, duration_sec, outcome, notes, ticket_id, ticket_ref, ticket_type, resolution, disposition)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
			RETURNING id`,
			agentID, agentName, b.CustomerName, b.CustomerCIF, b.CustomerEmail, b.CustomerPhone,
			direction, durationSec, outcome, b.Notes, ticketID, ptrOrNilStr(b.TicketRef), ptrOrNilStr(b.TicketType),
			b.Resolution, ptrOrNilStr(b.Disposition))
		if err != nil {
			respondErr(w, 500, "Insert failed: "+err.Error())
			return
		}
		if ticketID != nil {
			db.PGExec(r.Context(), "UPDATE helpdesk_tickets SET updated_at=NOW() WHERE id=$1", *ticketID) //nolint:errcheck
		}
		jsonRows(w, rows)
	}
}

// hdTicketPromise records a customer's promise-to-pay, logged from a helpdesk
// ticket, into the Collections promise book (collection_promises) keyed by the
// ticket's CIF — so the promise genuinely reaches the Collections team.
func hdTicketPromise(db *core.DB) http.HandlerFunc {
	type body struct {
		AmountKobo  int64  `json:"amount_kobo"`
		PromiseDate string `json:"promise_date"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.AmountKobo <= 0 || b.PromiseDate == "" {
			respondErr(w, 422, "amount_kobo and promise_date are required")
			return
		}
		rows, _ := db.PGQuery(r.Context(), `SELECT customer_cif FROM helpdesk_tickets WHERE id=$1`, id)
		if len(rows) == 0 {
			respondErr(w, 404, "Ticket not found")
			return
		}
		cif := str(rows[0]["customer_cif"])
		if cif == "" {
			respondErr(w, 422, "Ticket has no customer CIF to attach a promise to")
			return
		}
		var agentID *int64
		if u := core.UserFromCtx(r.Context()); u != nil {
			agentID = &u.ID
		}
		out, err := db.PGQuery(r.Context(), `
			INSERT INTO collection_promises (cif_number, agent_user_id, promised_amount_kobo, promised_date, created_at)
			VALUES ($1,$2,$3,$4,NOW())
			RETURNING id, promised_date, promised_amount_kobo`,
			cif, agentID, b.AmountKobo, b.PromiseDate)
		if err != nil {
			respondErr(w, 500, "Failed to record promise")
			return
		}
		respond(w, out[0], "pg")
	}
}

func hdListCalls(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureCallLogSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "Schema setup failed")
			return
		}
		dateFrom := r.URL.Query().Get("date_from")
		dateTo := r.URL.Query().Get("date_to")
		customerCIF := r.URL.Query().Get("customer_cif")
		agentFilter := r.URL.Query().Get("agent")
		outcomeFilter := r.URL.Query().Get("outcome")
		directionFilter := r.URL.Query().Get("direction")
		limit := qint(r, "limit", 200, 1, 500)

		// direction + outcome accept comma-separated multi-select (e.g. "Inbound,Outbound").
		extra := sqlInLower("direction", directionFilter) + sqlInLower("outcome", outcomeFilter)
		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT hc.id, hc.agent_name, hc.customer_name,
			       hc.customer_phone AS phone,
			       hc.customer_cif, hc.customer_email,
			       INITCAP(hc.direction) AS direction,
			       hc.duration_sec AS duration_seconds,
			       hc.outcome, hc.notes, hc.resolution, hc.disposition,
			       hc.ticket_id, hc.ticket_ref, hc.recording_url, hc.ticket_type,
			       hc.started_at AS called_at,
			       qa.id AS qa_evaluation_id, qa.total_score AS qa_score, qa.rating_band AS qa_band, qa.passed AS qa_passed
			FROM helpdesk_calls hc
			LEFT JOIN LATERAL (
			  SELECT id, total_score, rating_band, passed FROM qa_evaluations q
			  WHERE q.call_id = hc.id ORDER BY q.created_at DESC LIMIT 1
			) qa ON true
			WHERE ($1 = '' OR hc.started_at::date >= $1::date)
			  AND ($2 = '' OR started_at::date <= $2::date)
			  AND ($3 = '' OR customer_cif = $3)
			  AND ($4 = '' OR agent_name ILIKE '%%' || $4 || '%%')%s
			ORDER BY started_at DESC
			LIMIT $5`, extra), dateFrom, dateTo, customerCIF, agentFilter, limit)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		jsonRows(w, rows)
	}
}

// hdSupervisor returns a live snapshot of agent load and queue health for the supervisor view.
func hdSupervisor(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		// Queue depth / unassigned / active agents are live "right now" figures — they
		// must reflect all currently-open tickets, not only those created in a date
		// window (the date range drives the time-bounded stats via /helpdesk/stats).
		totals, _ := db.PGQuery(ctx, `
			SELECT
			  COUNT(*) FILTER (WHERE status NOT IN ('closed','resolved'))                               AS open,
			  COUNT(*) FILTER (WHERE status NOT IN ('closed','resolved') AND sla_due_at < NOW())        AS sla_breached,
			  COUNT(*) FILTER (WHERE status NOT IN ('closed','resolved') AND assigned_to IS NULL)       AS unassigned,
			  COUNT(DISTINCT assigned_to) FILTER (WHERE status NOT IN ('closed','resolved')
			    AND assigned_to IS NOT NULL)                                                             AS active_agents
			FROM helpdesk_tickets
			WHERE channel IS NULL OR channel NOT IN ('email','call')`)

		// The full live wallboard: every active call-center agent with today's call
		// activity (matched by name) alongside their live ticket load + status.
		agents, _ := db.PGQuery(ctx, `
			SELECT
			  u.id,
			  u.full_name,
			  COALESCE(u.helpdesk_status, 'available')                                   AS helpdesk_status,
			  COUNT(t.id) FILTER (WHERE t.status NOT IN ('closed','resolved')
			    AND (t.channel IS NULL OR t.channel NOT IN ('email','call')))            AS open_tickets,
			  COUNT(t.id) FILTER (WHERE t.status NOT IN ('closed','resolved')
			    AND (t.channel IS NULL OR t.channel NOT IN ('email','call'))
			    AND t.sla_due_at < NOW())                                                AS sla_breached,
			  COALESCE(MAX(cc.calls_today), 0)                                           AS calls_today,
			  COALESCE(MAX(cc.connected_today), 0)                                       AS connected_today,
			  COALESCE(MAX(cc.avg_talk_sec), 0)                                          AS avg_talk_sec,
			  MAX(m.created_at)                                                          AS last_reply,
			  MAX(qa.avg_score)                                                          AS qa_avg_score,
			  COALESCE(MAX(qa.evals), 0)                                                 AS qa_evals
			FROM o3c_users u
			LEFT JOIN helpdesk_tickets t  ON t.assigned_to = u.id
			LEFT JOIN helpdesk_messages m ON m.ticket_id = t.id AND m.direction = 'outbound' AND m.author_user_id = u.id
			LEFT JOIN (
			  SELECT agent_name,
			         COUNT(*)                                                                                  AS calls_today,
			         COUNT(*) FILTER (WHERE COALESCE(outcome,'') NOT IN ('missed','no_answer','voicemail','')) AS connected_today,
			         ROUND(AVG(duration_sec))::int                                                             AS avg_talk_sec
			  FROM helpdesk_calls WHERE started_at::date = CURRENT_DATE GROUP BY agent_name
			) cc ON cc.agent_name = u.full_name
			LEFT JOIN (
			  SELECT agent_id, ROUND(AVG(total_score),1) AS avg_score, COUNT(*)::int AS evals
			  FROM qa_evaluations WHERE agent_id IS NOT NULL GROUP BY agent_id
			) qa ON qa.agent_id = u.id
			WHERE u.deleted_at IS NULL AND u.is_active = TRUE
			  AND u.role IN ('call_center_agent','call_center_head')
			GROUP BY u.id, u.full_name, u.helpdesk_status
			ORDER BY calls_today DESC, open_tickets DESC, u.full_name`)

		queues, _ := db.PGQuery(ctx, `
			SELECT
			  COALESCE(queue, 'general')                                                  AS queue,
			  COUNT(*) FILTER (WHERE status NOT IN ('closed','resolved'))                AS open,
			  COUNT(*) FILTER (WHERE status NOT IN ('closed','resolved')
			    AND sla_due_at < NOW())                                                   AS sla_breached,
			  COUNT(*) FILTER (WHERE status NOT IN ('closed','resolved')
			    AND assigned_to IS NULL)                                                  AS unassigned
			FROM helpdesk_tickets
			GROUP BY COALESCE(queue, 'general')
			ORDER BY open DESC`)

		recentBreaches, _ := db.PGQuery(ctx, `
			SELECT t.id, t.ticket_ref, t.subject, t.priority,
			       t.sla_due_at, t.created_at,
			       u.full_name AS assigned_to_name
			FROM helpdesk_tickets t
			LEFT JOIN o3c_users u ON u.id = t.assigned_to
			WHERE t.status NOT IN ('closed','resolved')
			  AND t.sla_due_at IS NOT NULL
			  AND t.sla_due_at < NOW()
			ORDER BY t.sla_due_at ASC
			LIMIT 10`)

		// Tickets by type (last 24h)
		byType, _ := db.PGQuery(ctx, `
			SELECT COALESCE(ticket_type,'general_inquiry') AS type, COUNT(*) AS n
			FROM helpdesk_tickets
			WHERE created_at > NOW() - INTERVAL '24 hours'
			GROUP BY 1`)

		// Tickets by hour (last 24h)
		hourly, _ := db.PGQuery(ctx, `
			SELECT EXTRACT(HOUR FROM created_at)::int AS hour, COUNT(*) AS n
			FROM helpdesk_tickets
			WHERE created_at > NOW() - INTERVAL '24 hours'
			GROUP BY 1 ORDER BY 1`)

		totalsRow := map[string]any{"open": 0, "sla_breached": 0, "unassigned": 0, "active_agents": 0}
		if len(totals) > 0 {
			totalsRow = totals[0]
		}
		if agents == nil {
			agents = []map[string]any{}
		}
		if queues == nil {
			queues = []map[string]any{}
		}
		if recentBreaches == nil {
			recentBreaches = []map[string]any{}
		}
		if byType == nil {
			byType = []map[string]any{}
		}
		if hourly == nil {
			hourly = []map[string]any{}
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"totals":          totalsRow,
			"agents":          agents,
			"queues":          queues,
			"recent_breaches": recentBreaches,
			"by_type":         byType,
			"hourly_queue":    hourly,
		})
	}
}

func hdCallStats(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureCallLogSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "Schema setup failed")
			return
		}
		ctx := r.Context()
		dateFrom := r.URL.Query().Get("date_from")
		dateTo := r.URL.Query().Get("date_to")
		agentFilter := r.URL.Query().Get("agent")
		directionFilter := r.URL.Query().Get("direction")
		outcomeFilter := r.URL.Query().Get("outcome")

		// Shared filter so the KPI strip, charts and the log table all move together.
		// direction/outcome accept comma-separated multi-select; %-values in the
		// ILIKE are literal (fmt.Sprintf only reads verbs in the template, not args).
		filter := `($1 = '' OR started_at::date >= $1::date)
			  AND ($2 = '' OR started_at::date <= $2::date)
			  AND ($3 = '' OR agent_name ILIKE '%' || $3 || '%')` +
			sqlInLower("direction", directionFilter) + sqlInLower("outcome", outcomeFilter)
		fargs := []any{dateFrom, dateTo, agentFilter}

		// Outcome vocabulary varies by source (Zoho uses missed/completed; the live
		// AT flow used no_answer/voicemail/resolved). Treat any of the "no contact"
		// outcomes as missed and everything else as connected.
		summary, _ := db.PGQuery(ctx, fmt.Sprintf(`
			SELECT
			  COUNT(*)                                                       AS total,
			  COUNT(*) FILTER (WHERE direction='inbound')                   AS inbound,
			  COUNT(*) FILTER (WHERE direction='outbound')                  AS outbound,
			  COUNT(*) FILTER (WHERE outcome IN ('missed','no_answer','voicemail')) AS missed,
			  COUNT(*) FILTER (WHERE COALESCE(outcome,'') NOT IN ('missed','no_answer','voicemail','')) AS connected,
			  COUNT(*) FILTER (WHERE direction='inbound'  AND COALESCE(outcome,'') NOT IN ('missed','no_answer','voicemail','')) AS inbound_connected,
			  COUNT(*) FILTER (WHERE direction='outbound' AND COALESCE(outcome,'') NOT IN ('missed','no_answer','voicemail','')) AS outbound_connected,
			  COUNT(*) FILTER (WHERE outcome IN ('resolved','completed'))   AS resolved,
			  -- Talk time & averages over CONNECTED calls only, with a 4h sanity cap:
			  -- a handful of imported calls carry corrupt durations (up to ~204 days)
			  -- that otherwise blow up the average. connected+bounded keeps it real.
			  COALESCE(SUM(duration_sec) FILTER (WHERE COALESCE(outcome,'') NOT IN ('missed','no_answer','voicemail','') AND duration_sec BETWEEN 0 AND 14400),0)::bigint AS total_talk_sec,
			  COUNT(DISTINCT NULLIF(agent_name,''))                         AS agents,
			  ROUND(AVG(duration_sec) FILTER (WHERE COALESCE(outcome,'') NOT IN ('missed','no_answer','voicemail','') AND duration_sec BETWEEN 0 AND 14400))::int AS avg_duration_sec,
			  ROUND(AVG(duration_sec) FILTER (WHERE direction='inbound'  AND COALESCE(outcome,'') NOT IN ('missed','no_answer','voicemail','') AND duration_sec BETWEEN 0 AND 14400))::int  AS avg_inbound_sec,
			  ROUND(AVG(duration_sec) FILTER (WHERE direction='outbound' AND COALESCE(outcome,'') NOT IN ('missed','no_answer','voicemail','') AND duration_sec BETWEEN 0 AND 14400))::int AS avg_outbound_sec,
			  COUNT(DISTINCT NULLIF(customer_phone,''))::int AS unique_customers
			FROM helpdesk_calls
			WHERE %s`, filter), fargs...)

		byOutcome, _ := db.PGQuery(ctx, fmt.Sprintf(`
			SELECT outcome, COUNT(*) AS count
			FROM helpdesk_calls
			WHERE %s
			GROUP BY outcome ORDER BY count DESC`, filter), fargs...)

		byDay, _ := db.PGQuery(ctx, fmt.Sprintf(`
			SELECT started_at::date AS day,
			       COUNT(*) AS total,
			       COUNT(*) FILTER (WHERE direction='inbound')  AS inbound,
			       COUNT(*) FILTER (WHERE direction='outbound') AS outbound,
			       COUNT(*) FILTER (WHERE COALESCE(outcome,'') NOT IN ('missed','no_answer','voicemail','')) AS connected
			FROM helpdesk_calls
			WHERE %s
			GROUP BY day ORDER BY day`, filter), fargs...)

		byAgent, _ := db.PGQuery(ctx, fmt.Sprintf(`
			SELECT agent_name,
			       COUNT(*) AS total,
			       COUNT(*) FILTER (WHERE direction='inbound')  AS inbound,
			       COUNT(*) FILTER (WHERE direction='outbound') AS outbound,
			       COUNT(*) FILTER (WHERE COALESCE(outcome,'') NOT IN ('missed','no_answer','voicemail','')) AS connected,
			       COUNT(*) FILTER (WHERE outcome IN ('missed','no_answer','voicemail')) AS missed,
			       ROUND(AVG(duration_sec) FILTER (WHERE COALESCE(outcome,'') NOT IN ('missed','no_answer','voicemail','') AND duration_sec BETWEEN 0 AND 14400))::int AS avg_duration_sec,
			       (SELECT ROUND(AVG(q.total_score),1) FROM qa_evaluations q WHERE q.agent_name = helpdesk_calls.agent_name) AS qa_avg,
			       (SELECT COUNT(*) FROM qa_evaluations q WHERE q.agent_name = helpdesk_calls.agent_name)::int AS qa_evals
			FROM helpdesk_calls
			WHERE %s
			GROUP BY agent_name ORDER BY total DESC`, filter), fargs...)

		byHour, _ := db.PGQuery(ctx, fmt.Sprintf(`
			SELECT EXTRACT(HOUR FROM started_at)::int AS hour,
			       COUNT(*)                                     AS total,
			       COUNT(*) FILTER (WHERE direction='inbound')  AS inbound,
			       COUNT(*) FILTER (WHERE direction='outbound') AS outbound
			FROM helpdesk_calls
			WHERE %s
			GROUP BY hour ORDER BY hour`, filter), fargs...)

		// Talk-time distribution over connected calls — a call-length profile the
		// Overview doesn't surface.
		talkDist, _ := db.PGQuery(ctx, fmt.Sprintf(`
			SELECT bucket, COUNT(*) AS count FROM (
			  SELECT CASE
			    WHEN duration_sec < 30  THEN '<30s'
			    WHEN duration_sec < 120 THEN '30s-2m'
			    WHEN duration_sec < 300 THEN '2-5m'
			    ELSE '5m+' END AS bucket,
			    CASE WHEN duration_sec < 30 THEN 1 WHEN duration_sec < 120 THEN 2 WHEN duration_sec < 300 THEN 3 ELSE 4 END AS ord
			  FROM helpdesk_calls
			  WHERE %s AND COALESCE(outcome,'') NOT IN ('missed','no_answer','voicemail','') AND duration_sec BETWEEN 0 AND 14400
			) t GROUP BY bucket, ord ORDER BY ord`, filter), fargs...)

		summaryRow := map[string]any{"total": 0, "inbound": 0, "outbound": 0, "missed": 0, "connected": 0, "inbound_connected": 0, "outbound_connected": 0, "resolved": 0, "total_talk_sec": 0, "agents": 0, "avg_duration_sec": nil, "avg_inbound_sec": nil, "avg_outbound_sec": nil, "unique_customers": 0}
		if len(summary) > 0 {
			summaryRow = summary[0]
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"summary":           summaryRow,
			"by_outcome":        byOutcome,
			"by_day":            byDay,
			"by_agent":          byAgent,
			"by_hour":           byHour,
			"talk_distribution": talkDist,
		})
	}
}

// ── Knowledge Base ─────────────────────────────────────────────────────────────

// kbCanonicalStatus normalises a display status ("Live", "Pending Approval", …)
// to the value stored in kb_status.
func kbCanonicalStatus(s string) string {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "live", "published":
		return "live"
	case "pending", "pending approval":
		return "pending"
	case "archived":
		return "archived"
	default:
		return "draft"
	}
}

func ensureKBSchema(ctx context.Context, db *core.DB) error {
	_, err := db.PGExec(ctx, `
		CREATE TABLE IF NOT EXISTS helpdesk_knowledge_base (
			id          BIGSERIAL PRIMARY KEY,
			title       TEXT NOT NULL,
			slug        TEXT UNIQUE NOT NULL,
			category    TEXT NOT NULL DEFAULT '',
			body_html   TEXT NOT NULL DEFAULT '',
			body_text   TEXT NOT NULL DEFAULT '',
			tags        TEXT[] DEFAULT '{}',
			is_public   BOOL DEFAULT false,
			view_count  INT DEFAULT 0,
			created_by  BIGINT,
			updated_by  BIGINT,
			created_at  TIMESTAMPTZ DEFAULT NOW(),
			updated_at  TIMESTAMPTZ DEFAULT NOW()
		);
		CREATE INDEX IF NOT EXISTS idx_hkb_fts ON helpdesk_knowledge_base
			USING GIN (to_tsvector('english', title || ' ' || body_text));
		CREATE INDEX IF NOT EXISTS idx_hkb_category ON helpdesk_knowledge_base (category);
	`)
	return err
}

func hdKBList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureKBSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "Schema setup failed")
			return
		}
		ctx := r.Context()
		category := r.URL.Query().Get("category")
		search := r.URL.Query().Get("search")

		q := `SELECT kb.id, kb.title, kb.category,
		             CASE kb.kb_status
		                  WHEN 'pending'  THEN 'Pending Approval'
		                  WHEN 'live'     THEN 'Live'
		                  WHEN 'archived' THEN 'Archived'
		                  ELSE 'Draft' END AS status,
		             CASE WHEN (kb.helpful_count + kb.not_helpful_count) > 0
		                  THEN ROUND(100.0 * kb.helpful_count / (kb.helpful_count + kb.not_helpful_count))
		                  ELSE NULL END AS helpful_pct,
		             kb.helpful_count, kb.not_helpful_count,
		             kb.body_text AS body,
		             kb.updated_at AS last_updated,
		             COALESCE(u.full_name, 'Unknown') AS created_by,
		             kb.view_count
		      FROM helpdesk_knowledge_base kb
		      LEFT JOIN o3c_users u ON u.id = kb.created_by
		      WHERE TRUE`
		args := []any{}
		n := 1
		if category != "" {
			q += fmt.Sprintf(" AND kb.category=$%d", n)
			args = append(args, category)
			n++
		}
		if search != "" {
			q += fmt.Sprintf(" AND (kb.title ILIKE $%d OR kb.body_text ILIKE $%d)", n, n)
			args = append(args, "%"+search+"%")
			n++
		}
		q += " ORDER BY kb.updated_at DESC LIMIT 200"
		_ = n

		rows, _ := db.PGQuery(ctx, q, args...)
		if rows == nil {
			rows = []core.Row{}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows) //nolint:errcheck
	}
}

func hdKBCreate(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureKBSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "Schema setup failed")
			return
		}
		var b struct {
			Title    string   `json:"title"`
			Slug     string   `json:"slug"`
			Category string   `json:"category"`
			BodyHTML string   `json:"body_html"`
			BodyText string   `json:"body_text"`
			Body     string   `json:"body"` // alias accepted from frontend
			Tags     []string `json:"tags"`
			IsPublic bool     `json:"is_public"`
			Status   string   `json:"status"` // "Live" → is_public=true
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil || b.Title == "" {
			respondErr(w, 400, "title required")
			return
		}
		// Accept body as alias for body_text
		if b.BodyText == "" && b.Body != "" {
			b.BodyText = b.Body
		}
		// Status drives the approval lifecycle; only 'live' is publicly visible.
		kbStatus := kbCanonicalStatus(b.Status)
		if b.IsPublic || kbStatus == "live" {
			kbStatus = "live"
			b.IsPublic = true
		}
		if b.Slug == "" {
			b.Slug = strings.ToLower(strings.ReplaceAll(b.Title, " ", "-"))
		}
		tags := b.Tags
		if tags == nil {
			tags = []string{}
		}
		uid := func() int64 {
			if u := core.UserFromCtx(r.Context()); u != nil {
				return u.ID
			}
			return 0
		}()
		ctx := r.Context()
		rows, err := db.PGQuery(ctx, `
			INSERT INTO helpdesk_knowledge_base (title, slug, category, body_html, body_text, tags, is_public, kb_status, created_by, updated_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
			RETURNING id, title, slug, category, tags, is_public, kb_status, view_count, created_at, updated_at`,
			b.Title, b.Slug, b.Category, b.BodyHTML, b.BodyText, tags, b.IsPublic, kbStatus, uid)
		if err != nil {
			respondErr(w, 500, err.Error())
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		if len(rows) > 0 {
			json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
		}
	}
}

func hdKBSearch(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureKBSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "Schema setup failed")
			return
		}
		q := r.URL.Query().Get("q")
		if q == "" {
			respondErr(w, 400, "q required")
			return
		}
		ctx := r.Context()
		rows, _ := db.PGQuery(ctx, `
			SELECT id, title, slug, category, tags, is_public, view_count,
			       ts_rank(to_tsvector('english', title||' '||body_text), plainto_tsquery('english',$1)) AS rank
			FROM helpdesk_knowledge_base
			WHERE to_tsvector('english', title||' '||body_text) @@ plainto_tsquery('english',$1)
			ORDER BY rank DESC LIMIT 20`, q)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows) //nolint:errcheck
	}
}

func hdKBGet(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureKBSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "Schema setup failed")
			return
		}
		id := chi.URLParam(r, "id")
		ctx := r.Context()
		rows, err := db.PGQuery(ctx,
			`SELECT id, title, slug, category, body_html, body_text, tags, is_public, view_count, created_at, updated_at
			 FROM helpdesk_knowledge_base WHERE id=$1`, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "not found")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func hdKBIncView(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureKBSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "Schema setup failed")
			return
		}
		id := chi.URLParam(r, "id")
		db.PGExec(r.Context(), `UPDATE helpdesk_knowledge_base SET view_count=view_count+1 WHERE id=$1`, id) //nolint:errcheck
		w.WriteHeader(204)
	}
}

func hdKBUpdate(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureKBSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "Schema setup failed")
			return
		}
		id := chi.URLParam(r, "id")
		var b struct {
			Title    *string  `json:"title"`
			Category *string  `json:"category"`
			BodyHTML *string  `json:"body_html"`
			BodyText *string  `json:"body_text"`
			Body     *string  `json:"body"` // alias accepted from frontend
			Tags     []string `json:"tags"`
			IsPublic *bool    `json:"is_public"`
			Status   *string  `json:"status"` // "Live" → is_public=true
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "invalid json")
			return
		}
		// Accept body as alias for body_text
		if b.BodyText == nil && b.Body != nil {
			b.BodyText = b.Body
		}
		// Status drives the approval lifecycle; keep is_public in sync (only 'live'
		// is publicly visible) unless the caller set is_public explicitly.
		var kbStatus *string
		if b.Status != nil {
			c := kbCanonicalStatus(*b.Status)
			kbStatus = &c
			if b.IsPublic == nil {
				pub := c == "live"
				b.IsPublic = &pub
			}
		}
		uid := func() int64 {
			if u := core.UserFromCtx(r.Context()); u != nil {
				return u.ID
			}
			return 0
		}()
		ctx := r.Context()
		q := "UPDATE helpdesk_knowledge_base SET updated_at=NOW(), updated_by=$1"
		args := []any{uid}
		n := 2
		add := func(col string, v any) {
			q += fmt.Sprintf(", %s=$%d", col, n)
			args = append(args, v)
			n++
		}
		if b.Title != nil {
			add("title", *b.Title)
		}
		if b.Category != nil {
			add("category", *b.Category)
		}
		if b.BodyHTML != nil {
			add("body_html", *b.BodyHTML)
		}
		if b.BodyText != nil {
			add("body_text", *b.BodyText)
		}
		if b.Tags != nil {
			add("tags", b.Tags)
		}
		if b.IsPublic != nil {
			add("is_public", *b.IsPublic)
		}
		if kbStatus != nil {
			add("kb_status", *kbStatus)
		}
		if n == 2 {
			respondErr(w, 400, "nothing to update")
			return
		}
		q += fmt.Sprintf(" WHERE id=$%d", n)
		args = append(args, id)
		if _, err := db.PGExec(ctx, q, args...); err != nil {
			respondErr(w, 500, err.Error())
			return
		}
		w.WriteHeader(204)
	}
}

func hdKBDelete(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureKBSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "Schema setup failed")
			return
		}
		id := chi.URLParam(r, "id")
		db.PGExec(r.Context(), `DELETE FROM helpdesk_knowledge_base WHERE id=$1`, id) //nolint:errcheck
		w.WriteHeader(204)
	}
}

// ── KB status shortcut ────────────────────────────────────────────────────────

func hdKBSetStatus(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureKBSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "Schema setup failed")
			return
		}
		id := chi.URLParam(r, "id")
		var b struct {
			Status string `json:"status"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil || b.Status == "" {
			respondErr(w, 400, "status required")
			return
		}
		kbStatus := kbCanonicalStatus(b.Status)
		isPublic := kbStatus == "live"
		// Publishing (live) or archiving is a privileged action — it puts content in
		// front of customers. Agents may only move an article to draft/pending; going
		// live must be approved by a head or compliance.
		if kbStatus == "live" || kbStatus == "archived" {
			caller := core.UserFromCtx(r.Context())
			privileged := map[string]bool{
				"call_center_head": true, "admin": true,
				"compliance_officer": true, "compliance_head": true,
			}
			if caller == nil || !privileged[caller.Role] {
				respondErr(w, 403, "Publishing requires a team head or compliance approval")
				return
			}
		}
		if _, err := db.PGExec(r.Context(),
			`UPDATE helpdesk_knowledge_base SET kb_status=$1, is_public=$2, updated_at=NOW() WHERE id=$3`,
			kbStatus, isPublic, id); err != nil {
			respondErr(w, 500, err.Error())
			return
		}
		w.WriteHeader(204)
	}
}

// ── Stats analytics endpoints ─────────────────────────────────────────────────

func hdListAgents(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, _ := db.PGQuery(r.Context(),
			`SELECT id, full_name FROM o3c_users WHERE deleted_at IS NULL AND is_active=TRUE ORDER BY full_name`)
		if rows == nil {
			rows = []core.Row{}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows) //nolint:errcheck
	}
}

func hdCSATTrend(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dateFrom := qstr(r, "date_from")
		dateTo := qstr(r, "date_to")
		agentID := qint(r, "agent_id", 0, 0, 2000000000)
		rows, _ := db.PGQuery(r.Context(), `
			SELECT TO_CHAR(created_at::date, 'YYYY-MM-DD') AS date,
			       ROUND(AVG(csat_score::numeric), 2) AS csat_score,
			       COUNT(*) AS ticket_count
			FROM helpdesk_tickets
			WHERE csat_score IS NOT NULL
			  AND ($1 = '' OR created_at::date >= $1::date)
			  AND ($2 = '' OR created_at::date <= $2::date)
			  AND ($3 = 0 OR assigned_to = $3)
			GROUP BY created_at::date
			ORDER BY created_at::date`, dateFrom, dateTo, agentID)
		if rows == nil {
			rows = []core.Row{}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": rows}) //nolint:errcheck
	}
}

func hdHandleTimeByType(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dateFrom := qstr(r, "date_from")
		dateTo := qstr(r, "date_to")
		agentID := qint(r, "agent_id", 0, 0, 2000000000)
		rows, _ := db.PGQuery(r.Context(), `
			SELECT COALESCE(ticket_type, 'General') AS ticket_type,
			       ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)) / 60))::int AS avg_minutes
			FROM helpdesk_tickets
			WHERE resolved_at IS NOT NULL
			  AND ($1 = '' OR created_at::date >= $1::date)
			  AND ($2 = '' OR created_at::date <= $2::date)
			  AND ($3 = 0 OR assigned_to = $3)
			GROUP BY ticket_type
			ORDER BY avg_minutes DESC`, dateFrom, dateTo, agentID)
		if rows == nil {
			rows = []core.Row{}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": rows}) //nolint:errcheck
	}
}

func hdResolutionByAgent(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dateFrom := qstr(r, "date_from")
		dateTo := qstr(r, "date_to")
		agentID := qint(r, "agent_id", 0, 0, 2000000000)
		rows, _ := db.PGQuery(r.Context(), `
			SELECT u.full_name AS agent_name,
			       ROUND(
			         100.0 * COUNT(*) FILTER (WHERE t.status IN ('resolved','closed'))
			         / NULLIF(COUNT(*), 0)
			       )::int AS resolution_pct
			FROM helpdesk_tickets t
			JOIN o3c_users u ON u.id = t.assigned_to
			WHERE t.assigned_to IS NOT NULL
			  AND ($1 = '' OR t.created_at::date >= $1::date)
			  AND ($2 = '' OR t.created_at::date <= $2::date)
			  AND ($3 = 0 OR t.assigned_to = $3)
			GROUP BY u.full_name
			HAVING COUNT(*) > 0
			ORDER BY resolution_pct DESC`, dateFrom, dateTo, agentID)
		if rows == nil {
			rows = []core.Row{}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": rows}) //nolint:errcheck
	}
}

func hdTypeDistribution(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dateFrom := qstr(r, "date_from")
		dateTo := qstr(r, "date_to")
		agentID := qint(r, "agent_id", 0, 0, 2000000000)
		rows, _ := db.PGQuery(r.Context(), `
			SELECT COALESCE(ticket_type, 'General') AS ticket_type,
			       COUNT(*) AS count
			FROM helpdesk_tickets
			WHERE ($1 = '' OR created_at::date >= $1::date)
			  AND ($2 = '' OR created_at::date <= $2::date)
			  AND ($3 = 0 OR assigned_to = $3)
			GROUP BY ticket_type
			ORDER BY count DESC`, dateFrom, dateTo, agentID)
		if rows == nil {
			rows = []core.Row{}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": rows}) //nolint:errcheck
	}
}

// ── Inbound Call → Auto-Ticket (Zoho Voice webhook) ──────────────────────────

// hdTicketCalls returns the phone-call history for a ticket's customer, matched by
// CIF or by the last 10 digits of the phone. Zoho provides no call↔ticket id (the
// call payload's ticketId is null and helpdesk_calls.ticket_id is empty across the
// board), so we link by customer instead of a brittle per-call guess — the panel
// shows every call behind the ticket's customer, newest first.
func hdTicketCalls(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		rows, err := db.PGQuery(r.Context(), `
			WITH t AS (
			  SELECT COALESCE(customer_cif,'') AS cif,
			         right(regexp_replace(COALESCE(customer_phone,''),'\D','','g'),10) AS np
			  FROM helpdesk_tickets WHERE id=$1
			)
			SELECT hc.id,
			       COALESCE(hc.started_at, hc.created_at)               AS called_at,
			       COALESCE(hc.duration_sec,0)                          AS duration_sec,
			       COALESCE(NULLIF(hc.outcome,''),'Call')               AS outcome,
			       COALESCE(NULLIF(hc.agent_name,''),'Unknown')         AS agent_name,
			       hc.direction                                         AS direction,
			       hc.purpose                                           AS purpose,
			       hc.recording_url                                     AS recording_url,
			       hc.notes                                             AS notes
			FROM helpdesk_calls hc, t
			WHERE (t.cif <> '' AND hc.customer_cif = t.cif)
			   OR (length(t.np) = 10
			       AND right(regexp_replace(COALESCE(hc.customer_phone,''),'\D','','g'),10) = t.np)
			ORDER BY called_at DESC NULLS LAST
			LIMIT 50`, id)
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

func hdInboundCall(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Accept our internal format AND Zoho Desk's native call-center webhook format.
		// Zoho sends: callerNumber / callerId, callId / id, agentId / agentName, queueName / queue.
		var raw map[string]any
		if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
			respondErr(w, 400, "invalid json")
			return
		}

		pick := func(keys ...string) string {
			for _, k := range keys {
				if v, ok := raw[k]; ok {
					if s, ok := v.(string); ok && s != "" {
						return s
					}
				}
			}
			return ""
		}
		pickInt := func(keys ...string) int64 {
			for _, k := range keys {
				if v, ok := raw[k]; ok {
					switch n := v.(type) {
					case float64:
						return int64(n)
					case string:
						if n != "" {
							var i int64
							if _, err := fmt.Sscan(n, &i); err == nil {
								return i
							}
						}
					}
				}
			}
			return 0
		}

		phone := pick("phone", "callerNumber", "caller_number", "callerId", "from")
		callID := pick("call_id", "callId", "id")
		agentName := pick("agent_name", "agentName")
		queueName := pick("queue_name", "queueName", "queue")
		agentID := pickInt("agent_id", "agentId")

		if phone == "" {
			respondErr(w, 400, "phone required")
			return
		}
		ctx := r.Context()

		// Determine queue from routing rules (default: general)
		queue := "general"
		if queueName != "" {
			queue = queueName
		}

		// Auto-create ticket
		subject := "Inbound Call — " + phone
		body := "Auto-created from inbound call. Caller: " + phone
		if callID != "" {
			body += ". Call ID: " + callID
		}

		if agentID != 0 {
			rows, _ := db.PGQuery(ctx, `SELECT id FROM o3c_users WHERE id=$1 AND is_active=TRUE`, agentID)
			if len(rows) == 0 {
				agentID = 0 // fall back to unassigned
			}
		}
		assignedTo := (*int64)(nil)
		if agentID != 0 {
			assignedTo = &agentID
		}
		_ = agentName

		// channel='call' (not 'phone') so inbound-call tickets match the Zoho ticket
		// mapper (phone→call) and are routed as call activity — kept OUT of the
		// written-support Ticket Queue, which excludes channel IN ('email','call').
		rows, err := db.PGQuery(ctx, `
			INSERT INTO helpdesk_tickets
			  (subject, description, channel, status, priority, queue, ticket_type, assigned_to)
			VALUES ($1, $2, 'call', 'open', 'normal', $3, 'inbound_call', $4)
			RETURNING id, subject, status, queue, ticket_type, created_at`,
			subject, body, queue, assignedTo)
		if err != nil {
			slog.Error("inbound call ticket creation failed", "err", err)
			respondErr(w, 500, "failed to create ticket")
			return
		}

		// Push real-time SSE notification so the call widget shows a ringing alert.
		if len(rows) > 0 {
			ticketID := toInt64(rows[0]["id"])
			bgCtx := context.Background()
			if agentID != 0 {
				go sendNotification(bgCtx, db, agentID, "inbound_call",
					"Incoming Call", "Caller: "+phone, "ticket", ticketID)
			} else {
				// No specific agent — ring all active call center staff.
				go func() {
					agentRows, _ := db.PGQuery(bgCtx, `
						SELECT id FROM o3c_users
						WHERE role IN ('call_center_agent','call_center_head') AND is_active=TRUE`)
					for _, ar := range agentRows {
						if uid := toInt64(ar["id"]); uid > 0 {
							sendNotification(bgCtx, db, uid, "inbound_call",
								"Incoming Call", "Caller: "+phone, "ticket", ticketID)
						}
					}
				}()
			}
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		if len(rows) > 0 {
			json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
		}
	}
}

// ── Ticket enriched context ───────────────────────────────────────────────────

// hdTicketContext returns live customer data from the c360 tables for the
// right-panel context in TicketDetail. It enriches the basic customer_context
// with loans, FD holdings, recent transactions, and collections history.
func hdTicketContext(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		id := chi.URLParam(r, "id")

		// Fetch ticket to get CIF
		tickets, err := db.PGQuery(ctx,
			`SELECT customer_cif, customer_name, customer_email, customer_phone FROM helpdesk_tickets WHERE id=$1`, id)
		if err != nil || len(tickets) == 0 {
			respondErr(w, 404, "ticket not found")
			return
		}
		cif := str(tickets[0]["customer_cif"])
		phone := str(tickets[0]["customer_phone"])
		email := str(tickets[0]["customer_email"])

		// Most imported tickets carry no CIF. Resolve one from the phone (last 10
		// digits) or email against the canonical customer base so the context tabs
		// light up and can deep-link to the customer profile.
		resolved := false
		if cif == "" && phone != "" {
			if rr, _ := db.PGQuery(ctx,
				`SELECT cif FROM app.customers
				 WHERE length(right(regexp_replace(COALESCE(phone,''),'\D','','g'),10))=10
				   AND right(regexp_replace(COALESCE(phone,''),'\D','','g'),10) = right(regexp_replace($1,'\D','','g'),10)
				 LIMIT 1`, phone); len(rr) > 0 {
				cif = str(rr[0]["cif"])
				resolved = cif != ""
			}
		}
		if cif == "" && email != "" {
			if rr, _ := db.PGQuery(ctx,
				`SELECT cif FROM app.customers WHERE COALESCE(email,'')<>'' AND lower(email)=lower($1) LIMIT 1`, email); len(rr) > 0 {
				cif = str(rr[0]["cif"])
				resolved = cif != ""
			}
		}

		out := map[string]any{
			"customer_name":  tickets[0]["customer_name"],
			"customer_email": email,
			"customer_phone": phone,
			"cif":            cif,
			"cif_resolved":   resolved,
		}

		if cif == "" {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(out) //nolint:errcheck
			return
		}

		// Loans
		loans, _ := db.PGQuery(ctx, `
			SELECT loan_ref, product_type, stage AS status,
			       amount_approved_kobo, total_outstanding_kobo,
			       dpd, next_repayment_date, created_at
			FROM loan_applications
			WHERE applicant_cif=$1 AND stage NOT IN ('cancelled')
			ORDER BY created_at DESC LIMIT 5`, cif)
		if loans == nil {
			loans = []core.Row{}
		}

		// Fixed deposits
		fds, _ := db.PGQuery(ctx, `
			SELECT id, principal_kobo, interest_rate, tenor_days,
			       maturity_date, status, created_at
			FROM fixed_deposits
			WHERE customer_cif=$1
			ORDER BY created_at DESC LIMIT 5`, cif)
		if fds == nil {
			fds = []core.Row{}
		}

		// Recent transactions (PG cache or MSSQL-sourced)
		txns, _ := db.PGQuery(ctx, `
			SELECT transaction_date, description, amount_kobo, transaction_type, balance_kobo
			FROM customer_transactions
			WHERE cif_number=$1
			ORDER BY transaction_date DESC LIMIT 5`, cif)
		if txns == nil {
			txns = []core.Row{}
		}

		// Collections history
		collections, _ := db.PGQuery(ctx, `
			SELECT cc.promise_date, cc.promise_amount_kobo, cc.status AS ptp_status,
			       cc.created_at
			FROM collection_contacts cc
			WHERE cc.cif_number=$1
			ORDER BY cc.created_at DESC LIMIT 5`, cif)
		if collections == nil {
			collections = []core.Row{}
		}

		// Open tickets count
		openCount := int64(0)
		if rows, _ := db.PGQuery(ctx,
			`SELECT COUNT(*) AS n FROM helpdesk_tickets WHERE customer_cif=$1 AND status NOT IN ('resolved','closed') AND id!=$2`,
			cif, id); len(rows) > 0 {
			openCount = toInt64(rows[0]["n"])
		}

		// Cards / products (MSSQL preferred, PG fallback)
		cards, _, _ := db.DualQuery(ctx,
			`SELECT product_name AS product_name, status AS account_status, name_on_card AS name_on_card, NULL AS account_manager FROM app.accounts WHERE cif = $1`,
			cif)
		if cards == nil {
			cards = []core.Row{}
		}

		out["loans"] = loans
		out["fixed_deposits"] = fds
		out["recent_transactions"] = txns
		out["collections_history"] = collections
		out["other_open_tickets"] = openCount
		out["cards"] = cards

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(out) //nolint:errcheck
	}
}

// ── KB article feedback ───────────────────────────────────────────────────────

func ensureKBFeedbackSchema(ctx context.Context, db *core.DB) {
	db.PGExec(ctx, `ALTER TABLE helpdesk_knowledge_base ADD COLUMN IF NOT EXISTS helpful_count INT NOT NULL DEFAULT 0`)     //nolint:errcheck
	db.PGExec(ctx, `ALTER TABLE helpdesk_knowledge_base ADD COLUMN IF NOT EXISTS not_helpful_count INT NOT NULL DEFAULT 0`) //nolint:errcheck
	db.PGExec(ctx, `ALTER TABLE helpdesk_knowledge_base ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1`)           //nolint:errcheck
	db.PGExec(ctx, `ALTER TABLE helpdesk_knowledge_base ADD COLUMN IF NOT EXISTS approved_by BIGINT`)                       //nolint:errcheck
	db.PGExec(ctx, `ALTER TABLE helpdesk_knowledge_base ADD COLUMN IF NOT EXISTS kb_status TEXT NOT NULL DEFAULT 'draft'`)  //nolint:errcheck
}

func hdKBFeedback(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureKBSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "Schema setup failed")
			return
		}

		id := chi.URLParam(r, "id")
		var b struct {
			Helpful bool `json:"helpful"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "invalid json")
			return
		}
		col := "not_helpful_count"
		if b.Helpful {
			col = "helpful_count"
		}
		if _, err := db.PGExec(r.Context(),
			fmt.Sprintf(`UPDATE helpdesk_knowledge_base SET %s=%s+1, updated_at=NOW() WHERE id=$1`, col, col),
			id); err != nil {
			respondErr(w, 500, err.Error())
			return
		}
		w.WriteHeader(204)
	}
}

// hdKBApprove allows a compliance officer/head to approve a KB article for publication.
// Sets is_public=true, kb_status='live', approved_by=current_user, version+=1.
func hdKBApprove(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		if user.Role != "compliance_officer" && user.Role != "compliance_head" && user.Role != "admin" {
			respondErr(w, 403, "Only compliance officers can approve KB articles")
			return
		}
		id := chi.URLParam(r, "id")
		rows, err := db.PGQuery(r.Context(),
			`UPDATE helpdesk_knowledge_base
			 SET is_public=true, kb_status='live', approved_by=$1, version=version+1, updated_at=NOW()
			 WHERE id=$2
			 RETURNING id, title, version, kb_status`,
			user.ID, id)
		if err != nil {
			respondErr(w, 500, "Approve failed")
			return
		}
		if len(rows) == 0 {
			respondErr(w, 404, "Article not found")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true, "article": rows[0]}) //nolint:errcheck
	}
}

// ── Extended stats analytics ──────────────────────────────────────────────────

func hdStatsLeaderboard(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dateFrom := qstr(r, "date_from")
		dateTo := qstr(r, "date_to")
		agentID := qint(r, "agent_id", 0, 0, 2000000000)
		rows, _ := db.PGQuery(r.Context(), `
			SELECT u.full_name AS agent_name,
			       COUNT(t.id)                                                                           AS tickets_handled,
			       COUNT(t.id) FILTER (WHERE t.status IN ('resolved','closed'))                         AS tickets_resolved,
			       ROUND(AVG(t.csat_score::numeric) FILTER (WHERE t.csat_score IS NOT NULL), 1)         AS avg_csat,
			       ROUND(AVG(EXTRACT(EPOCH FROM (t.resolved_at - t.created_at))/60)
			             FILTER (WHERE t.resolved_at IS NOT NULL))::int                                  AS avg_handle_min,
			       COUNT(t.id) FILTER (WHERE t.sla_due_at IS NOT NULL AND t.resolved_at > t.sla_due_at) AS sla_breaches
			FROM helpdesk_tickets t
			JOIN o3c_users u ON u.id = t.assigned_to
			WHERE t.assigned_to IS NOT NULL
			  AND ($1 = '' OR t.created_at::date >= $1::date)
			  AND ($2 = '' OR t.created_at::date <= $2::date)
			  AND ($3 = 0 OR t.assigned_to = $3)
			GROUP BY u.full_name
			HAVING COUNT(t.id) > 0
			ORDER BY tickets_resolved DESC, avg_csat DESC NULLS LAST`, dateFrom, dateTo, agentID)
		if rows == nil {
			rows = []core.Row{}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": rows}) //nolint:errcheck
	}
}

func hdStatsSLAByAgent(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dateFrom := qstr(r, "date_from")
		dateTo := qstr(r, "date_to")
		agentID := qint(r, "agent_id", 0, 0, 2000000000)
		rows, _ := db.PGQuery(r.Context(), `
			SELECT u.full_name AS agent_name,
			       COUNT(t.id) AS total,
			       COUNT(t.id) FILTER (WHERE t.sla_due_at IS NOT NULL
			         AND (t.resolved_at > t.sla_due_at OR (t.resolved_at IS NULL AND t.sla_due_at < NOW()))) AS breached,
			       ROUND(100.0 * COUNT(t.id) FILTER (WHERE t.sla_due_at IS NOT NULL
			         AND (t.resolved_at > t.sla_due_at OR (t.resolved_at IS NULL AND t.sla_due_at < NOW())))
			         / NULLIF(COUNT(t.id),0))::int AS breach_pct
			FROM helpdesk_tickets t
			JOIN o3c_users u ON u.id = t.assigned_to
			WHERE t.assigned_to IS NOT NULL
			  AND ($1 = '' OR t.created_at::date >= $1::date)
			  AND ($2 = '' OR t.created_at::date <= $2::date)
			  AND ($3 = 0 OR t.assigned_to = $3)
			GROUP BY u.full_name
			HAVING COUNT(t.id) > 0
			ORDER BY breach_pct DESC`, dateFrom, dateTo, agentID)
		if rows == nil {
			rows = []core.Row{}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": rows}) //nolint:errcheck
	}
}

func hdStatsBusiestHours(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dateFrom := qstr(r, "date_from")
		dateTo := qstr(r, "date_to")
		agentID := qint(r, "agent_id", 0, 0, 2000000000)
		rows, _ := db.PGQuery(r.Context(), `
			SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE 'Africa/Lagos')::int AS hour,
			       COUNT(*) AS ticket_count
			FROM helpdesk_tickets
			WHERE ($1 = '' OR created_at::date >= $1::date)
			  AND ($2 = '' OR created_at::date <= $2::date)
			  AND ($3 = 0 OR assigned_to = $3)
			GROUP BY hour
			ORDER BY hour`, dateFrom, dateTo, agentID)
		if rows == nil {
			rows = []core.Row{}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": rows}) //nolint:errcheck
	}
}

func hdStatsChannelBreakdown(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dateFrom := qstr(r, "date_from")
		dateTo := qstr(r, "date_to")
		agentID := qint(r, "agent_id", 0, 0, 2000000000)
		rows, _ := db.PGQuery(r.Context(), `
			SELECT COALESCE(channel, 'manual') AS channel,
			       COUNT(*) AS count
			FROM helpdesk_tickets
			WHERE ($1 = '' OR created_at::date >= $1::date)
			  AND ($2 = '' OR created_at::date <= $2::date)
			  AND ($3 = 0 OR assigned_to = $3)
			GROUP BY channel
			ORDER BY count DESC`, dateFrom, dateTo, agentID)
		if rows == nil {
			rows = []core.Row{}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": rows}) //nolint:errcheck
	}
}

// ── Agent helpdesk status ─────────────────────────────────────────────────────

// ── Call Center settings ──────────────────────────────────────────────────────

func ensureCCSettings(ctx context.Context, db *core.DB) {
	db.PGExec(ctx, `CREATE TABLE IF NOT EXISTS call_center_settings (key TEXT PRIMARY KEY, value TEXT)`) //nolint:errcheck
}

func ccSettingInt(ctx context.Context, db *core.DB, key string, def int) int {
	ensureCCSettings(ctx, db)
	if rows, _ := db.PGQuery(ctx, `SELECT value FROM call_center_settings WHERE key=$1`, key); len(rows) > 0 {
		if n, err := strconv.Atoi(str(rows[0]["value"])); err == nil && n > 0 {
			return n
		}
	}
	return def
}

func hdCCSettings(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		respond(w, map[string]any{"daily_call_target": ccSettingInt(r.Context(), db, "daily_call_target", 60)}, "cc")
	}
}

func hdSetCCSettings(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		caller := core.UserFromCtx(r.Context())
		if caller == nil || (caller.Role != "call_center_head" && caller.Role != "admin") {
			respondErr(w, 403, "Only supervisors can change call center settings")
			return
		}
		var b struct {
			DailyCallTarget *int `json:"daily_call_target"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		ensureCCSettings(r.Context(), db)
		if b.DailyCallTarget != nil && *b.DailyCallTarget > 0 {
			db.PGExec(r.Context(), //nolint:errcheck
				`INSERT INTO call_center_settings (key, value) VALUES ('daily_call_target', $1)
				 ON CONFLICT (key) DO UPDATE SET value = $1`, fmt.Sprint(*b.DailyCallTarget))
		}
		respond(w, map[string]any{"daily_call_target": ccSettingInt(r.Context(), db, "daily_call_target", 60)}, "cc")
	}
}

func hdSetAgentStatus(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Ensure column exists
		db.PGExec(r.Context(), `ALTER TABLE o3c_users ADD COLUMN IF NOT EXISTS helpdesk_status TEXT NOT NULL DEFAULT 'offline'`) //nolint:errcheck

		id := chi.URLParam(r, "id")
		var b struct {
			Status string `json:"status"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil || b.Status == "" {
			respondErr(w, 400, "status required")
			return
		}
		allowed := map[string]bool{"available": true, "on_call": true, "break": true, "offline": true}
		if !allowed[b.Status] {
			respondErr(w, 400, "status must be one of: available, on_call, break, offline")
			return
		}
		// Allow agent to set their own status; supervisors/admins can set anyone's
		caller := core.UserFromCtx(r.Context())
		if caller == nil {
			respondErr(w, 401, "unauthorized")
			return
		}
		callerIDStr := fmt.Sprintf("%d", caller.ID)
		if callerIDStr != id && caller.Role != "call_center_head" && caller.Role != "admin" {
			respondErr(w, 403, "forbidden")
			return
		}
		if _, err := db.PGExec(r.Context(),
			`UPDATE o3c_users SET helpdesk_status=$1 WHERE id=$2`, b.Status, id); err != nil {
			respondErr(w, 500, err.Error())
			return
		}
		w.WriteHeader(204)
	}
}

// ── Routing rules CRUD ────────────────────────────────────────────────────────

// ensureRoutingRulesSchema matches migration 038 which already created this table.
// The CREATE TABLE IF NOT EXISTS is a no-op when the table exists; kept for
// environments that might not have run the migration yet.
func ensureRoutingRulesSchema(ctx context.Context, db *core.DB) error {
	_, err := db.PGExec(ctx, `
		CREATE TABLE IF NOT EXISTS helpdesk_routing_rules (
			id          BIGSERIAL PRIMARY KEY,
			ticket_type TEXT,
			channel     TEXT,
			priority    TEXT,
			queue       TEXT NOT NULL,
			assign_to   BIGINT REFERENCES o3c_users(id),
			is_active   BOOLEAN NOT NULL DEFAULT TRUE,
			created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`)
	return err
}

func hdListRoutingRules(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureRoutingRulesSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "Schema setup failed")
			return
		}
		rows, _ := db.PGQuery(r.Context(),
			`SELECT id, ticket_type, channel, priority, queue, assign_to, is_active, created_at
			 FROM helpdesk_routing_rules ORDER BY id ASC`)
		if rows == nil {
			rows = []core.Row{}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows) //nolint:errcheck
	}
}

func hdCreateRoutingRule(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureRoutingRulesSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "Schema setup failed")
			return
		}
		var b struct {
			TicketType *string `json:"ticket_type"`
			Channel    *string `json:"channel"`
			Priority   *string `json:"priority"`
			Queue      string  `json:"queue"`
			AssignTo   *int64  `json:"assign_to"`
			IsActive   bool    `json:"is_active"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil || b.Queue == "" {
			respondErr(w, 400, "queue required")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO helpdesk_routing_rules (ticket_type, channel, priority, queue, assign_to, is_active)
			VALUES ($1,$2,$3,$4,$5,$6)
			RETURNING id, ticket_type, channel, priority, queue, assign_to, is_active, created_at`,
			b.TicketType, b.Channel, b.Priority, b.Queue, b.AssignTo, b.IsActive)
		if err != nil {
			respondErr(w, 500, err.Error())
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		if len(rows) > 0 {
			json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
		}
	}
}

func hdUpdateRoutingRule(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureRoutingRulesSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "Schema setup failed")
			return
		}
		id := chi.URLParam(r, "id")
		var b struct {
			TicketType *string `json:"ticket_type"`
			Channel    *string `json:"channel"`
			Priority   *string `json:"priority"`
			Queue      *string `json:"queue"`
			AssignTo   *int64  `json:"assign_to"`
			IsActive   *bool   `json:"is_active"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "invalid json")
			return
		}
		q := "UPDATE helpdesk_routing_rules SET id=id"
		args := []any{}
		n := 1
		add := func(col string, v any) {
			q += fmt.Sprintf(", %s=$%d", col, n)
			args = append(args, v)
			n++
		}
		if b.TicketType != nil {
			add("ticket_type", *b.TicketType)
		}
		if b.Channel != nil {
			add("channel", *b.Channel)
		}
		if b.Priority != nil {
			add("priority", *b.Priority)
		}
		if b.Queue != nil {
			add("queue", *b.Queue)
		}
		if b.AssignTo != nil {
			add("assign_to", *b.AssignTo)
		}
		if b.IsActive != nil {
			add("is_active", *b.IsActive)
		}
		if n == 1 {
			respondErr(w, 400, "nothing to update")
			return
		}
		q += fmt.Sprintf(" WHERE id=$%d", n)
		args = append(args, id)
		if _, err := db.PGExec(r.Context(), q, args...); err != nil {
			respondErr(w, 500, err.Error())
			return
		}
		w.WriteHeader(204)
	}
}

func hdDeleteRoutingRule(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		db.PGExec(r.Context(), `DELETE FROM helpdesk_routing_rules WHERE id=$1`, id) //nolint:errcheck
		w.WriteHeader(204)
	}
}

// hdMSGraphIngest polls the configured helpdesk inbox via Microsoft Graph for unread emails
// and creates or updates helpdesk tickets. Idempotent: marks each email read after processing.
// Requires MS_GRAPH_TENANT_ID, MS_GRAPH_CLIENT_ID, MS_GRAPH_CLIENT_SECRET, and
// HELPDESK_INBOX_ADDRESS to be set in api_credentials.
func hdMSGraphIngest(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		token, err := graphToken(ctx, db)
		if err != nil {
			respondErr(w, 503, "Microsoft Graph not configured: "+err.Error())
			return
		}

		inbox := resolveCredKey(ctx, db, "HELPDESK_INBOX_ADDRESS")
		if inbox == "" {
			respondErr(w, 503, "HELPDESK_INBOX_ADDRESS not configured")
			return
		}

		processed, skipped, newTickets := hdPollGraphInbox(ctx, db, token, inbox)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"ok":          true,
			"processed":   processed,
			"skipped":     skipped,
			"new_tickets": newTickets,
		})
	}
}

// hdPollGraphInbox fetches unread messages from the mailbox, creates/updates tickets,
// then marks each message as read. Returns (processed, skipped, new_ticket_count).
func hdPollGraphInbox(ctx context.Context, db *core.DB, token, mailbox string) (int, int, int) {
	// Fetch up to 50 unread messages; include internetMessageHeaders for In-Reply-To threading.
	endpoint := fmt.Sprintf(
		"https://graph.microsoft.com/v1.0/users/%s/mailFolders/Inbox/messages?$filter=isRead%%20eq%%20false&$top=50&$select=id,subject,from,body,receivedDateTime,internetMessageId,conversationId,internetMessageHeaders",
		mailbox)

	resp, err := httpGetBearer(endpoint, token, 30*time.Second)
	if err != nil {
		slog.Error("hdMSGraphIngest: fetch messages failed", "err", err)
		return 0, 0, 0
	}
	defer resp.Body.Close()

	var result struct {
		Value []struct {
			ID                string `json:"id"`
			Subject           string `json:"subject"`
			InternetMessageID string `json:"internetMessageId"`
			ConversationID    string `json:"conversationId"`
			ReceivedDateTime  string `json:"receivedDateTime"`
			From              struct {
				EmailAddress struct {
					Name    string `json:"name"`
					Address string `json:"address"`
				} `json:"emailAddress"`
			} `json:"from"`
			Body struct {
				ContentType string `json:"contentType"`
				Content     string `json:"content"`
			} `json:"body"`
			InternetMessageHeaders []struct {
				Name  string `json:"name"`
				Value string `json:"value"`
			} `json:"internetMessageHeaders"`
		} `json:"value"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		slog.Error("hdMSGraphIngest: decode failed", "err", err)
		return 0, 0, 0
	}

	processed, skipped, newTickets := 0, 0, 0
	for _, msg := range result.Value {
		senderEmail := msg.From.EmailAddress.Address
		senderName := msg.From.EmailAddress.Name
		if senderEmail == "" {
			skipped++
			continue
		}

		subject := msg.Subject
		if subject == "" {
			subject = "Inbound email from " + senderEmail
		}

		bodyText := msg.Body.Content
		if msg.Body.ContentType == "html" {
			// Strip HTML tags for plain text storage; keep HTML in body_html
		}

		// Extract In-Reply-To header for parent-thread matching.
		var inReplyTo string
		for _, h := range msg.InternetMessageHeaders {
			if strings.EqualFold(h.Name, "In-Reply-To") {
				inReplyTo = strings.Trim(h.Value, "<>")
				break
			}
		}

		var ticketID int64

		// 1. Match by In-Reply-To (the parent message's ID).
		if inReplyTo != "" {
			if rows, _ := db.PGQuery(ctx, `
				SELECT t.id FROM helpdesk_messages m
				JOIN helpdesk_tickets t ON m.ticket_id=t.id
				WHERE m.email_message_id=$1 LIMIT 1`, inReplyTo); len(rows) > 0 {
				ticketID = toInt64(rows[0]["id"])
			}
		}

		// 2. Fallback: match by this message's own internet message ID.
		if ticketID == 0 && msg.InternetMessageID != "" {
			if rows, _ := db.PGQuery(ctx, `
				SELECT t.id FROM helpdesk_messages m
				JOIN helpdesk_tickets t ON m.ticket_id=t.id
				WHERE m.email_message_id=$1 LIMIT 1`, msg.InternetMessageID); len(rows) > 0 {
				ticketID = toInt64(rows[0]["id"])
			}
		}

		// Match by sender email to most recent open ticket
		if ticketID == 0 {
			if rows, _ := db.PGQuery(ctx, `
				SELECT id FROM helpdesk_tickets
				WHERE customer_email=$1 AND status NOT IN ('resolved','closed')
				ORDER BY created_at DESC LIMIT 1`, senderEmail); len(rows) > 0 {
				ticketID = toInt64(rows[0]["id"])
			}
		}

		// Create new ticket
		if ticketID == 0 {
			rows, err := db.PGQuery(ctx, `
				INSERT INTO helpdesk_tickets
				    (channel, status, priority, subject, customer_name, customer_email, email_thread_id)
				VALUES ('email','open','normal',$1,$2,$3,$4)
				RETURNING id, ticket_ref`,
				subject, ptrOrNilStr(senderName), senderEmail, ptrOrNilStr(msg.ConversationID))
			if err != nil {
				slog.Error("hdMSGraphIngest: create ticket", "err", err, "from", senderEmail)
				skipped++
				continue
			}
			ticketID = toInt64(rows[0]["id"])
			hdRecordEvent(ctx, db, ticketID, 0, "created_inbound", "", str(rows[0]["ticket_ref"]))
			newTickets++
		}

		bodyHTML := ""
		if msg.Body.ContentType == "html" {
			bodyHTML = msg.Body.Content
		}

		db.PGExec(ctx, //nolint:errcheck
			`INSERT INTO helpdesk_messages
			    (ticket_id, direction, channel, author_name, body_text, body_html, email_message_id)
			VALUES ($1,'inbound','email',$2,$3,$4,NULLIF($5,''))`,
			ticketID, senderName, bodyText, bodyHTML, msg.InternetMessageID)

		db.PGExec(ctx, "UPDATE helpdesk_tickets SET updated_at=NOW() WHERE id=$1", ticketID) //nolint:errcheck

		// Mark message as read in Graph
		markEndpoint := fmt.Sprintf("https://graph.microsoft.com/v1.0/users/%s/messages/%s", mailbox, msg.ID)
		httpPatchBearer(markEndpoint, token, map[string]any{"isRead": true}) //nolint:errcheck

		processed++
	}

	slog.Info("hdMSGraphIngest: done", "processed", processed, "skipped", skipped, "new_tickets", newTickets)
	return processed, skipped, newTickets
}

// ── CBN Consumer Protection Report ──────────────────────────────────────────

func safeFirst(rows []map[string]any) map[string]any {
	if len(rows) > 0 {
		return rows[0]
	}
	return map[string]any{}
}

func hdCBNReport(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		from := r.URL.Query().Get("from")
		to := r.URL.Query().Get("to")
		if from == "" {
			from = time.Now().AddDate(0, -3, 0).Format("2006-01-02")
		}
		if to == "" {
			to = time.Now().Format("2006-01-02")
		}

		total, _ := db.PGQuery(ctx, `SELECT COUNT(*) AS n FROM helpdesk_tickets WHERE created_at::date BETWEEN $1 AND $2`, from, to)
		resolved, _ := db.PGQuery(ctx, `SELECT COUNT(*) AS n FROM helpdesk_tickets WHERE status IN ('resolved','closed') AND created_at::date BETWEEN $1 AND $2`, from, to)
		avgRes, _ := db.PGQuery(ctx, `SELECT ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))/3600)::numeric, 1) AS avg_hours FROM helpdesk_tickets WHERE resolved_at IS NOT NULL AND created_at::date BETWEEN $1 AND $2`, from, to)
		pastSLA, _ := db.PGQuery(ctx, `SELECT COUNT(*) AS n FROM helpdesk_tickets WHERE sla_breached=TRUE AND created_at::date BETWEEN $1 AND $2`, from, to)
		byType, _ := db.PGQuery(ctx, `SELECT COALESCE(ticket_type,'general_inquiry') AS type, COUNT(*) AS total, SUM(CASE WHEN status IN ('resolved','closed') THEN 1 ELSE 0 END) AS resolved FROM helpdesk_tickets WHERE created_at::date BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 2 DESC`, from, to)
		byChan, _ := db.PGQuery(ctx, `SELECT COALESCE(channel,'unknown') AS channel, COUNT(*) AS n FROM helpdesk_tickets WHERE created_at::date BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 2 DESC`, from, to)

		respond(w, map[string]any{
			"period_from":          from,
			"period_to":            to,
			"total_complaints":     toInt64(safeFirst(total)["n"]),
			"resolved":             toInt64(safeFirst(resolved)["n"]),
			"past_sla":             toInt64(safeFirst(pastSLA)["n"]),
			"avg_resolution_hours": safeFirst(avgRes)["avg_hours"],
			"by_type":              byType,
			"by_channel":           byChan,
		}, "cbn_report")
	}
}

// ── Call Scripts ──────────────────────────────────────────────────────────────

func ensureCallScriptsSchema(ctx context.Context, db *core.DB) {
	db.PGExec(ctx, `CREATE TABLE IF NOT EXISTS helpdesk_call_scripts (
		id          BIGSERIAL PRIMARY KEY,
		ticket_type TEXT NOT NULL,
		name        TEXT NOT NULL,
		steps       JSONB NOT NULL DEFAULT '[]',
		is_active   BOOLEAN NOT NULL DEFAULT TRUE,
		created_by  BIGINT,
		created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
	)`) //nolint:errcheck
}

func hdListCallScripts(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		rows, err := db.PGQuery(ctx, `SELECT id, ticket_type, name, steps, is_active, created_at, updated_at FROM helpdesk_call_scripts ORDER BY ticket_type, name`)
		if err != nil {
			respondErr(w, 500, err.Error())
			return
		}
		respond(w, rows, "call_scripts")
	}
}

func hdGetCallScriptByType(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		tt := r.URL.Query().Get("ticket_type")
		if tt == "" {
			respondErr(w, 400, "ticket_type required")
			return
		}
		rows, err := db.PGQuery(ctx, `SELECT id, name, steps FROM helpdesk_call_scripts WHERE ticket_type=$1 AND is_active=TRUE ORDER BY name LIMIT 1`, tt)
		if err != nil {
			respondErr(w, 500, err.Error())
			return
		}
		if len(rows) == 0 {
			respond(w, nil, "call_script")
			return
		}
		respond(w, rows[0], "call_script")
	}
}

func hdCreateCallScript(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		caller := core.UserFromCtx(r.Context())
		var body struct {
			TicketType string `json:"ticket_type"`
			Name       string `json:"name"`
			Steps      any    `json:"steps"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			respondErr(w, 400, "invalid JSON")
			return
		}
		if body.TicketType == "" || body.Name == "" {
			respondErr(w, 400, "ticket_type and name required")
			return
		}
		steps, _ := json.Marshal(body.Steps)
		var creatorID any
		if caller != nil {
			creatorID = caller.ID
		}
		rows, err := db.PGQuery(ctx, `INSERT INTO helpdesk_call_scripts (ticket_type,name,steps,created_by) VALUES ($1,$2,$3,$4) RETURNING id`, body.TicketType, body.Name, string(steps), creatorID)
		if err != nil {
			respondErr(w, 500, err.Error())
			return
		}
		respond(w, map[string]any{"id": rows[0]["id"]}, "call_script")
	}
}

func hdUpdateCallScript(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		id := chi.URLParam(r, "id")
		var body struct {
			Name     *string `json:"name"`
			Steps    any     `json:"steps"`
			IsActive *bool   `json:"is_active"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			respondErr(w, 400, "invalid JSON")
			return
		}
		sets := []string{"updated_at=NOW()"}
		args := []any{}
		if body.Name != nil {
			sets = append(sets, fmt.Sprintf("name=$%d", len(args)+1))
			args = append(args, *body.Name)
		}
		if body.Steps != nil {
			b, _ := json.Marshal(body.Steps)
			sets = append(sets, fmt.Sprintf("steps=$%d", len(args)+1))
			args = append(args, string(b))
		}
		if body.IsActive != nil {
			sets = append(sets, fmt.Sprintf("is_active=$%d", len(args)+1))
			args = append(args, *body.IsActive)
		}
		args = append(args, id)
		db.PGExec(ctx, fmt.Sprintf("UPDATE helpdesk_call_scripts SET %s WHERE id=$%d", strings.Join(sets, ","), len(args)), args...) //nolint:errcheck
		respond(w, map[string]any{"ok": true}, "call_script")
	}
}

func hdDeleteCallScript(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		id := chi.URLParam(r, "id")
		db.PGExec(ctx, "DELETE FROM helpdesk_call_scripts WHERE id=$1", id) //nolint:errcheck
		w.WriteHeader(204)
	}
}

// ── Graph Inbox Poller ────────────────────────────────────────────────────────

// StartGraphInboxPoller polls the MS Graph helpdesk inbox every 3 minutes.
func StartGraphInboxPoller(db *core.DB) {
	go func() {
		ticker := time.NewTicker(3 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			ctx := context.Background()
			WorkerBeat(ctx, db, "graph_inbox", "running", "", "")
			token, err := graphToken(ctx, db)
			if err != nil {
				slog.Info("GraphInboxPoller: Graph not configured, skipping")
				WorkerBeat(ctx, db, "graph_inbox", "ok", "Graph not configured", "")
				continue
			}
			inbox := resolveCredKey(ctx, db, "HELPDESK_INBOX_ADDRESS")
			if inbox == "" {
				slog.Info("GraphInboxPoller: HELPDESK_INBOX_ADDRESS not set, skipping")
				WorkerBeat(ctx, db, "graph_inbox", "ok", "inbox address not set", "")
				continue
			}
			processed, skipped, newTickets := hdPollGraphInbox(ctx, db, token, inbox)
			if processed > 0 || newTickets > 0 {
				slog.Info("GraphInboxPoller: done", "processed", processed, "skipped", skipped, "new_tickets", newTickets)
			}
			WorkerBeat(ctx, db, "graph_inbox", "ok", fmt.Sprintf("%d processed · %d new tickets", processed, newTickets), "")
		}
	}()
}

// httpGetBearer performs a GET request with a Bearer token.
func httpGetBearer(url, token string, timeout time.Duration) (*http.Response, error) {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	client := &http.Client{Timeout: timeout}
	return client.Do(req)
}

// batchAutoCloseTickets closes resolved tickets that have had no activity for 7+ days.
func batchAutoCloseTickets(ctx context.Context, db *core.DB) error {
	_, err := db.PGExec(ctx, `
		UPDATE helpdesk_tickets
		SET status = 'closed', closed_at = NOW(), updated_at = NOW()
		WHERE status = 'resolved'
		  AND updated_at < NOW() - INTERVAL '7 days'`)
	return err
}

// httpPatchBearer performs a PATCH request with a Bearer token and JSON body.
func httpPatchBearer(url, token string, body map[string]any) error {
	b, _ := json.Marshal(body)
	req, err := http.NewRequest("PATCH", url, strings.NewReader(string(b)))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

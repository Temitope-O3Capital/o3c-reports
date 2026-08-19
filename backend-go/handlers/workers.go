package handlers

import (
	"context"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// ── Heartbeats ────────────────────────────────────────────────────────────────
//
// Background workers that keep no run table of their own (pollers, scheduled jobs,
// worker pools) report their lifecycle here so the Sync & Workers hub can show a
// real last-run/status for the whole fleet. Call WorkerBeat at the start of a run
// (phase "running") and again at the end ("ok" or "error"). Best-effort: failures
// to record a heartbeat never affect the worker.

func WorkerBeat(ctx context.Context, db *core.DB, key, phase, detail, errStr string) {
	switch phase {
	case "running":
		db.PGExec(ctx, `INSERT INTO worker_heartbeats (worker_key, status, last_started_at, updated_at)
			VALUES ($1,'running',NOW(),NOW())
			ON CONFLICT (worker_key) DO UPDATE SET status='running', last_started_at=NOW(), updated_at=NOW()`, key) //nolint:errcheck
	case "ok":
		db.PGExec(ctx, `INSERT INTO worker_heartbeats (worker_key, status, last_finished_at, last_ok_at, detail, last_error, runs_total, updated_at)
			VALUES ($1,'ok',NOW(),NOW(),NULLIF($2,''),NULL,1,NOW())
			ON CONFLICT (worker_key) DO UPDATE SET status='ok', last_finished_at=NOW(), last_ok_at=NOW(),
			    detail=NULLIF($2,''), last_error=NULL, runs_total=worker_heartbeats.runs_total+1, updated_at=NOW()`, key, detail) //nolint:errcheck
	case "error":
		db.PGExec(ctx, `INSERT INTO worker_heartbeats (worker_key, status, last_finished_at, last_error, detail, runs_total, updated_at)
			VALUES ($1,'error',NOW(),NULLIF($2,''),NULLIF($3,''),1,NOW())
			ON CONFLICT (worker_key) DO UPDATE SET status='error', last_finished_at=NOW(),
			    last_error=NULLIF($2,''), detail=NULLIF($3,''), runs_total=worker_heartbeats.runs_total+1, updated_at=NOW()`, key, errStr, detail) //nolint:errcheck
	}
}

// ── Registry ──────────────────────────────────────────────────────────────────
//
// Every background sync/worker in the platform, with the metadata the hub renders.
// StatusSrc tells the endpoint where to read live status from. Trigger (if set) is
// the existing endpoint the hub's "Sync now" button posts to.

type workerDef struct {
	Key, Name, Category, Cadence, Description string
	StatusSrc                                 string // cbs | customer_feed | paystack | zoho | heartbeat | scheduled
	Trigger                                   string // POST endpoint for manual run, or "" if none
}

var workerRegistry = []workerDef{
	// ── Data syncs (external system → our DB) ──
	{"cbs", "Udara · Core Banking", "Data Sync", "Every 1 min",
		"Spools the Udara360 loan, fixed-deposit and product books into the snapshot tables.", "cbs", "/api/cbs/sync"},
	{"customer_feed", "Customer Feed · cust_file", "Data Sync", "Every 15 min",
		"Ingests the cust_file drops into the customer master — where new customers come from.", "customer_feed", "/api/customer-feed/ingest"},
	{"paystack", "Paystack · Settlements", "Data Sync", "Every 30 min",
		"Mirrors funding, transfers, settlements and disputes into the local reconciliation tables.", "paystack", "/api/paystack/sync"},
	{"zoho_voice", "Zoho Voice · Call Logs", "Data Sync", "Hourly",
		"Imports call-centre call logs from Zoho into the activity timeline.", "zoho", "/api/zoho/import-calls"},
	{"zoho_desk", "Zoho Desk · Tickets", "Data Sync", "Hourly",
		"Imports the newest helpdesk tickets from Zoho Desk.", "heartbeat", ""},
	{"callcenter_crm", "Call-Center Queue · from CRM", "Data Sync", "On demand",
		"Populates the call-centre dialer queue from CRM contacts.", "heartbeat", "/api/call-center/queue/sync-from-crm"},
	{"callcenter_collections", "Call-Center Queue · Collections", "Data Sync", "On demand",
		"Populates the dialer queue from the collections book.", "heartbeat", "/api/call-center/queue/sync-collections"},

	// ── Integrations / pollers ──
	{"graph_inbox", "Helpdesk Inbox · MS Graph", "Integration", "Every 3 min",
		"Polls the helpdesk mailbox and turns new mail into tickets.", "heartbeat", ""},
	{"care_mail", "Care Mailbox Poller", "Integration", "Every 1 min",
		"Polls care@ via Microsoft Graph and raises Care tickets.", "heartbeat", ""},
	{"phoenix_outbox", "Phoenix · Decisioning Submissions", "Integration", "Every 30 sec",
		"Submits workspace-originated loan applications to Phoenix for a credit decision, with backoff and retry. Idles until Phoenix is configured.", "heartbeat", "/api/phoenix/retry"},
	{"fx_rates", "FX Parallel-Market Rates", "Integration", "Hourly",
		"Scrapes parallel-market FX rates for treasury reporting.", "heartbeat", ""},
	{"bounce_monitor", "Mail Bounce Monitor", "Integration", "Every 30 min",
		"Polls SendGrid and alerts admins about bounced recipients.", "heartbeat", ""},

	// ── Scheduled jobs ──
	{"campaign_ticker", "Campaign Launcher", "Scheduled Job", "Continuous",
		"Auto-launches campaigns whose scheduled time has passed.", "heartbeat", ""},
	{"sequence_ticker", "Sequence Steps", "Scheduled Job", "Continuous",
		"Advances multi-step message sequences.", "heartbeat", ""},
	{"task_notifications", "Task Notifications", "Scheduled Job", "Hourly",
		"Pushes due-soon and overdue task reminders.", "heartbeat", ""},
	{"reporting_rollups", "Reporting Rollups", "Scheduled Job", "Nightly (batch)",
		"Rebuilds collections_daily_kpi over a rolling 35-day window (what Collections " +
			"Performance and Agent Performance read), and registers any new CCS transaction " +
			"code so it surfaces as unclassified instead of dropping out of revenue.",
		"heartbeat", "/api/reports/rollups/collections-kpi"},
	{"birthday", "Birthday Greetings", "Scheduled Job", "Daily · 08:00",
		"Sends customer birthday greetings.", "heartbeat", ""},
	{"account_alerts", "Account Alerts", "Scheduled Job", "Daily · 08:00",
		"Alerts account officers to due repayments, past-due loans and FD maturities.", "heartbeat", ""},
	{"ndpr_erasure", "NDPR Erasure", "Scheduled Job", "Daily · 00:00",
		"Processes approved data-erasure requests.", "heartbeat", ""},
	{"ttl_cleanup", "TTL Cleanup", "Scheduled Job", "Daily",
		"Purges expired tokens, sessions and idempotency keys.", "heartbeat", ""},

	// ── Worker pools (always-on plumbing) ──
	{"activity_log", "Activity-Log Writers", "Worker Pool", "Always on",
		"Drains the activity-log buffer into the database (3 workers).", "heartbeat", ""},
	{"audit_trail", "Audit-Trail Writers", "Worker Pool", "Always on",
		"Mirrors state-changing requests into the append-only audit log (2 workers).", "heartbeat", ""},
}

// ── Unified status endpoint ───────────────────────────────────────────────────

func RegisterWorkers(r chi.Router, db *core.DB) {
	r.With(core.RequirePages("admin")).Get("/", workersStatus(db))
}

type workerOut struct {
	Key         string  `json:"key"`
	Name        string  `json:"name"`
	Category    string  `json:"category"`
	Cadence     string  `json:"cadence"`
	Descr       string  `json:"description"`
	Status      string  `json:"status"` // ok | error | running | scheduled | idle
	LastRunAt   *string `json:"last_run_at"`
	LastOKAt    *string `json:"last_ok_at"`
	LastError   *string `json:"last_error"`
	Detail      *string `json:"detail"`
	Manual      bool    `json:"manual"`
	Trigger     string  `json:"trigger"`
	IntervalSec int     `json:"interval_sec"` // 0 = no fixed interval (on-demand/always-on)
	NextRunAt   *string `json:"next_run_at"`  // last_run + interval, when both known
}

// cadenceSecs maps a registry cadence string to its interval in seconds so the UI
// can render a live "next run in …" countdown. 0 = no fixed interval.
func cadenceSecs(cadence string) int {
	switch cadence {
	case "Every 1 min":
		return 60
	case "Every 3 min":
		return 180
	case "Every 15 min":
		return 900
	case "Every 30 min":
		return 1800
	case "Hourly":
		return 3600
	case "Continuous":
		return 90
	default:
		if len(cadence) >= 5 && cadence[:5] == "Daily" {
			return 86400
		}
		return 0 // On demand / Always on
	}
}

func workersStatus(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		// Pull the latest state for each source once, into lookup maps.
		type st struct {
			status               string
			lastRun, lastOK, err *string
			detail               *string
		}
		norm := func(s string) string {
			switch s {
			case "ok", "success":
				return "ok"
			case "error", "failed":
				return "error"
			case "running":
				return "running"
			default:
				return s
			}
		}

		cbs := map[string]st{}
		if rows, _ := db.PGQuery(ctx, `SELECT status, COALESCE(finished_at, started_at) AS last_run, error, products_n, loans_n, fds_n
			FROM cbs_sync_runs ORDER BY id DESC LIMIT 1`); len(rows) > 0 {
			x := rows[0]
			d := "products " + str(x["products_n"]) + " · loans " + str(x["loans_n"]) + " · FDs " + str(x["fds_n"])
			cbs["cbs"] = st{norm(str(x["status"])), tsPtr(x["last_run"]), tsPtr(x["last_run"]), strPtr(x["error"]), &d}
		}
		feed := map[string]st{}
		if rows, _ := db.PGQuery(ctx, `SELECT status, COALESCE(finished_at, started_at) AS last_run, error, files_seen, customers_inserted, customers_updated
			FROM customer_feed_runs ORDER BY id DESC LIMIT 1`); len(rows) > 0 {
			x := rows[0]
			d := str(x["files_seen"]) + " files · +" + str(x["customers_inserted"]) + " / ~" + str(x["customers_updated"]) + " customers"
			feed["customer_feed"] = st{norm(str(x["status"])), tsPtr(x["last_run"]), tsPtr(x["last_run"]), strPtr(x["error"]), &d}
		}
		pay := map[string]st{}
		if rows, _ := db.PGQuery(ctx, `SELECT status, COALESCE(finished_at, started_at) AS last_run, error, transactions_n, transfers_n, settlements_n
			FROM paystack_sync_runs ORDER BY id DESC LIMIT 1`); len(rows) > 0 {
			x := rows[0]
			d := str(x["transactions_n"]) + " txns · " + str(x["transfers_n"]) + " transfers · " + str(x["settlements_n"]) + " settlements"
			pay["paystack"] = st{norm(str(x["status"])), tsPtr(x["last_run"]), tsPtr(x["last_run"]), strPtr(x["error"]), &d}
		}
		// Zoho is keyed by job name; map both voice + desk jobs.
		zoho := map[string]st{}
		if rows, _ := db.PGQuery(ctx, `SELECT job, last_attempt_at, last_success_at, last_error, last_imported FROM zoho_sync_state`); len(rows) > 0 {
			for _, x := range rows {
				job := str(x["job"])
				status := "ok"
				if strPtr(x["last_error"]) != nil {
					status = "error"
				}
				d := str(x["last_imported"]) + " imported"
				zoho[job] = st{status, tsPtr(x["last_success_at"]), tsPtr(x["last_success_at"]), strPtr(x["last_error"]), &d}
			}
		}
		hb := map[string]st{}
		if rows, _ := db.PGQuery(ctx, `SELECT worker_key, status, last_finished_at, last_ok_at, last_error, detail FROM worker_heartbeats`); len(rows) > 0 {
			for _, x := range rows {
				hb[str(x["worker_key"])] = st{norm(str(x["status"])), tsPtr(x["last_finished_at"]), tsPtr(x["last_ok_at"]), strPtr(x["last_error"]), strPtr(x["detail"])}
			}
		}

		out := make([]workerOut, 0, len(workerRegistry))
		for _, d := range workerRegistry {
			o := workerOut{Key: d.Key, Name: d.Name, Category: d.Category, Cadence: d.Cadence,
				Descr: d.Description, Status: "scheduled", Manual: d.Trigger != "", Trigger: d.Trigger}
			var s st
			var ok bool
			switch d.StatusSrc {
			case "cbs":
				s, ok = cbs[d.Key]
			case "customer_feed":
				s, ok = feed[d.Key]
			case "paystack":
				s, ok = pay[d.Key]
			case "zoho":
				// registry key → zoho_sync_state job name
				job := map[string]string{"zoho_voice": "calls", "zoho_desk": "desk"}[d.Key]
				s, ok = zoho[job]
			default:
				s, ok = hb[d.Key]
			}
			if ok {
				if s.status != "" {
					o.Status = s.status
				}
				o.LastRunAt, o.LastOKAt, o.LastError, o.Detail = s.lastRun, s.lastOK, s.err, s.detail
			}
			// Live "next run" for interval workers = last run + interval.
			o.IntervalSec = cadenceSecs(d.Cadence)
			if o.IntervalSec > 0 && o.LastRunAt != nil {
				if t, e := time.Parse(time.RFC3339, *o.LastRunAt); e == nil {
					nr := t.Add(time.Duration(o.IntervalSec) * time.Second).Format(time.RFC3339)
					o.NextRunAt = &nr
				}
			}
			out = append(out, o)
		}
		respond(w, map[string]any{"workers": out, "generated_at": time.Now().Format(time.RFC3339)}, "pg")
	}
}

// tsPtr / strPtr normalise a scanned cell into a *string (nil when empty/null).
func tsPtr(v any) *string {
	switch t := v.(type) {
	case time.Time:
		if t.IsZero() {
			return nil
		}
		s := t.Format(time.RFC3339)
		return &s
	case string:
		if t == "" {
			return nil
		}
		return &t
	}
	return nil
}

func strPtr(v any) *string {
	s := str(v)
	if s == "" {
		return nil
	}
	return &s
}

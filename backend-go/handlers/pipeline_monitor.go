package handlers

// Pipeline freshness monitor.
//
// The problem this solves, concretely: on 2026-09-08 at 08:38 the CCS export
// stopped mid-morning. Six days later nobody had noticed, because every signal
// the platform had said "healthy":
//
//   feed_runs        status='ok', minutes ago, rows_inserted=0
//   worker hub       four feeds green (the stale override existed but the fleet
//                    banner counted 'stale' as neither healthy nor error)
//   Task Scheduler   O3C-CCS-Ingest exit code 0, every 15 minutes
//   ingest.v_health  hours_since_last_drop frozen at a bogus 3,272h
//   log files        "0 new files" printed ~5,700 consecutive times, unread
//
// A run over an empty folder succeeds, so run status is not health. This worker
// reads app.v_pipeline_freshness (migration 238), which compares the age of the
// DATA to a per-source expectation, and turns that into a notification.
//
// Why not app.alert_rules: its notify_roles column is selected and never read,
// three of its seven seeded condition types have no implementation, its API
// router is never mounted, and alert_log has 0 rows in its lifetime. A row there
// reaches nobody.
//
// The alerting shape is copied from StartSLABreachMonitor (helpdesk.go), the only
// production-grade time-threshold-to-notification engine in the repo: claim the
// alert with a guarded UPDATE so concurrent ticks cannot double-send, warn before
// breaching, and notify recovery once.

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/prometheus/client_golang/prometheus"

	"github.com/o3c/workspace/core"
)

const (
	pipelineMonitorInterval = 15 * time.Minute

	// How long before a still-broken source nags again. Every tick would be
	// noise; never again would let a fixed-then-broken source go quiet. Daily
	// matches the batchAPIKeyExpiryAlerts convention.
	pipelineRenotifyAfter = 24 * time.Hour

	// Stagger past boot so the feeds have had a chance to run first and we do not
	// alert on a freshly started process's empty state.
	pipelineMonitorBootDelay = 3 * time.Minute
)

// Gauges live here rather than in metrics.go so the feature is self-contained;
// Go permits several init() functions per package. Exported through /metrics,
// which is already wired (main.go) — this is what lets the freshness signal hang
// off Prometheus/Grafana later without another backend change.
var (
	pipelineDataAgeSeconds = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "o3c_pipeline_data_age_seconds",
		Help: "Age in seconds of the newest DATA received from each inbound source (not the last run).",
	}, []string{"source"})

	pipelineStale = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "o3c_pipeline_stale",
		Help: "1 when an inbound source is past its stale_after threshold, taper-flagged, or has never delivered; else 0.",
	}, []string{"source"})

	pipelineVolumeRatio = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "o3c_pipeline_volume_ratio",
		Help: "Rows in the last 24h divided by the trailing 14-day median, per source. Catches a feed that tapers before it stops.",
	}, []string{"source"})
)

func init() {
	prometheus.MustRegister(pipelineDataAgeSeconds, pipelineStale, pipelineVolumeRatio)
}

// pipelineFreshnessSQL is shared by the worker and the API so the page and the
// alert can never disagree about what "stale" means.
// notify_roles comes from the source table rather than the view: it is a
// recipient list, not a measurement, and joining here keeps migration 238's view
// definition untouched. Rendered as a comma-separated string because a text[]
// crosses database/sql as a driver-specific type.
const pipelineFreshnessSQL = `
SELECT f.source_key, f.label, f.category, f.owner, f.enabled, f.notes,
       f.state, f.run_state,
       f.last_run_at, f.last_ok_at, f.last_data_at,
       EXTRACT(EPOCH FROM f.data_age)::bigint    AS data_age_sec,
       -- The age the verdict actually tested. Equal to data_age except on a
       -- business_days_only source, where whole weekend days are removed
       -- (migration 259) — without this the page shows "60h ago" beside an "ok"
       -- verdict on a Monday and looks broken.
       EXTRACT(EPOCH FROM f.effective_data_age)::bigint AS effective_data_age_sec,
       f.business_days_only,
       EXTRACT(EPOCH FROM f.run_age)::bigint     AS run_age_sec,
       EXTRACT(EPOCH FROM f.warn_after)::bigint  AS warn_after_sec,
       EXTRACT(EPOCH FROM f.stale_after)::bigint AS stale_after_sec,
       f.rows_recent, f.rows_baseline, f.volume_ratio,
       COALESCE(array_to_string(s.notify_roles, ','), '') AS notify_roles,
       -- How many people this alert would actually reach. A role with no holder
       -- notifies nobody, which is the failure this whole feature exists to
       -- prevent, so the count is surfaced rather than assumed. Admins are
       -- included because NotifyRoles always copies them.
       COALESCE((SELECT count(*) FROM o3c_users u
                  WHERE COALESCE(u.is_active, true) AND u.deleted_at IS NULL
                    AND (u.role = 'admin' OR u.role = ANY(COALESCE(s.notify_roles, '{}')))), 0)
         AS recipient_count
  FROM app.v_pipeline_freshness f
  LEFT JOIN app.pipeline_source s ON s.source_key = f.source_key
 ORDER BY CASE f.state WHEN 'stale' THEN 0 WHEN 'never' THEN 1 WHEN 'taper' THEN 2
                       WHEN 'warn' THEN 3 WHEN 'ok' THEN 4 ELSE 5 END,
          f.source_key`

// StartPipelineMonitor runs the freshness check on a schedule.
func StartPipelineMonitor(db *core.DB) {
	interval := pipelineMonitorInterval
	if v := os.Getenv("PIPELINE_MONITOR_INTERVAL"); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			interval = d
		} else {
			slog.Warn("pipeline monitor: bad PIPELINE_MONITOR_INTERVAL, using default", "value", v, "err", err)
		}
	}
	if interval <= 0 {
		slog.Info("pipeline monitor disabled (PIPELINE_MONITOR_INTERVAL <= 0)")
		return
	}

	time.Sleep(pipelineMonitorBootDelay)
	runPipelineCheck(db)

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for range ticker.C {
		runPipelineCheck(db)
	}
}

// runPipelineCheck evaluates every source once: refresh metrics, raise alerts for
// anything broken, and clear alerts for anything that recovered.
func runPipelineCheck(db *core.DB) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	WorkerBeat(ctx, db, "pipeline_monitor", "running", "", "")

	rows, err := db.PGQuery(ctx, pipelineFreshnessSQL)
	if err != nil {
		slog.Error("pipeline monitor: query failed", "err", err)
		WorkerBeat(ctx, db, "pipeline_monitor", "error", "", err.Error())
		return
	}

	var broken, recovered int
	for _, r := range rows {
		src := str(r["source_key"])
		if src == "" {
			continue
		}
		state := str(r["state"])
		runState := str(r["run_state"])

		// ── Metrics, for every source including healthy ones ────────────────
		if state != "disabled" {
			if v, ok := r["data_age_sec"]; ok && v != nil {
				pipelineDataAgeSeconds.WithLabelValues(src).Set(float64(toInt64(v)))
			}
			stale := 0.0
			if state == "stale" || state == "taper" || state == "never" {
				stale = 1
			}
			pipelineStale.WithLabelValues(src).Set(stale)
			if v, ok := r["volume_ratio"]; ok && v != nil {
				pipelineVolumeRatio.WithLabelValues(src).Set(toFloat64(v))
			}
		}

		if state == "disabled" {
			continue
		}

		// ── Data-age alerting ──────────────────────────────────────────────
		switch state {
		case "stale", "taper", "never", "warn":
			if raisePipelineAlert(ctx, db, r, state) {
				broken++
			}
		case "ok":
			recovered += resolvePipelineAlerts(ctx, db, r, "warn", "stale", "taper", "never")
		}

		// ── Dead-man's-switch on the JOB, independent of the data ──────────
		// Nothing checked this before, which is why reporting_rollups has sat
		// status='running' with runs_total=0 and last_ok_at NULL, invisibly.
		if runState == "run_dead" || runState == "never_ok" {
			if raisePipelineAlert(ctx, db, r, "run_dead") {
				broken++
			}
		} else if runState == "running" {
			recovered += resolvePipelineAlerts(ctx, db, r, "run_dead")
		}
	}

	// Recency is answered above. Continuity is a different question and is asked here:
	// a feed can be minutes old and still have skipped a day. See feed_continuity.go.
	gapsRaised, gapsCleared := checkFeedContinuity(ctx, db)
	broken += gapsRaised
	recovered += gapsCleared

	detail := fmt.Sprintf("%d sources · %d alerting · %d recovered", len(rows), broken, recovered)
	WorkerBeat(ctx, db, "pipeline_monitor", "ok", detail, "")
	slog.Info("pipeline monitor ok", "sources", len(rows), "alerting", broken,
		"recovered", recovered, "gap_alerts", gapsRaised, "gap_window_from", feedGapWindowStart())
}

// raisePipelineAlert opens (or refreshes) an alert and notifies at most once per
// pipelineRenotifyAfter. Returns true when this tick sent a notification.
//
// The claim is the guarded UPDATE: only the tick whose WHERE clause still matches
// wins, so two overlapping runs cannot both notify.
func raisePipelineAlert(ctx context.Context, db *core.DB, r core.Row, level string) bool {
	src := str(r["source_key"])
	detail := pipelineAlertDetail(r, level)

	if _, err := db.PGExec(ctx, `
		INSERT INTO app.pipeline_alert_state (source_key, level, detail)
		VALUES ($1, $2, $3)
		ON CONFLICT (source_key, level) DO UPDATE SET
		    last_seen_at  = now(),
		    detail        = EXCLUDED.detail,
		    -- A recurrence after recovery is a new incident, so the clock restarts
		    -- and it is allowed to notify again.
		    first_seen_at = CASE WHEN app.pipeline_alert_state.resolved_at IS NOT NULL
		                         THEN now() ELSE app.pipeline_alert_state.first_seen_at END,
		    last_notified_at = CASE WHEN app.pipeline_alert_state.resolved_at IS NOT NULL
		                            THEN NULL ELSE app.pipeline_alert_state.last_notified_at END,
		    resolved_at   = NULL`,
		src, level, detail); err != nil {
		slog.Error("pipeline monitor: could not record alert", "source", src, "level", level, "err", err)
		return false
	}

	claimed, err := db.PGQuery(ctx, `
		UPDATE app.pipeline_alert_state
		   SET last_notified_at = now(), notify_count = notify_count + 1
		 WHERE source_key = $1 AND level = $2
		   AND (last_notified_at IS NULL OR last_notified_at < now() - $3::interval)
		 RETURNING notify_count`,
		src, level, fmt.Sprintf("%d seconds", int(pipelineRenotifyAfter.Seconds())))
	if err != nil || len(claimed) == 0 {
		if err != nil {
			slog.Error("pipeline monitor: claim failed", "source", src, "level", level, "err", err)
		}
		return false // already notified inside the window, or another tick won
	}

	title, priority := pipelineAlertTitle(r, level)
	roles := pipelineNotifyRoles(r)
	// GroupKey is per-source, deliberately: repeats of the same source collapse
	// into one in-app row, but two different dead sources stay two alerts. A
	// single shared key would hide the second outage behind the first.
	NotifyRoles(ctx, db, roles, NotifPayload{
		EventType: EvtSystemAlert,
		Title:     title,
		Body:      detail,
		ActionURL: "/admin/data-freshness",
		EntityRef: src,
		GroupKey:  "pipeline_" + src + "_" + level,
		Priority:  priority,
	})
	slog.Warn("pipeline alert", "source", src, "level", level, "recipients", roles, "detail", detail)
	return true
}

// pipelineNotifyRoles is who gets told about this source (migration 256).
//
// Before it, every alert went to a hardcoded it_admin + admin. Measured six days
// after the monitor shipped: no user holds it_admin and two hold admin, while the
// three sources that were actually broken — card cycle, CCS EODTXN, Interswitch
// settlement, all 45+ days stale — belong to Cards ops and Settlement ops, who
// were never told. The list falls back to the old behaviour when a source has no
// roles set, and NotifyRoles always copies admins, so this can narrow who else
// hears but can never silence an alert completely.
func pipelineNotifyRoles(r core.Row) []string {
	var roles []string
	for _, s := range strings.Split(str(r["notify_roles"]), ",") {
		if s = strings.TrimSpace(s); s != "" {
			roles = append(roles, s)
		}
	}
	if len(roles) == 0 {
		return []string{"it_admin", "admin"}
	}
	return roles
}

// resolvePipelineAlerts closes any open alert for the given levels and notifies
// recovery once. Returns how many were closed.
func resolvePipelineAlerts(ctx context.Context, db *core.DB, r core.Row, levels ...string) int {
	src := str(r["source_key"])
	n := 0
	for _, level := range levels {
		closed, err := db.PGQuery(ctx, `
			UPDATE app.pipeline_alert_state
			   SET resolved_at = now()
			 WHERE source_key = $1 AND level = $2 AND resolved_at IS NULL
			 RETURNING notify_count`, src, level)
		if err != nil {
			slog.Error("pipeline monitor: resolve failed", "source", src, "level", level, "err", err)
			continue
		}
		if len(closed) == 0 {
			continue
		}
		n++
		// Only announce recovery if the outage was announced. Otherwise a
		// blip inside the notify window would produce a recovery notice for an
		// alert nobody ever saw.
		if toInt64(closed[0]["notify_count"]) > 0 {
			// Recovery goes to whoever was told it broke.
			NotifyRoles(ctx, db, pipelineNotifyRoles(r), NotifPayload{
				EventType: EvtSystemAlert,
				Title:     "Data Flowing Again: " + str(r["label"]),
				Body: fmt.Sprintf("%s is delivering again (last data %s).",
					str(r["label"]), pipelineAgeWords(toInt64(r["data_age_sec"]))),
				ActionURL: "/admin/data-freshness",
				EntityRef: src,
				GroupKey:  "pipeline_" + src + "_recovered",
				Priority:  "normal",
			})
		}
	}
	return n
}

func pipelineAlertTitle(r core.Row, level string) (title, priority string) {
	label := str(r["label"])
	switch level {
	case "stale":
		return "No data from " + label, "urgent"
	case "never":
		return "Never received data from " + label, "high"
	case "taper":
		return "Data volume collapsed: " + label, "urgent"
	case "run_dead":
		return "Ingest job not running: " + label, "high"
	case "gap":
		return "Missing days in " + label, "high"
	default:
		return "Data delayed from " + label, "normal"
	}
}

func pipelineAlertDetail(r core.Row, level string) string {
	label := str(r["label"])
	owner := str(r["owner"])
	age := pipelineAgeWords(toInt64(r["data_age_sec"]))

	var msg string
	switch level {
	case "never":
		msg = fmt.Sprintf("%s has never delivered any data.", label)
	case "taper":
		msg = fmt.Sprintf("%s is still delivering but volume has collapsed: %d rows in the last 24h against a trailing median of %d (ratio %.2f). Newest data %s. A feed that tapers usually stops next — this is what happened before the 2026-09-08 outage.",
			label, toInt64(r["rows_recent"]), toInt64(r["rows_baseline"]), toFloat64(r["volume_ratio"]), age)
	case "run_dead":
		msg = fmt.Sprintf("The job for %s has not completed successfully for %s. The source may be fine; the ingest is not running.",
			label, pipelineAgeWords(toInt64(r["run_age_sec"])))
	case "gap":
		// Continuity reads nothing like an age, so it writes its own body.
		return feedGapDetail(r)
	default:
		msg = fmt.Sprintf("%s last delivered data %s. Expected at least every %s.",
			label, age, pipelineAgeWords(toInt64(r["stale_after_sec"])))
	}
	if owner != "" {
		msg += " Owner: " + owner + "."
	}
	if notes := str(r["notes"]); notes != "" {
		msg += " " + notes
	}
	return msg
}

// pipelineAgeWords renders a second count the way an operator reads it.
func pipelineAgeWords(sec int64) string {
	switch {
	case sec <= 0:
		return "just now"
	case sec < 3600:
		return fmt.Sprintf("%dm ago", sec/60)
	case sec < 48*3600:
		return fmt.Sprintf("%dh ago", sec/3600)
	default:
		return fmt.Sprintf("%dd ago", sec/86400)
	}
}

// ── API ─────────────────────────────────────────────────────────────────────

// RegisterPipelineHealth mounts the Data Freshness endpoints under /api/admin.
func RegisterPipelineHealth(r chi.Router, db *core.DB) {
	r.With(core.RequirePages("admin")).Get("/", pipelineHealth(db))
	r.With(core.RequirePages("admin")).Get("/alerts", pipelineAlerts(db))
}

func pipelineHealth(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), pipelineFreshnessSQL)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		counts := map[string]int{}
		for _, row := range rows {
			counts[str(row["state"])]++
		}
		respond(w, map[string]any{
			"sources":      rows,
			"counts":       counts,
			"generated_at": time.Now().Format(time.RFC3339),
		}, "pg")
	}
}

func pipelineAlerts(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT a.source_key, s.label, a.level, a.first_seen_at, a.last_seen_at,
			       a.last_notified_at, a.notify_count, a.resolved_at, a.detail
			  FROM app.pipeline_alert_state a
			  LEFT JOIN app.pipeline_source s USING (source_key)
			 ORDER BY (a.resolved_at IS NULL) DESC, a.last_seen_at DESC
			 LIMIT 200`)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		respond(w, rows, "pg")
	}
}

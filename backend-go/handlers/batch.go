package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// RegisterBatch wires the batch trigger endpoints.
// Only it_admin / settings-page users can trigger manually.
func RegisterBatch(r chi.Router, db *core.DB) {
	auth := core.RequirePages("settings", "admin_users")
	r.With(auth).Post("/run", batchRunHandler(db))
	r.With(auth).Get("/last", batchLastHandler(db))
}

// RunBatchNightly starts two goroutines:
// 1. Full nightly batch at midnight (heavy work: snapshots, alerts, etc.)
// 2. Hourly Zoho resync so helpdesk data stays within ~1 hour of live
// Call once from main.go after opening the DB. Cancel the context to stop.
func RunBatchNightly(ctx context.Context, db *core.DB) {
	// Full nightly batch
	go func() {
		for {
			now := time.Now()
			next := time.Date(now.Year(), now.Month(), now.Day()+1, 0, 5, 0, 0, now.Location())
			slog.Info("Batch: next run scheduled", "at", next.Format(time.RFC3339))

			select {
			case <-ctx.Done():
				slog.Info("Batch: shutdown signal received, stopping scheduler")
				return
			case <-time.After(time.Until(next)):
			}

			runCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
			if err := runBatch(runCtx, db); err != nil {
				slog.Error("Nightly batch failed", "err", err)
			}
			cancel()
		}
	}()

}

// batchRunHandler triggers the batch manually (HTTP).
func batchRunHandler(db *core.DB) http.HandlerFunc {
	var mu sync.Mutex
	var running bool
	return func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		if running {
			mu.Unlock()
			respondErr(w, 429, "Batch is already running")
			return
		}
		running = true
		mu.Unlock()

		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
		defer cancel()
		defer func() { mu.Lock(); running = false; mu.Unlock() }()

		start := time.Now()
		if err := runBatch(ctx, db); err != nil {
			slog.Error("Manual batch failed", "err", err)
			respondErr(w, 500, fmt.Sprintf("Batch failed: %s", err.Error()))
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"ok":          true,
			"duration_ms": time.Since(start).Milliseconds(),
			"ran_at":      start.UTC().Format(time.RFC3339),
		})
	}
}

// batchLastHandler returns the most recent batch log entry.
func batchLastHandler(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT * FROM batch_log ORDER BY started_at DESC LIMIT 5`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

// ── Core batch logic ──────────────────────────────────────────────────────────

func runBatch(ctx context.Context, db *core.DB) error {
	startedAt := time.Now()
	steps := []string{}
	var batchErr error

	slog.Info("Batch: starting")

	// 1. Portfolio daily snapshot
	if err := batchPortfolioSnapshot(ctx, db); err != nil {
		slog.Error("Batch: portfolio snapshot failed", "err", err)
		batchErr = err
		steps = append(steps, "portfolio_snapshot:FAILED")
	} else {
		steps = append(steps, "portfolio_snapshot:ok")
	}

	// 1b. DPD daily snapshot
	if err := batchDPDSnapshot(ctx, db); err != nil {
		slog.Error("Batch: DPD snapshot failed", "err", err)
		if batchErr == nil {
			batchErr = err
		}
		steps = append(steps, "dpd_snapshot:FAILED")
	} else {
		steps = append(steps, "dpd_snapshot:ok")
	}

	// 2. Alert rule evaluation
	if err := batchEvaluateAlerts(ctx, db); err != nil {
		slog.Error("Batch: alert evaluation failed", "err", err)
		batchErr = err
		steps = append(steps, "alerts:FAILED")
	} else {
		steps = append(steps, "alerts:ok")
	}

	// 3. Notification cleanup (delete read notifications older than 30 days)
	if err := batchCleanupNotifications(ctx, db); err != nil {
		slog.Error("Batch: notification cleanup failed", "err", err)
		steps = append(steps, "notif_cleanup:FAILED")
	} else {
		steps = append(steps, "notif_cleanup:ok")
	}

	// 4. LOS SLA breach — flag overdue applications
	if err := batchLOSSLACheck(ctx, db); err != nil {
		slog.Error("Batch: LOS SLA check failed", "err", err)
		steps = append(steps, "los_sla:FAILED")
	} else {
		steps = append(steps, "los_sla:ok")
	}

	status := "success"
	if batchErr != nil {
		status = "partial"
	}
	errMsg := ""
	if batchErr != nil {
		errMsg = batchErr.Error()
	}

	// Write batch log
	stepsJSON, _ := json.Marshal(steps)
	db.PGExec(ctx, `
		INSERT INTO batch_log (started_at, finished_at, status, steps, error_msg)
		VALUES ($1, $2, $3, $4, $5)`,
		startedAt, time.Now(), status, string(stepsJSON), errMsg) //nolint:errcheck

	slog.Info("Batch: finished", "status", status, "steps", steps)
	return batchErr
}

// batchPortfolioSnapshot computes today's portfolio metrics from loan_applications and writes a snapshot row.
func batchPortfolioSnapshot(ctx context.Context, db *core.DB) error {
	today := time.Now().Format("2006-01-02")

	rows, err := db.PGQuery(ctx, `
		SELECT
			COUNT(*) FILTER (WHERE status = 'active')                                  AS total_loans,
			COALESCE(SUM(amount_approved_kobo) FILTER (WHERE status = 'active'), 0)    AS total_outstanding_kobo,
			COALESCE(SUM(amount_approved_kobo) FILTER (WHERE status = 'active' AND GREATEST(0, CURRENT_DATE - booked_at::date) > 90), 0) AS total_npls_kobo,
			COALESCE(SUM(amount_approved_kobo) FILTER (WHERE status = 'active' AND GREATEST(0, CURRENT_DATE - booked_at::date) > 30), 0) AS par30_kobo,
			COALESCE(SUM(amount_approved_kobo) FILTER (WHERE status = 'active' AND GREATEST(0, CURRENT_DATE - booked_at::date) > 60), 0) AS par60_kobo,
			COALESCE(SUM(amount_approved_kobo) FILTER (WHERE status = 'active' AND GREATEST(0, CURRENT_DATE - booked_at::date) > 90), 0) AS par90_kobo,
			COALESCE(SUM(amount_approved_kobo) FILTER (WHERE booked_at::date = $1), 0) AS new_disbursements_kobo
		FROM loan_applications`, today)
	if err != nil || len(rows) == 0 {
		return fmt.Errorf("portfolio query: %w", err)
	}

	r := rows[0]
	outstanding := toInt64(r["total_outstanding_kobo"])
	npls := toInt64(r["total_npls_kobo"])
	nplBps := int64(0)
	if outstanding > 0 {
		nplBps = (npls * 10000) / outstanding
	}

	_, err = db.PGExec(ctx, `
		INSERT INTO portfolio_daily_snapshot
			(snapshot_date, total_loans, total_outstanding_kobo, total_npls_kobo,
			 npl_ratio_bps, par30_kobo, par60_kobo, par90_kobo, new_disbursements_kobo)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		ON CONFLICT (snapshot_date) DO UPDATE SET
			total_loans             = EXCLUDED.total_loans,
			total_outstanding_kobo  = EXCLUDED.total_outstanding_kobo,
			total_npls_kobo         = EXCLUDED.total_npls_kobo,
			npl_ratio_bps           = EXCLUDED.npl_ratio_bps,
			par30_kobo              = EXCLUDED.par30_kobo,
			par60_kobo              = EXCLUDED.par60_kobo,
			par90_kobo              = EXCLUDED.par90_kobo,
			new_disbursements_kobo  = EXCLUDED.new_disbursements_kobo`,
		today,
		toInt64(r["total_loans"]),
		outstanding,
		npls,
		nplBps,
		toInt64(r["par30_kobo"]),
		toInt64(r["par60_kobo"]),
		toInt64(r["par90_kobo"]),
		toInt64(r["new_disbursements_kobo"]),
	)
	return err
}

// batchEvaluateAlerts checks active alert rules against today's snapshot and fires any that breach.
func batchEvaluateAlerts(ctx context.Context, db *core.DB) error {
	rules, err := db.PGQuery(ctx, `
		SELECT id, rule_name, condition_type, threshold, severity, notify_roles
		FROM alert_rules WHERE is_active = TRUE`)
	if err != nil {
		return err
	}

	snapRows, err := db.PGQuery(ctx, `
		SELECT * FROM portfolio_daily_snapshot ORDER BY snapshot_date DESC LIMIT 1`)
	if err != nil || len(snapRows) == 0 {
		return nil // no snapshot yet — skip alerts
	}
	snap := snapRows[0]

	outstanding := toFloat64(snap["total_outstanding_kobo"])
	npls := toFloat64(snap["total_npls_kobo"])
	par30 := toFloat64(snap["par30_kobo"])

	for _, rule := range rules {
		ruleID := toInt64(rule["id"])
		condType := str(rule["condition_type"])
		threshold := toFloat64(rule["threshold"])

		var breached bool
		details := map[string]any{"rule": str(rule["rule_name"])}

		switch condType {
		case "npl_ratio_exceeds":
			if outstanding > 0 {
				nplPct := (npls / outstanding) * 100
				if nplPct > threshold {
					breached = true
					details["npl_pct"] = fmt.Sprintf("%.2f%%", nplPct)
				}
			}
		case "par30_exceeds":
			if outstanding > 0 {
				par30Pct := (par30 / outstanding) * 100
				if par30Pct > threshold {
					breached = true
					details["par30_pct"] = fmt.Sprintf("%.2f%%", par30Pct)
				}
			}
		case "sar_draft_aging_hours":
			sarRows, _ := db.PGQuery(ctx, `
				SELECT COUNT(*) AS c FROM sars
				WHERE status = 'draft'
				AND created_at < NOW() - ($1 || ' hours')::interval`, threshold)
			if len(sarRows) > 0 && toInt64(sarRows[0]["c"]) > 0 {
				breached = true
				details["count"] = toInt64(sarRows[0]["c"])
			}
		case "compliance_overdue":
			overdueRows, _ := db.PGQuery(ctx, `
				SELECT COUNT(*) AS c FROM compliance_checklists
				WHERE status NOT IN ('completed','na')
				AND due_date < CURRENT_DATE`)
			if len(overdueRows) > 0 && toInt64(overdueRows[0]["c"]) > 0 {
				breached = true
				details["overdue"] = toInt64(overdueRows[0]["c"])
			}
		}

		if !breached {
			continue
		}

		// Only fire if no unresolved alert for this rule today
		existRows, _ := db.PGQuery(ctx, `
			SELECT id FROM alert_log
			WHERE rule_id = $1 AND is_resolved = FALSE
			AND triggered_at > NOW() - INTERVAL '24 hours'
			LIMIT 1`, ruleID)
		if len(existRows) > 0 {
			continue
		}

		detailsJSON, _ := json.Marshal(details)
		db.PGExec(ctx, `
			INSERT INTO alert_log (rule_id, triggered_at, details, is_resolved)
			VALUES ($1, NOW(), $2, FALSE)`,
			ruleID, string(detailsJSON)) //nolint:errcheck

		slog.Warn("Alert fired", "rule", str(rule["rule_name"]), "severity", str(rule["severity"]))
	}
	return nil
}

// batchCleanupNotifications removes read notifications older than 30 days.
func batchCleanupNotifications(ctx context.Context, db *core.DB) error {
	result, err := db.PGExec(ctx, `
		DELETE FROM notifications
		WHERE is_read = TRUE AND created_at < NOW() - INTERVAL '30 days'`)
	if err != nil {
		return err
	}
	if n, ok := result.(interface{ RowsAffected() (int64, error) }); ok {
		if count, _ := n.RowsAffected(); count > 0 {
			slog.Info("Batch: cleaned up notifications", "deleted", count)
		}
	}
	return nil
}

// batchDPDSnapshot inserts today's DPD row for every active/repaying/overdue loan.
// Uses a computed DPD (CURRENT_DATE - booked_at) since loan_applications has no dpd column.
// The unique key on loan_dpd_daily_snapshot is (snapshot_date, cif_number); on conflict we
// update so reruns are idempotent.
func batchDPDSnapshot(ctx context.Context, db *core.DB) error {
	_, err := db.PGExec(ctx, `
		INSERT INTO loan_dpd_daily_snapshot (snapshot_date, cif_number, outstanding_kobo, dpd, dpd_bucket)
		SELECT
			CURRENT_DATE,
			applicant_cif,
			COALESCE(amount_approved_kobo, 0),
			GREATEST(0, CURRENT_DATE - booked_at::date) AS dpd,
			CASE
				WHEN GREATEST(0, CURRENT_DATE - booked_at::date) = 0  THEN '0'
				WHEN GREATEST(0, CURRENT_DATE - booked_at::date) <= 30 THEN '1-30'
				WHEN GREATEST(0, CURRENT_DATE - booked_at::date) <= 60 THEN '31-60'
				WHEN GREATEST(0, CURRENT_DATE - booked_at::date) <= 90 THEN '61-90'
				ELSE '90+'
			END
		FROM loan_applications
		WHERE status IN ('active','repaying','overdue')
		  AND booked_at IS NOT NULL
		ON CONFLICT (snapshot_date, cif_number) DO UPDATE
			SET dpd             = EXCLUDED.dpd,
			    dpd_bucket      = EXCLUDED.dpd_bucket,
			    outstanding_kobo = EXCLUDED.outstanding_kobo
	`)
	return err
}

// batchLOSSLACheck flags loan applications that have breached their stage SLA.
// SLA hours are read from los_config table. Overdue apps get a note in application_events.
func batchLOSSLACheck(ctx context.Context, db *core.DB) error {
	// SLA per stage in hours (defaults if config missing)
	slaDefaults := map[string]int{
		"document_collection": 48,
		"risk_review":         24,
		"risk_head_review":    4,
		"finance_approval":    24,
	}

	cfgRows, _ := db.PGQuery(ctx, `SELECT key, value FROM los_config WHERE key LIKE 'sla_%'`)
	for _, row := range cfgRows {
		key := str(row["key"])
		val := str(row["value"])
		stage := ""
		switch key {
		case "sla_document_collection_hours":
			stage = "document_collection"
		case "sla_risk_review_hours":
			stage = "risk_review"
		case "sla_risk_head_review_hours":
			stage = "risk_head_review"
		case "sla_finance_approval_hours":
			stage = "finance_approval"
		}
		if stage != "" && val != "" {
			var h int
			fmt.Sscanf(val, "%d", &h)
			if h > 0 {
				slaDefaults[stage] = h
			}
		}
	}

	for stage, hours := range slaDefaults {
		overdueApps, err := db.PGQuery(ctx, `
			SELECT id, reference FROM loan_applications
			WHERE stage = $1
			AND status NOT IN ('declined','active')
			AND updated_at < NOW() - ($2 || ' hours')::interval
			AND id NOT IN (
				SELECT application_id FROM application_events
				WHERE event_type = 'sla_breach' AND created_at > NOW() - INTERVAL '24 hours'
			)`, stage, hours)
		if err != nil {
			continue
		}
		for _, app := range overdueApps {
			db.PGExec(ctx, `
				INSERT INTO application_events
					(application_id, event_type, from_stage, to_stage, actor_user_id, notes, created_at)
				VALUES ($1, 'sla_breach', $2, $2, 0, $3, NOW())`,
				toInt64(app["id"]), stage,
				fmt.Sprintf("SLA breach: application in %s for more than %d hours", stage, hours)) //nolint:errcheck
		}
		if len(overdueApps) > 0 {
			slog.Warn("Batch: LOS SLA breach", "stage", stage, "count", len(overdueApps))
		}
	}
	return nil
}



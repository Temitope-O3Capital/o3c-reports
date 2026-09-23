package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
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
			respondErrLog(w, 500, "Query failed", err)
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

	// 1c. CBS/Udara portfolio snapshot — the real loan + FD book (native tables are empty)
	if err := batchCBSPortfolioSnapshot(ctx, db); err != nil {
		slog.Error("Batch: CBS portfolio snapshot failed", "err", err)
		if batchErr == nil {
			batchErr = err
		}
		steps = append(steps, "cbs_portfolio_snapshot:FAILED")
	} else {
		steps = append(steps, "cbs_portfolio_snapshot:ok")
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

	// 5. KPI daily snapshot
	if err := batchKPISnapshot(ctx, db); err != nil {
		slog.Error("Batch: KPI snapshot failed", "err", err)
		steps = append(steps, "kpi_snapshot:FAILED")
	} else {
		steps = append(steps, "kpi_snapshot:ok")
	}

	// 6. NDPR data retention purge (P12-01)
	if err := batchNDPRRetentionPurge(ctx, db); err != nil {
		slog.Error("Batch: NDPR purge failed", "err", err)
		steps = append(steps, "ndpr_purge:FAILED")
	} else {
		steps = append(steps, "ndpr_purge:ok")
	}

	// 7. PTP notifications — due today + broken (5H)
	if err := batchPTPNotifications(ctx, db); err != nil {
		slog.Error("Batch: PTP notifications failed", "err", err)
		steps = append(steps, "ptp_notifications:FAILED")
	} else {
		steps = append(steps, "ptp_notifications:ok")
	}

	// 8. FD maturity notifications — maturing in 7 days + unactioned (5H)
	if err := batchFDMaturityNotifications(ctx, db); err != nil {
		slog.Error("Batch: FD maturity notifications failed", "err", err)
		steps = append(steps, "fd_maturity_notifications:FAILED")
	} else {
		steps = append(steps, "fd_maturity_notifications:ok")
	}

	// 9. Monthly board pack email.
	//
	// This was `if time.Now().Day() == 1`, which fires the wrong number of times in
	// both directions: zero if the 1st is missed (RunBatchNightly always schedules for
	// TOMORROW 00:05, so a restart after 00:05 skips that day entirely and the pack is
	// lost for a whole month), and twice if anyone also triggers a manual run that day.
	// Gate on what was actually last delivered, so a missed month still goes out late
	// and a second run in the same month is a no-op.
	if boardPackDue(ctx, db) {
		if err := batchMonthlyBoardPack(ctx, db); err != nil {
			slog.Error("Batch: monthly board pack failed", "err", err)
			steps = append(steps, "board_pack:FAILED")
			WorkerBeat(ctx, db, "board_pack", "error", "", err.Error())
		} else {
			steps = append(steps, "board_pack:ok")
			WorkerBeat(ctx, db, "board_pack", "ok", "monthly board pack delivered", "")
		}
	}

	// 10. AML engine — M47: evaluate rules, create flags, auto-create SAR drafts for high/critical
	if err := RunAMLEngine(ctx, db); err != nil {
		slog.Error("Batch: AML engine failed", "err", err)
		steps = append(steps, "aml_engine:FAILED")
	} else {
		steps = append(steps, "aml_engine:ok")
	}

	// 12. DPD-90 alerts — loans crossing 90-day threshold today
	if err := batchDPD90Alerts(ctx, db); err != nil {
		slog.Error("Batch: DPD-90 alerts failed", "err", err)
		steps = append(steps, "dpd90_alerts:FAILED")
	} else {
		steps = append(steps, "dpd90_alerts:ok")
	}

	// 13. Vendor integration key expiry alerts — 7-day warning
	if err := batchAPIKeyExpiryAlerts(ctx, db); err != nil {
		slog.Error("Batch: API key expiry alerts failed", "err", err)
		steps = append(steps, "api_key_expiry:FAILED")
	} else {
		steps = append(steps, "api_key_expiry:ok")
	}

	// 12. Campaign delivery failure alerts
	if err := batchCampaignDeliveryAlerts(ctx, db); err != nil {
		slog.Error("Batch: campaign delivery alerts failed", "err", err)
		steps = append(steps, "campaign_delivery_alerts:FAILED")
	} else {
		steps = append(steps, "campaign_delivery_alerts:ok")
	}

	// 13. Auto-close resolved helpdesk tickets idle for 7+ days
	if err := batchAutoCloseTickets(ctx, db); err != nil {
		slog.Error("Batch: auto-close tickets failed", "err", err)
		steps = append(steps, "auto_close_tickets:FAILED")
	} else {
		steps = append(steps, "auto_close_tickets:ok")
	}

	// 14. Scheduled BI report delivery
	if err := batchRunScheduledBIReports(ctx, db); err != nil {
		slog.Error("Batch: scheduled BI reports failed", "err", err)
		steps = append(steps, "bi_scheduled_reports:FAILED")
	} else {
		steps = append(steps, "bi_scheduled_reports:ok")
	}

	// 15. Reporting rollups.
	//
	// collections_daily_kpi is what Collections Performance and Agent Performance
	// read, and nothing has ever written to it. The rollup is re-runnable over a
	// window, so a 35-day pass each night both fills yesterday and corrects any
	// late-logged activity in the preceding month.
	if err := batchRebuildReportingRollups(ctx, db); err != nil {
		slog.Error("Batch: reporting rollups failed", "err", err)
		steps = append(steps, "reporting_rollups:FAILED")
	} else {
		steps = append(steps, "reporting_rollups:ok")
	}

	// Status must reflect the STEPS, not just batchErr.
	//
	// Only the first two steps assign batchErr; steps 3-15 append ":FAILED" to
	// `steps` and leave it nil. So a run with failing steps recorded
	// status='success' and looked healthy — 32 of 57 logged runs contain a
	// ":FAILED" step and every one of them says 'success', including
	// campaign_delivery_alerts failing on every run for days.
	//
	// batchErr is still what this function RETURNS, so RunBatchNightly's logging
	// contract is unchanged; this only fixes what gets recorded.
	status := "success"
	if batchErr != nil {
		status = "partial"
	} else {
		for _, s := range steps {
			if strings.HasSuffix(s, ":FAILED") {
				status = "partial"
				break
			}
		}
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

// batchPortfolioSnapshot computes today's portfolio metrics and writes a snapshot row.
//
// It used to read loan_applications and treat DAYS SINCE BOOKING as if it were days past
// due: every active loan booked more than 90 days ago counted as NPL and as PAR30/60/90,
// with "outstanding" taken as the approved amount, which never falls as the customer
// repays. A perfectly performing four-month-old loan was 100% non-performing here — and
// because this writes a dated history table, every nightly run baked that into a time
// series. Nothing reads portfolio_daily_snapshot today (kpiPortfolioTrend moved to
// cbs_portfolio_snapshot), which is the only reason it never surfaced on a screen.
//
// It now measures the real book: outstanding principal from cbs_loans, schedule-derived
// DPD (migration 151) for the PAR buckets, and the canonical NPL rule (migration 261).
// That also gives the workspace genuine PAR history, which cbs_portfolio_snapshot does
// not carry — it stores zeros for the PAR columns.
func batchPortfolioSnapshot(ctx context.Context, db *core.DB) error {
	today := time.Now().Format("2006-01-02")

	rows, err := db.PGQuery(ctx, `
		SELECT
			COUNT(*)                                                       AS total_loans,
			COALESCE(SUM(op), 0)                                           AS total_outstanding_kobo,
			COALESCE(SUM(op) FILTER (WHERE app.is_npl(status, dpd)), 0)    AS total_npls_kobo,
			COALESCE(SUM(op) FILTER (WHERE dpd > 30), 0)                   AS par30_kobo,
			COALESCE(SUM(op) FILTER (WHERE dpd > 60), 0)                   AS par60_kobo,
			COALESCE(SUM(op) FILTER (WHERE dpd > 90), 0)                   AS par90_kobo,
			COALESCE(SUM(loan_amount_kobo) FILTER (WHERE start_date::date = $1::date), 0) AS new_disbursements_kobo
		FROM (SELECT status, outstanding_principal_kobo AS op, loan_amount_kobo, start_date,
		             `+cbsLoanDPDBare+` AS dpd
		      FROM cbs_loans WHERE status NOT IN ('Closed','Revoked')) x`, today)
	if err != nil {
		return fmt.Errorf("portfolio query: %w", err)
	}
	if len(rows) == 0 {
		// No loans in the DB yet — write a zero-row snapshot and continue.
		rows = []map[string]any{{
			"total_loans": int64(0), "total_outstanding_kobo": int64(0),
			"total_npls_kobo": int64(0), "npl_ratio_bps": int64(0),
			"par30_kobo": int64(0), "par60_kobo": int64(0),
			"par90_kobo": int64(0), "new_disbursements_kobo": int64(0),
		}}
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

// batchCBSPortfolioSnapshot records the real Udara/CBS loan + FD book once per day.
// The native loan_applications/collection_assignments tables are empty (the workspace
// is a front-end to Udara), so the Executive Overview reads the CBS-synced tables live —
// and this snapshot gives those live KPIs a real daily history for trendlines and
// vs-last-period deltas. Idempotent: re-running the same day overwrites that day's row.
//
// Loan status vocabulary in cbs_loans: Active, Closed, Defaulting, Expired, Revoked.
//
//	open loans = NOT IN ('Closed','Revoked');  NPL = Defaulting/Expired;  performing = Active.
func batchCBSPortfolioSnapshot(ctx context.Context, db *core.DB) error {
	today := time.Now().Format("2006-01-02")

	loan := map[string]any{}
	if rows, err := db.PGQuery(ctx, `
		SELECT
			COUNT(*)                                                          AS loans_total,
			COUNT(*) FILTER (WHERE status = 'Active')                        AS loans_active,
			COUNT(DISTINCT cbs_customer_id) FILTER (WHERE status = 'Active') AS borrowers_active,
			COALESCE(SUM(outstanding_principal_kobo) FILTER (WHERE status NOT IN ('Closed','Revoked')), 0) AS outstanding_principal_kobo,
			COALESCE(SUM(outstanding_interest_kobo)  FILTER (WHERE status NOT IN ('Closed','Revoked')), 0) AS outstanding_interest_kobo,
			-- Canonical NPL (app.is_npl, migration 261): DPD > 90 OR CBS Defaulting/Expired.
			-- Status alone missed loans the repayment schedule had already shown to be
			-- months in arrears, so this nightly snapshot — which the Overview, Finance
			-- and KPI screens all read — disagreed with the Risk module on the same book.
			COALESCE(SUM(outstanding_principal_kobo) FILTER (
				WHERE status NOT IN ('Closed','Revoked') AND app.is_npl(status, `+cbsLoanDPDBare+`)), 0) AS npl_kobo,
			COALESCE(SUM(outstanding_principal_kobo) FILTER (WHERE status = 'Active'), 0)                   AS performing_kobo
		FROM cbs_loans`); err == nil && len(rows) > 0 {
		loan = rows[0]
	}

	fd := map[string]any{}
	if rows, err := db.PGQuery(ctx, `
		SELECT
			COUNT(*) FILTER (WHERE status = 'Active')                                 AS fd_active_count,
			COALESCE(SUM(principal_kobo)      FILTER (WHERE status = 'Active'), 0)     AS fd_principal_kobo,
			COALESCE(SUM(ledger_balance_kobo) FILTER (WHERE status = 'Active'), 0)     AS fd_ledger_balance_kobo
		FROM cbs_fixed_deposits`); err == nil && len(rows) > 0 {
		fd = rows[0]
	}

	_, err := db.PGExec(ctx, `
		INSERT INTO cbs_portfolio_snapshot
			(snapshot_date, loans_total, loans_active, borrowers_active,
			 outstanding_principal_kobo, outstanding_interest_kobo, npl_kobo, performing_kobo,
			 fd_active_count, fd_principal_kobo, fd_ledger_balance_kobo)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
		ON CONFLICT (snapshot_date) DO UPDATE SET
			loans_total                = EXCLUDED.loans_total,
			loans_active               = EXCLUDED.loans_active,
			borrowers_active           = EXCLUDED.borrowers_active,
			outstanding_principal_kobo = EXCLUDED.outstanding_principal_kobo,
			outstanding_interest_kobo  = EXCLUDED.outstanding_interest_kobo,
			npl_kobo                   = EXCLUDED.npl_kobo,
			performing_kobo            = EXCLUDED.performing_kobo,
			fd_active_count            = EXCLUDED.fd_active_count,
			fd_principal_kobo          = EXCLUDED.fd_principal_kobo,
			fd_ledger_balance_kobo     = EXCLUDED.fd_ledger_balance_kobo`,
		today,
		toInt64(loan["loans_total"]),
		toInt64(loan["loans_active"]),
		toInt64(loan["borrowers_active"]),
		toInt64(loan["outstanding_principal_kobo"]),
		toInt64(loan["outstanding_interest_kobo"]),
		toInt64(loan["npl_kobo"]),
		toInt64(loan["performing_kobo"]),
		toInt64(fd["fd_active_count"]),
		toInt64(fd["fd_principal_kobo"]),
		toInt64(fd["fd_ledger_balance_kobo"]),
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
				-- $1 * interval, not ($1 || ' hours')::interval: concatenation makes
				-- Postgres infer $1 as text and pgx cannot encode a number into it.
				-- The error here is discarded, so this rule was failing silently.
				AND created_at < NOW() - ($1 * interval '1 hour')`, threshold)
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
			AND updated_at < NOW() - ($2 * interval '1 hour')
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

// batchKPISnapshot writes a summary of one day's key business metrics into
// kpi_daily_snapshot. Uses INSERT … ON CONFLICT DO UPDATE so re-running is idempotent.
//
// It snapshots YESTERDAY, not today. runBatch fires at 00:05, so "today" was a
// five-minute-old day and every windowed metric counted only what happened between
// 00:00 and 00:05 — which is why all 57 daily rows written so far read 0. Yesterday is
// both complete and fully landed: measured against the source tables, activity arrives
// in real time and nothing backfills overnight.
func batchKPISnapshot(ctx context.Context, db *core.DB) error {
	target := time.Now().AddDate(0, 0, -1).Format("2006-01-02")

	type metric struct {
		col string
		q   string
		// pointInTime marks a metric describing the book as it stands rather than
		// activity inside the day, so it takes no date parameter.
		pointInTime bool
	}
	metrics := []metric{
		{col: "new_applications", q: `SELECT COUNT(*) FROM loan_applications WHERE created_at::date = $1`},
		{col: "approved_applications", q: `SELECT COUNT(*) FROM loan_applications WHERE status='approved' AND updated_at::date = $1`},
		{col: "disbursements_count", q: `SELECT COUNT(*) FROM loan_applications WHERE status='disbursed' AND disbursed_at::date = $1`},
		{col: "disbursements_kobo", q: `SELECT COALESCE(SUM(disbursed_amount_kobo),0) FROM loan_applications WHERE status='disbursed' AND disbursed_at::date = $1`},
		{col: "repayments_count", q: `SELECT COUNT(*) FROM loan_repayments WHERE payment_date::date = $1`},
		{col: "repayments_kobo", q: `SELECT COALESCE(SUM(amount_kobo),0) FROM loan_repayments WHERE payment_date::date = $1`},
		{col: "ptp_set", q: `SELECT COUNT(*) FROM collection_promises WHERE created_at::date = $1`},
		// collection_promises has no `status` column — the outcome lives in the
		// is_kept boolean. The old query selected status, so it errored on EVERY run
		// and the error was swallowed below and stored as a plausible-looking 0.
		// A promise is broken on the day it fell due, not the day the row was touched.
		{col: "ptp_broken", q: `SELECT COUNT(*) FROM collection_promises WHERE is_kept = FALSE AND promised_date = $1`},
		// collection_calls and npl_kobo exist on the table but were missing from the
		// INSERT column list below, so they were 0 by construction whatever happened.
		{col: "collection_calls", q: `SELECT COUNT(*) FROM collection_contacts WHERE created_at::date = $1`},
		{col: "tickets_opened", q: `SELECT COUNT(*) FROM helpdesk_tickets WHERE created_at::date = $1`},
		{col: "tickets_closed", q: `SELECT COUNT(*) FROM helpdesk_tickets WHERE status='resolved' AND updated_at::date = $1`},
		{col: "active_loans", q: `SELECT COUNT(*) FROM loan_applications WHERE status='active'`, pointInTime: true},
		{col: "total_book_kobo", q: `SELECT COALESCE(SUM(disbursed_amount_kobo),0) FROM loan_applications WHERE status='active'`, pointInTime: true},
		{col: "npl_kobo", q: `SELECT COALESCE(SUM(outstanding_principal_kobo + outstanding_interest_kobo),0)
			FROM cbs_loans
			WHERE status NOT IN ('Closed','Revoked') AND app.is_npl(status, ` + cbsLoanDPDBare + `)`, pointInTime: true},
	}

	vals := map[string]int64{}
	for _, m := range metrics {
		var rows []map[string]any
		var err error
		if m.pointInTime {
			rows, err = db.PGQuery(ctx, m.q)
		} else {
			rows, err = db.PGQuery(ctx, m.q, target)
		}
		if err != nil {
			// Never let a broken query masquerade as a real zero — that is exactly
			// how the ptp_broken defect survived unnoticed for the life of the table.
			slog.Error("kpi snapshot: metric query failed", "metric", m.col, "date", target, "err", err)
			vals[m.col] = 0
			continue
		}
		if len(rows) == 0 {
			vals[m.col] = 0
			continue
		}
		for _, v := range rows[0] {
			vals[m.col] = toInt64(v)
			break
		}
	}

	_, err := db.PGExec(ctx, `
		INSERT INTO kpi_daily_snapshot
			(snapshot_date, new_applications, approved_applications,
			 disbursements_count, disbursements_kobo,
			 repayments_count, repayments_kobo,
			 ptp_set, ptp_broken, collection_calls,
			 tickets_opened, tickets_closed,
			 active_loans, total_book_kobo, npl_kobo)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
		ON CONFLICT (snapshot_date) DO UPDATE SET
			new_applications     = EXCLUDED.new_applications,
			approved_applications= EXCLUDED.approved_applications,
			disbursements_count  = EXCLUDED.disbursements_count,
			disbursements_kobo   = EXCLUDED.disbursements_kobo,
			repayments_count     = EXCLUDED.repayments_count,
			repayments_kobo      = EXCLUDED.repayments_kobo,
			ptp_set              = EXCLUDED.ptp_set,
			ptp_broken           = EXCLUDED.ptp_broken,
			collection_calls     = EXCLUDED.collection_calls,
			tickets_opened       = EXCLUDED.tickets_opened,
			tickets_closed       = EXCLUDED.tickets_closed,
			active_loans         = EXCLUDED.active_loans,
			total_book_kobo      = EXCLUDED.total_book_kobo,
			npl_kobo             = EXCLUDED.npl_kobo`,
		target,
		vals["new_applications"], vals["approved_applications"],
		vals["disbursements_count"], vals["disbursements_kobo"],
		vals["repayments_count"], vals["repayments_kobo"],
		vals["ptp_set"], vals["ptp_broken"], vals["collection_calls"],
		vals["tickets_opened"], vals["tickets_closed"],
		vals["active_loans"], vals["total_book_kobo"], vals["npl_kobo"])
	return err
}

// batchNDPRRetentionPurge enforces the data retention schedules required by NDPR / CBN (P12-01).
// Marketing contacts older than 2 years are deleted; activity logs older than 5 years are purged.
// Each purge is logged to retention_purge_log for audit purposes.
func batchNDPRRetentionPurge(ctx context.Context, db *core.DB) error {
	today := time.Now().Format("2006-01-02")
	type purgeRule struct {
		table   string
		where   string
		archive bool
	}
	rules := []purgeRule{
		// Marketing contacts: 2-year NDPR consent-based retention
		{table: "campaign_contacts", where: "created_at < NOW() - INTERVAL '2 years'", archive: false},
		// Activity / session logs: 5-year operational retention
		{table: "o3c_activity_log", where: "ts < NOW() - INTERVAL '5 years'", archive: false},
	}

	for _, rule := range rules {
		countRows, err := db.PGQuery(ctx, fmt.Sprintf("SELECT COUNT(*) AS n FROM %s WHERE %s", rule.table, rule.where))
		if err != nil {
			slog.Warn("NDPR purge: count query failed", "table", rule.table, "err", err)
			continue
		}
		n := int64(0)
		if len(countRows) > 0 {
			n = toInt64(countRows[0]["n"])
		}
		if n == 0 {
			db.PGExec(ctx, //nolint:errcheck
				`INSERT INTO retention_purge_log (run_date, table_name, records_purged, records_archived, notes)
				 VALUES ($1, $2, 0, 0, 'no records eligible')`, today, rule.table)
			continue
		}

		_, delErr := db.PGExec(ctx, fmt.Sprintf("DELETE FROM %s WHERE %s", rule.table, rule.where))
		if delErr != nil {
			slog.Error("NDPR purge: delete failed", "table", rule.table, "err", delErr)
		}
		purged := n
		if delErr != nil {
			purged = 0
		}
		db.PGExec(ctx, //nolint:errcheck
			`INSERT INTO retention_purge_log (run_date, table_name, records_purged, records_archived, notes)
			 VALUES ($1, $2, $3, 0, $4)`,
			today, rule.table, purged,
			fmt.Sprintf("auto-purge: %d records deleted per NDPR retention policy", purged))
		slog.Info("NDPR purge completed", "table", rule.table, "deleted", purged)
	}
	return nil
}

// batchPTPNotifications fires daily notifications for:
//   - PTPs due today → notify assigned collections agent
//   - PTPs that are broken (promised_date < today, is_kept is NULL) → notify agent + collections_head
func batchPTPNotifications(ctx context.Context, db *core.DB) error {
	// Due today
	dueRows, err := db.PGQuery(ctx, `
		SELECT p.id, p.cif_number, p.promised_amount_kobo, p.agent_user_id
		FROM collection_promises p
		WHERE p.promised_date = CURRENT_DATE
		  AND (p.is_kept IS NULL OR p.is_kept = FALSE)
		  AND p.actual_date IS NULL`)
	if err != nil {
		return err
	}
	for _, row := range dueRows {
		agentID := toInt64(row["agent_user_id"])
		if agentID == 0 {
			continue
		}
		go Notify(ctx, db, NotifPayload{
			EventType: EvtPTPDueToday,
			UserID:    agentID,
			Title:     "PTP due today",
			Body:      fmt.Sprintf("Promise to pay from CIF %s for ₦%.2f is due today.", str(row["cif_number"]), float64(toInt64(row["promised_amount_kobo"]))/100),
			ActionURL: "/collections/promises",
			EntityRef: fmt.Sprintf("ptp:%d", toInt64(row["id"])),
		})
	}

	// Broken PTPs — promised_date < today, no payment recorded
	brokenRows, err := db.PGQuery(ctx, `
		SELECT p.id, p.cif_number, p.promised_amount_kobo, p.promised_date, p.agent_user_id
		FROM collection_promises p
		WHERE p.promised_date < CURRENT_DATE
		  AND (p.is_kept IS NULL OR p.is_kept = FALSE)
		  AND p.actual_date IS NULL`)
	if err != nil {
		return err
	}
	for _, row := range brokenRows {
		agentID := toInt64(row["agent_user_id"])
		body := fmt.Sprintf("CIF %s missed a PTP of ₦%.2f due on %s.",
			str(row["cif_number"]),
			float64(toInt64(row["promised_amount_kobo"]))/100,
			str(row["promised_date"]))
		p := NotifPayload{
			EventType: EvtPTPBroken,
			Title:     "Broken PTP",
			Body:      body,
			ActionURL: "/collections/promises",
			EntityRef: fmt.Sprintf("ptp:%d", toInt64(row["id"])),
		}
		if agentID > 0 {
			go Notify(ctx, db, NotifPayload{EventType: p.EventType, UserID: agentID, Title: p.Title, Body: p.Body, ActionURL: p.ActionURL, EntityRef: p.EntityRef})
		}
		go NotifyRole(ctx, db, "collections_head", p)
	}

	slog.Info("Batch: PTP notifications sent", "due_today", len(dueRows), "broken", len(brokenRows))
	return nil
}

// batchFDMaturityNotifications fires daily notifications for:
//   - FDs maturing in exactly 7 days → notify finance_officer role
//   - FDs past maturity but still Active → notify finance_head role
//
// Both queries used to read app.fd_transactions, which has 0 rows — so this
// worker has never sent a single FD notification while cheerfully logging
// "soon=0 unactioned=0". The live book is app.cbs_fixed_deposits.
//
// The "no liquidation/rollover recorded" NOT EXISTS sub-selects are gone with
// it. They matched on customer_name against a table that does not populate, and
// the CBS register has no action ledger to check: what it has instead is
// status. A deposit that has been liquidated or rolled over leaves the Active
// set on the next sync, so "still Active past its maturity date" IS the
// unactioned condition, read straight off the book.
//
// Not attempted here (out of scope, needs a schema change): telling a genuine
// new placement apart from a rollover of a maturing deposit. rollover_count
// exists on the table but nothing populates it, so any maturity figure below
// may double-count a deposit that simply rolls.
func batchFDMaturityNotifications(ctx context.Context, db *core.DB) error {
	// Maturing in 7 days. The ::date cast is load-bearing — gts parses Udara's
	// timestamps as UTC while the session is Africa/Lagos, so every maturity sits
	// at 01:00:00+01 and a bare `= CURRENT_DATE + 7` matches nothing.
	// Unfunded shells (hasDisbursed=false, ₦0) are excluded: nothing to pay out.
	soonRows, err := db.PGQuery(ctx, `
		SELECT f.cbs_account_number,
		       COALESCE(NULLIF(btrim(f.raw->>'name'),''), f.cbs_customer_id) AS customer_name,
		       f.principal_kobo,
		       COALESCE(f.accrued_interest_kobo,0) AS accrued_interest_kobo,
		       to_char(f.maturity_date,'YYYY-MM-DD') AS maturity_date
		FROM cbs_fixed_deposits f
		WHERE f.status = 'Active'
		  AND f.raw->>'hasDisbursed' IS DISTINCT FROM 'false'
		  AND f.maturity_date::date = CURRENT_DATE + 7
		ORDER BY f.principal_kobo DESC`)
	if err != nil {
		return err
	}
	for _, row := range soonRows {
		acct := str(row["cbs_account_number"])
		amount := toInt64(row["principal_kobo"]) + toInt64(row["accrued_interest_kobo"])
		p := NotifPayload{
			EventType: EvtFDMaturing7Days,
			Title:     "FD maturing in 7 days",
			Body: fmt.Sprintf("%s (a/c %s) — %s principal and interest matures on %s. Confirm rollover or liquidation instructions with the customer.",
				str(row["customer_name"]), acct, fmtKoboServer(amount), str(row["maturity_date"])),
			ActionURL: fdDeepLink(acct),
			EntityRef: "fd:" + acct,
		}
		go NotifyRole(ctx, db, "finance_officer", p)
	}

	// Past maturity and still on the book. Not just yesterday: the old query asked
	// for maturity_date = CURRENT_DATE - 1, so a deposit that slipped through on day
	// one was never mentioned again. Six deposits are overdue right now — ₦497.2m of
	// principal on ₦58.6m of accrued interest, 1 to 4 days past — and nothing in the
	// workspace has ever raised one of them.
	//
	// One grouped digest for the whole backlog rather than a notification per
	// deposit per day: the GroupKey folds repeat sends into a single unread row that
	// updates in place, so finance_head gets one standing item instead of six fresh
	// alarms every morning until someone acts.
	var unactionedCount int64
	unactionedRows, err := db.PGQuery(ctx, `
		SELECT COUNT(*) AS n,
		       COALESCE(SUM(f.principal_kobo),0) AS principal_kobo,
		       COALESCE(SUM(f.accrued_interest_kobo),0) AS accrued_interest_kobo,
		       COALESCE(MAX(CURRENT_DATE - f.maturity_date::date),0) AS oldest_days
		FROM cbs_fixed_deposits f
		WHERE f.status = 'Active'
		  AND f.raw->>'hasDisbursed' IS DISTINCT FROM 'false'
		  AND f.maturity_date::date < CURRENT_DATE`)
	if err != nil {
		return err
	}
	if len(unactionedRows) > 0 {
		row := unactionedRows[0]
		unactionedCount = toInt64(row["n"])
		if unactionedCount > 0 {
			amount := toInt64(row["principal_kobo"]) + toInt64(row["accrued_interest_kobo"])
			noun := "deposit has"
			if unactionedCount > 1 {
				noun = "deposits have"
			}
			p := NotifPayload{
				EventType: EvtFDMaturedUnactioned,
				Title:     fmt.Sprintf("%d matured FD(s) — no action taken", unactionedCount),
				Body: fmt.Sprintf("%d fixed %s passed maturity and are still open — %s principal and interest, the oldest %d day(s) overdue. Neither liquidated nor rolled over.",
					unactionedCount, noun, fmtKoboServer(amount), toInt64(row["oldest_days"])),
				ActionURL: "/deposits",
				EntityRef: "fd_past_due",
				GroupKey:  "fd_past_due_finance",
				Priority:  "urgent",
			}
			go NotifyRole(ctx, db, "finance_head", p)
		}
	}

	slog.Info("Batch: FD maturity notifications", "soon", len(soonRows), "unactioned", unactionedCount)
	return nil
}

// batchMonthlyBoardPack assembles key KPIs and emails the board distribution list.
// Called only on day 1 of each month from runBatch.
// Recipients are read from the BOARD_EMAIL_LIST env var (comma-separated).
// boardPackDue reports whether the monthly board pack still owes a delivery for the
// current calendar month, judged by when one was last sent rather than by today's date.
// The comparison is done in SQL so the answer does not depend on how the driver hands
// back a timestamptz.
//
// A missed month therefore goes out on the next batch run instead of being lost, and a
// second run in the same month sends nothing. Note the consequence on first deploy:
// with no heartbeat recorded yet, the pack is considered owed and will send on the next
// batch run. That is the intended reading of "this month has not been delivered".
func boardPackDue(ctx context.Context, db *core.DB) bool {
	rows, err := db.PGQuery(ctx, `
		SELECT (last_ok_at IS NULL
		        OR date_trunc('month', last_ok_at) < date_trunc('month', NOW())) AS due
		FROM worker_heartbeats WHERE worker_key = 'board_pack'`)
	if err != nil {
		// Err toward silence: a duplicate board pack to the board is worse than a late one.
		slog.Error("board pack: could not read last delivery — skipping", "err", err)
		return false
	}
	if len(rows) == 0 {
		return true // never delivered
	}
	due, _ := rows[0]["due"].(bool)
	return due
}

func batchMonthlyBoardPack(ctx context.Context, db *core.DB) error {
	boardList := resolveCredKey(ctx, db, "BOARD_EMAIL_LIST")
	if boardList == "" {
		slog.Info("Board pack: BOARD_EMAIL_LIST not configured — skipping")
		return nil
	}

	// Collect previous month's KPIs
	prevMonth := time.Now().AddDate(0, -1, 0).Format("January 2006")

	type metric struct{ label, value string }
	var metrics []metric

	// Loan book
	if rows, err := db.PGQuery(ctx, `
		SELECT
		    COUNT(*) FILTER (WHERE status NOT IN ('declined','draft'))     AS total_apps,
		    COALESCE(SUM(amount_approved_kobo) FILTER (WHERE status = 'active'), 0) AS book_kobo,
		    COUNT(*) FILTER (WHERE status = 'active')                     AS active_loans,
		    COALESCE(SUM(amount_approved_kobo) FILTER (
		        WHERE status = 'active'
		          AND GREATEST(0, CURRENT_DATE - booked_at::date) > 30), 0) AS par30_kobo
		FROM loan_applications`); err == nil && len(rows) > 0 {
		r := rows[0]
		bookKobo := toInt64(r["book_kobo"])
		par30Kobo := toInt64(r["par30_kobo"])
		par30Pct := 0.0
		if bookKobo > 0 {
			par30Pct = float64(par30Kobo) / float64(bookKobo) * 100
		}
		metrics = append(metrics,
			metric{"Active Loans", fmt.Sprintf("%d", toInt64(r["active_loans"]))},
			metric{"Loan Book (₦)", fmt.Sprintf("%.2f", float64(bookKobo)/100)},
			metric{"PAR30 (%)", fmt.Sprintf("%.1f%%", par30Pct)},
			metric{"Total Applications", fmt.Sprintf("%d", toInt64(r["total_apps"]))},
		)
	}

	// Fixed deposits.
	//
	// Same defect as the on-demand board pack in compliance.go, and the same fix:
	// this read the retired fd_transactions ops book, empty since the deposit desk
	// moved to Udara, so the MONTHLY board pack went out reporting "FD Count 0 /
	// FD Book ₦0.00" against a real funded book of 213 deposits and ₦19.86bn.
	// Live CBS register now, Active and funded, principal converted from kobo.
	if rows, err := db.PGQuery(ctx, `
		SELECT COUNT(*) AS fd_count,
		       COALESCE(SUM(principal_kobo),0)::numeric / 100 AS total_principal
		FROM cbs_fixed_deposits
		WHERE status='Active' AND `+sqlFDFunded); err == nil && len(rows) > 0 {
		r := rows[0]
		metrics = append(metrics,
			metric{"FD Count", fmt.Sprintf("%d", toInt64(r["fd_count"]))},
			metric{"FD Book (₦)", fmt.Sprintf("%.2f", toFloat64(r["total_principal"]))},
		)
	}

	// Open helpdesk tickets
	if rows, err := db.PGQuery(ctx, `SELECT COUNT(*) AS c FROM helpdesk_tickets WHERE status NOT IN ('resolved','closed')`); err == nil && len(rows) > 0 {
		metrics = append(metrics, metric{"Open Support Tickets", fmt.Sprintf("%d", toInt64(rows[0]["c"]))})
	}

	// Build HTML rows
	rowsHTML := ""
	for _, m := range metrics {
		rowsHTML += fmt.Sprintf(`<tr><td style="padding:8px 16px;border-bottom:1px solid #E2E8F0;color:#64748B">%s</td><td style="padding:8px 16px;border-bottom:1px solid #E2E8F0;font-weight:600;text-align:right">%s</td></tr>`, m.label, m.value)
	}

	htmlBody := fmt.Sprintf(`
<div style="font-family:DM Sans,sans-serif;max-width:600px;margin:0 auto">
  <div style="background:#0E2841;color:white;padding:20px 24px;border-radius:8px 8px 0 0">
    <h1 style="margin:0;font-size:20px;font-weight:700">O3 Capital Board Pack</h1>
    <p style="margin:4px 0 0;font-size:13px;opacity:.8">%s — Key Performance Indicators</p>
  </div>
  <div style="background:#F4F6F8;padding:20px 24px;border-radius:0 0 8px 8px">
    <table style="width:100%%;border-collapse:collapse;background:white;border-radius:8px;overflow:hidden">
      <thead>
        <tr><th style="padding:10px 16px;background:#0E2841;color:white;text-align:left;font-size:12px">Metric</th>
            <th style="padding:10px 16px;background:#0E2841;color:white;text-align:right;font-size:12px">Value</th></tr>
      </thead>
      <tbody>%s</tbody>
    </table>
    <p style="margin:16px 0 0;font-size:11px;color:#94A3B8">
      This report was auto-generated by O3 Capital Workspace on %s.
      For the full interactive dashboard, log in at <a href="https://reports.o3cards.com" style="color:#0E2841">reports.o3cards.com</a>.
    </p>
  </div>
</div>`, prevMonth, rowsHTML, time.Now().Format("2 January 2006"))

	// Parse and email each recipient
	for _, email := range splitTrim(boardList, ",") {
		if email == "" {
			continue
		}
		res := SendMail(ctx, db, SendMailOptions{
			To:       []MailAddress{{Email: email}},
			Subject:  fmt.Sprintf("O3 Capital Board Pack — %s", prevMonth),
			HTMLBody: htmlBody,
			TextBody: fmt.Sprintf("O3 Capital Board Pack — %s\n\nPlease view in an HTML email client.", prevMonth),
			Kind:     "board_pack",
			Category: "board_pack",
		})
		if !res.OK {
			slog.Warn("Board pack: email failed", "to", email, "err", res.Error)
		}
	}

	slog.Info("Board pack email sent", "month", prevMonth, "recipients", boardList)
	return nil
}

// batchDPD90Alerts notifies collections_head and risk_officer the first time a
// customer's DPD crosses the 90-day threshold. Uses dpd >= 90 (not = 90) so
// loans aren't missed when the batch is skipped on the crossing night.
// Dedup: only fires when yesterday's snapshot had dpd < 90 (i.e. first crossing).
// One notification per customer — DISTINCT ON picks the highest-DPD loan per CIF.
func batchDPD90Alerts(ctx context.Context, db *core.DB) error {
	rows, err := db.PGQuery(ctx, `
		SELECT DISTINCT ON (s.cif_number)
		       s.cif_number, s.outstanding_kobo, la.id AS loan_id, la.applicant_name
		FROM loan_dpd_daily_snapshot s
		JOIN loan_applications la ON la.applicant_cif = s.cif_number
		WHERE s.snapshot_date = CURRENT_DATE
		  AND s.dpd >= 90
		  AND la.status IN ('active','repaying','overdue')
		  AND NOT EXISTS (
		    SELECT 1 FROM loan_dpd_daily_snapshot prev
		    WHERE prev.cif_number = s.cif_number
		      AND prev.snapshot_date = CURRENT_DATE - 1
		      AND prev.dpd >= 90
		  )
		ORDER BY s.cif_number, s.dpd DESC`)
	if err != nil {
		slog.Error("batchDPD90Alerts: query failed", "err", err)
		return err
	}
	for _, row := range rows {
		name := str(row["applicant_name"])
		cif := str(row["cif_number"])
		loanID := toInt64(row["loan_id"])
		body := fmt.Sprintf("Loan for %s (CIF: %s) has reached 90 days past due. Immediate action required.", name, cif)
		p := NotifPayload{
			EventType: EvtAccountDPD90,
			Title:     fmt.Sprintf("DPD-90 alert: %s", name),
			Body:      body,
			ActionURL: fmt.Sprintf("/collections/%d", loanID),
			EntityRef: cif,
		}
		go NotifyRole(ctx, db, "collections_head", p)
		go NotifyRole(ctx, db, "risk_officer", p)
	}
	return nil
}

// batchAPIKeyExpiryAlerts fires when a vendor integration key expires within 7 days.
// Deduped: only fires once per integration per day.
func batchAPIKeyExpiryAlerts(ctx context.Context, db *core.DB) error {
	rows, err := db.PGQuery(ctx, `
		SELECT name, key_expiry
		FROM vendor_integrations
		WHERE key_expiry IS NOT NULL
		  AND key_expiry BETWEEN NOW() AND NOW() + INTERVAL '7 days'
		  AND status != 'inactive'
		  AND NOT EXISTS (
		    SELECT 1 FROM notifications
		    WHERE entity_ref = name
		      AND type = $1
		      AND created_at::date = CURRENT_DATE
		  )`, EvtAPIKeyExpiry)
	if err != nil {
		slog.Error("batchAPIKeyExpiryAlerts: query failed", "err", err)
		return err
	}
	for _, row := range rows {
		name := str(row["name"])
		expiry := str(row["key_expiry"])
		go NotifyRole(ctx, db, "admin", NotifPayload{
			EventType: EvtAPIKeyExpiry,
			Title:     fmt.Sprintf("API key expiring soon: %s", name),
			Body:      fmt.Sprintf("The API key for %s expires on %s. Rotate it before it lapses.", name, expiry),
			ActionURL: "/admin/integrations",
			EntityRef: name,
		})
	}
	return nil
}

// batchCampaignDeliveryAlerts fires when a campaign's failure count exceeds 10
// for sends that happened today. Deduped: only fires once per campaign per day.
func batchCampaignDeliveryAlerts(ctx context.Context, db *core.DB) error {
	rows, err := db.PGQuery(ctx, `
		SELECT id, name, email_failed, sms_failed, created_by
		FROM campaigns
		WHERE (email_failed + sms_failed) > 10
		  AND updated_at::date = CURRENT_DATE
		  AND status IN ('active','paused','completed')
		  AND NOT EXISTS (
		    SELECT 1 FROM notifications
		    WHERE entity_ref = 'campaign-' || id::text
		      AND type = $1
		      AND created_at::date = CURRENT_DATE
		  )`, EvtCampaignDeliveryFailed)
	if err != nil {
		slog.Error("batchCampaignDeliveryAlerts: query failed", "err", err)
		return err
	}
	for _, row := range rows {
		campaignID := toInt64(row["id"])
		name := str(row["name"])
		emailFailed := toInt64(row["email_failed"])
		smsFailed := toInt64(row["sms_failed"])
		createdBy := toInt64(row["created_by"])
		body := fmt.Sprintf("Campaign '%s' had %d email and %d SMS delivery failures today.", name, emailFailed, smsFailed)
		p := NotifPayload{
			EventType: EvtCampaignDeliveryFailed,
			Title:     fmt.Sprintf("Delivery failures: %s", name),
			Body:      body,
			ActionURL: fmt.Sprintf("/campaigns/%d", campaignID),
			EntityRef: fmt.Sprintf("campaign-%d", campaignID),
		}
		if createdBy > 0 {
			go Notify(ctx, db, NotifPayload{EventType: p.EventType, UserID: createdBy, Title: p.Title, Body: p.Body, ActionURL: p.ActionURL, EntityRef: p.EntityRef})
		}
		go NotifyRole(ctx, db, "admin", p)
	}
	return nil
}

// splitTrim splits s by sep and trims whitespace from each element.
func splitTrim(s, sep string) []string {
	var out []string
	for _, p := range strings.Split(s, sep) {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}

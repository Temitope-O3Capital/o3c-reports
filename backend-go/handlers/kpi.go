package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

func RegisterKPI(r chi.Router, db *core.DB) {
	access := core.RequirePages("kpi_dashboard")
	admin := core.RequirePages("settings")

	r.With(access).Get("/dashboard", kpiDashboard(db))
	r.With(access).Get("/portfolio", kpiPortfolio(db))
	r.With(access).Get("/portfolio/trend", kpiPortfolioTrend(db))
	r.With(access).Get("/collections", kpiCollections(db))
	r.With(access).Get("/collections/trend", kpiCollectionsTrend(db))
	r.With(access).Get("/alerts", kpiAlerts(db))
	r.With(access).Put("/alerts/{id}/resolve", kpiAlertResolve(db))
	r.With(access).Get("/targets", kpiTargetsList(db))
	r.With(admin).Put("/targets", kpiTargetsUpsert(db))
}

// kpiDashboard returns a role-aware summary of key metrics.
func kpiDashboard(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}

		out := map[string]any{}
		var sources []string

		// ── Base metrics every role sees ──────────────────────────────────────────

		// Today's collections (from collections_daily_kpi for today across all agents)
		todayColl, src1, _ := db.DualScalar(ctx, "val",
			"SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.o3_loan_Repayment WHERE CAST(Repayment_Date AS DATE)=CAST(GETDATE() AS DATE)",
			`SELECT COALESCE(SUM(amount_collected_kobo),0) AS val FROM collections_daily_kpi WHERE kpi_date=CURRENT_DATE`)
		out["today_collections_kobo"] = todayColl
		sources = append(sources, src1)

		// Open LOS applications
		losRows, _ := db.PGQuery(ctx,
			`SELECT COUNT(*) AS val FROM loan_applications WHERE status NOT IN ('booked','declined','cancelled')`)
		if len(losRows) > 0 {
			out["open_los_count"] = losRows[0]["val"]
		} else {
			out["open_los_count"] = 0
		}

		// Latest portfolio outstanding from snapshot
		snapRows, _ := db.PGQuery(ctx,
			`SELECT total_outstanding_kobo, npl_ratio_bps, par30_kobo, snapshot_date
			 FROM portfolio_daily_snapshot ORDER BY snapshot_date DESC LIMIT 1`)
		if len(snapRows) > 0 {
			out["portfolio_outstanding_kobo"] = snapRows[0]["total_outstanding_kobo"]
			out["portfolio_snapshot_date"] = snapRows[0]["snapshot_date"]
		} else {
			out["portfolio_outstanding_kobo"] = 0
		}

		// ── Role-specific additions ───────────────────────────────────────────────

		switch user.Role {
		case "collections_head", "collections_agent":
			// Team or own KPI vs target for today
			var agentFilter string
			var agentArgs []any
			if user.Role == "collections_agent" {
				agentFilter = " AND agent_user_id=$1"
				agentArgs = []any{user.ID}
			}
			teamRows, err := db.PGQuery(ctx,
				fmt.Sprintf(`SELECT
					COALESCE(SUM(amount_collected_kobo),0)  AS collected_kobo,
					COALESCE(SUM(target_amount_kobo),0)     AS target_kobo,
					COALESCE(SUM(contacts_made),0)          AS contacts,
					COALESCE(SUM(promises_obtained),0)      AS promises
				 FROM collections_daily_kpi
				 WHERE kpi_date=CURRENT_DATE%s`, agentFilter),
				agentArgs...)
			if err == nil && len(teamRows) > 0 {
				out["today_kpi"] = teamRows[0]
			}

		case "recovery_head":
			// Team recovery vs target
			recovRows, _ := db.PGQuery(ctx,
				`SELECT
					COALESCE(SUM(total_recovered_kobo),0) AS recovered_kobo,
					COUNT(*) AS total_cases,
					COUNT(*) FILTER (WHERE status='active') AS open_cases
				 FROM recovery_cases`)
			if len(recovRows) > 0 {
				out["recovery_summary"] = recovRows[0]
			}

		case "md", "cfo", "coo":
			// NPL, PAR buckets from latest snapshot
			if len(snapRows) > 0 {
				out["npl_ratio_bps"] = snapRows[0]["npl_ratio_bps"]
				out["par30_kobo"] = snapRows[0]["par30_kobo"]
			}
			// DPD bucket breakdown from most recent loan_dpd_daily_snapshot
			dpdRows, _ := db.PGQuery(ctx,
				`SELECT dpd_bucket, COUNT(*) AS loan_count, COALESCE(SUM(outstanding_kobo),0) AS total_kobo
				 FROM loan_dpd_daily_snapshot
				 WHERE snapshot_date=(SELECT MAX(snapshot_date) FROM loan_dpd_daily_snapshot)
				 GROUP BY dpd_bucket ORDER BY dpd_bucket`)
			out["dpd_buckets"] = dpdRows

		case "compliance_head":
			// Open findings, overdue checklists, pending SARs
			findRows, _ := db.PGQuery(ctx,
				`SELECT COUNT(*) AS val FROM audit_findings WHERE status NOT IN ('closed','resolved')`)
			if len(findRows) > 0 {
				out["open_findings"] = findRows[0]["val"]
			}
			clRows, _ := db.PGQuery(ctx,
				`SELECT COUNT(*) AS val FROM compliance_checklists WHERE status!='completed' AND due_date<CURRENT_DATE`)
			if len(clRows) > 0 {
				out["overdue_checklists"] = clRows[0]["val"]
			}
			sarRows, _ := db.PGQuery(ctx,
				`SELECT COUNT(*) AS val FROM sars WHERE status='draft'`)
			if len(sarRows) > 0 {
				out["pending_sars"] = sarRows[0]["val"]
			}

		case "hr_manager":
			// On-leave, pending leave, open disciplinary
			onLeaveRows, _ := db.PGQuery(ctx,
				`SELECT COUNT(*) AS val FROM leave_applications
				 WHERE status='approved' AND CURRENT_DATE BETWEEN start_date AND end_date`)
			if len(onLeaveRows) > 0 {
				out["on_leave_count"] = onLeaveRows[0]["val"]
			}
			pendLeaveRows, _ := db.PGQuery(ctx,
				`SELECT COUNT(*) AS val FROM leave_applications WHERE status='pending'`)
			if len(pendLeaveRows) > 0 {
				out["pending_leave_count"] = pendLeaveRows[0]["val"]
			}
			discRows, _ := db.PGQuery(ctx,
				`SELECT COUNT(*) AS val FROM disciplinary_cases WHERE status NOT IN ('closed','resolved')`)
			if len(discRows) > 0 {
				out["open_disciplinary"] = discRows[0]["val"]
			}
		}

		out["role"] = user.Role
		respond(w, out, pickSource(sources))
	}
}

// kpiPortfolio returns the latest portfolio snapshot plus DPD bucket breakdown.
func kpiPortfolio(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		snapRows, err := db.PGQuery(ctx,
			`SELECT snapshot_date, total_loans, total_outstanding_kobo, total_npls_kobo,
			        npl_ratio_bps, par30_kobo, par60_kobo, par90_kobo,
			        new_disbursements_kobo, repayments_kobo
			 FROM portfolio_daily_snapshot ORDER BY snapshot_date DESC LIMIT 1`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}

		snapshot := map[string]any{}
		if len(snapRows) > 0 {
			snapshot = snapRows[0]
		}

		dpdRows, _ := db.PGQuery(ctx,
			`SELECT dpd_bucket, COUNT(*) AS loan_count, COALESCE(SUM(outstanding_kobo),0) AS total_kobo
			 FROM loan_dpd_daily_snapshot
			 WHERE snapshot_date=(SELECT MAX(snapshot_date) FROM loan_dpd_daily_snapshot)
			 GROUP BY dpd_bucket ORDER BY dpd_bucket`)

		respond(w, map[string]any{
			"snapshot":    snapshot,
			"dpd_buckets": dpdRows,
		}, "pg")
	}
}

// kpiPortfolioTrend returns the last 30 rows from portfolio_daily_snapshot.
func kpiPortfolioTrend(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(),
			`SELECT snapshot_date, total_loans, total_outstanding_kobo, total_npls_kobo,
			        npl_ratio_bps, par30_kobo, par60_kobo, par90_kobo,
			        new_disbursements_kobo, repayments_kobo
			 FROM portfolio_daily_snapshot
			 ORDER BY snapshot_date DESC LIMIT 30`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		respond(w, rows, "pg")
	}
}

// kpiCollections returns collections KPIs for the current month.
// collections_head sees the whole team; collections_agent sees only own data.
func kpiCollections(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}

		agentFilter := ""
		args := []any{}
		if user.Role == "collections_agent" {
			agentFilter = " AND agent_user_id=$1"
			args = []any{user.ID}
		}

		rows, err := db.PGQuery(ctx,
			fmt.Sprintf(`SELECT
				COALESCE(SUM(contacts_made),0)              AS contacts_total,
				COALESCE(SUM(promises_obtained),0)          AS promises_total,
				COALESCE(SUM(promises_broken),0)            AS promises_broken,
				COALESCE(SUM(amount_collected_kobo),0)      AS amount_collected_kobo,
				COALESCE(SUM(target_amount_kobo),0)         AS target_amount_kobo,
				COUNT(DISTINCT agent_user_id)               AS agent_count
			 FROM collections_daily_kpi
			 WHERE DATE_TRUNC('month', kpi_date)=DATE_TRUNC('month', CURRENT_DATE)%s`, agentFilter),
			args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}

		result := map[string]any{}
		if len(rows) > 0 {
			result = rows[0]
		}

		// Derived rates
		promises := toFloat(result["promises_total"])
		ptpKept := promises - toFloat(result["promises_broken"])
		if promises > 0 {
			result["ptp_kept_rate"] = round1(ptpKept / promises * 100)
		} else {
			result["ptp_kept_rate"] = 0.0
		}
		target := toFloat(result["target_amount_kobo"])
		collected := toFloat(result["amount_collected_kobo"])
		if target > 0 {
			result["collection_rate_pct"] = round1(collected / target * 100)
		} else {
			result["collection_rate_pct"] = 0.0
		}

		respond(w, result, "pg")
	}
}

// kpiCollectionsTrend returns daily KPIs for the last 30 days.
// collections_head sees all agents; collections_agent sees own data.
func kpiCollectionsTrend(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}

		agentFilter := ""
		args := []any{}
		if user.Role == "collections_agent" {
			agentFilter = " AND kd.agent_user_id=$1"
			args = []any{user.ID}
		}

		rows, err := db.PGQuery(ctx,
			fmt.Sprintf(`SELECT
				kd.kpi_date,
				COALESCE(SUM(kd.contacts_made),0)         AS contacts_total,
				COALESCE(SUM(kd.promises_obtained),0)     AS promises_total,
				COALESCE(SUM(kd.amount_collected_kobo),0) AS amount_collected_kobo,
				COALESCE(SUM(kd.target_amount_kobo),0)    AS target_amount_kobo
			 FROM collections_daily_kpi kd
			 WHERE kd.kpi_date >= CURRENT_DATE - INTERVAL '30 days'%s
			 GROUP BY kd.kpi_date ORDER BY kd.kpi_date`, agentFilter),
			args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		respond(w, rows, "pg")
	}
}

// kpiAlerts returns the most recent 20 alert_log rows, unresolved first.
func kpiAlerts(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(),
			`SELECT al.id, al.triggered_at, al.details, al.is_resolved, al.resolved_at,
			        ar.rule_name, ar.description, ar.severity, ar.condition_type,
			        u.full_name AS resolved_by_name
			 FROM alert_log al
			 JOIN alert_rules ar ON ar.id=al.rule_id
			 LEFT JOIN o3c_users u ON u.id=al.resolved_by
			 ORDER BY al.is_resolved ASC, al.triggered_at DESC
			 LIMIT 20`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		respond(w, rows, "pg")
	}
}

// kpiAlertResolve marks an alert as resolved.
func kpiAlertResolve(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		idStr := chi.URLParam(r, "id")
		id, err := strconv.ParseInt(idStr, 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid alert ID")
			return
		}
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		_, err = db.PGExec(r.Context(),
			`UPDATE alert_log SET is_resolved=TRUE, resolved_at=NOW(), resolved_by=$1
			 WHERE id=$2 AND is_resolved=FALSE`,
			user.ID, id)
		if err != nil {
			respondErr(w, 500, "Update failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"id": id, "resolved": true}) //nolint:errcheck
	}
}

// kpiTargetsList returns kpi_targets for the caller's role.
func kpiTargetsList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		rows, err := db.PGQuery(r.Context(),
			`SELECT id, role, metric_name, period, target_value, updated_at
			 FROM kpi_targets WHERE role=$1 ORDER BY metric_name`,
			user.Role)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		respond(w, rows, "pg")
	}
}

// kpiTargetsUpsert creates or updates a kpi_target entry (md/it_admin only).
func kpiTargetsUpsert(db *core.DB) http.HandlerFunc {
	type body struct {
		Role        string  `json:"role"`
		MetricName  string  `json:"metric_name"`
		Period      string  `json:"period"`
		TargetValue float64 `json:"target_value"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid request body")
			return
		}
		if b.Role == "" || b.MetricName == "" {
			respondErr(w, 400, "role and metric_name are required")
			return
		}
		if b.Period == "" {
			b.Period = "monthly"
		}
		_, err := db.PGExec(r.Context(),
			`INSERT INTO kpi_targets (role, metric_name, period, target_value, updated_at)
			 VALUES ($1,$2,$3,$4,NOW())
			 ON CONFLICT (role, metric_name, period)
			 DO UPDATE SET target_value=EXCLUDED.target_value, updated_at=NOW()`,
			b.Role, b.MetricName, b.Period, b.TargetValue)
		if err != nil {
			respondErr(w, 500, "Upsert failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true}) //nolint:errcheck
	}
}

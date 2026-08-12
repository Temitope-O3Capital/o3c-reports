package handlers

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

func RegisterCollections(r chi.Router, db *core.DB) {
	r.Use(core.RequirePages("collections"))
	r.Get("/kpis", collectionsKPIs(db))
	r.Get("/portfolio-kpis", collectionsPortfolioKPIs(db))
	r.Get("/dpd-trend", collectionsDPDTrend(db))
	r.Get("/by-agent", collectionsByAgent(db))
	r.Get("/by-mode", collectionsByMode(db))
	r.Get("/monthly-trend", collectionsMonthlyTrend(db))
	r.Get("/roll-rate", collectionsRollRate(db))
	r.Get("/log", collectionsLog(db))
	r.Get("/export", collectionsExport(db))
	r.Get("/promise-kpis", collectionsPromiseKPIs(db))
	r.Get("/repayment-kpis", collectionsRepaymentKPIs(db))
	r.Get("/writeoff-kpis", collectionsWriteoffKPIs(db))

	// Portfolio + watchlist (all collections roles can read)
	r.Get("/portfolio", collectionsPortfolioAccounts(db))
	r.Get("/watchlist", collectionsWatchlistList(db))
	r.Post("/watchlist", collectionsWatchlistAdd(db))
	r.Put("/watchlist/{id}/resolve", collectionsWatchlistResolve(db))

	// Generate/refresh collection assignments from the unified delinquency book
	r.Post("/generate-assignments", collectionsGenerateAssignments(db))

	// Batch payment upload
	r.Post("/payments/batch", collectionsBatchPayment(db))

	// Credit activity log
	r.Get("/activity", creditActivityFeed(db))
	r.Get("/activity/cif/{cif}", creditActivityByCIF(db))

	// Account detail snapshot by CIF
	r.Get("/accounts/{cif}", collectionsAccountDetail(db))
}

// collectionsGenerateAssignments seeds/refreshes the collection_assignments work
// book from the unified delinquency source (both card arrears and the Udara loan
// book, aggregated per CIF). Head-gated. It refreshes outstanding/dpd on existing
// active assignments and creates new ones for delinquent CIFs not yet being worked
// or already in recovery. This is the job that makes the module operational.
func collectionsGenerateAssignments(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil || !user.HasPage("collections_assign") {
			respondErr(w, 403, "Only collections heads can generate assignments")
			return
		}
		ctx := r.Context()

		bucketExpr := `CASE WHEN dpd<=30 THEN '1-30' WHEN dpd<=60 THEN '31-60' WHEN dpd<=90 THEN '61-90'
			WHEN dpd<=180 THEN '91-180' WHEN dpd<=360 THEN '181-360' ELSE '360+' END`

		// Refresh outstanding/bucket/name on assignments still being worked.
		if _, err := db.PGExec(ctx, `
			WITH agg AS (
				SELECT cif, MAX(dpd) AS dpd, SUM(outstanding_kobo) AS outstanding_kobo, MAX(customer_name) AS customer_name
				FROM app.collections_delinquent_unified GROUP BY cif
			)
			UPDATE collection_assignments ca SET
				outstanding_kobo = agg.outstanding_kobo,
				dpd_bucket       = `+bucketExpr+`,
				customer_name    = COALESCE(NULLIF(ca.customer_name,''), agg.customer_name),
				updated_at       = NOW()
			FROM agg WHERE ca.account_cif = agg.cif AND ca.status = 'active'`); err != nil {
			respondErr(w, 500, "Refresh failed: "+err.Error())
			return
		}

		// Create assignments for delinquent CIFs not already active or in recovery.
		// assigned_by records the head who ran the generation; agent stays NULL
		// (unassigned) until a head distributes the queue.
		res, err := db.PGExec(ctx, `
			WITH agg AS (
				SELECT cif, MAX(dpd) AS dpd, SUM(outstanding_kobo) AS outstanding_kobo, MAX(customer_name) AS customer_name
				FROM app.collections_delinquent_unified GROUP BY cif
			)
			INSERT INTO collection_assignments
			  (cif_number, account_cif, customer_name, assigned_by, dpd_bucket, outstanding_kobo, status, assignment_date, created_at, updated_at)
			SELECT cif, cif, customer_name, $1, `+bucketExpr+`, outstanding_kobo, 'active', CURRENT_DATE, NOW(), NOW()
			FROM agg
			WHERE cif NOT IN (
				SELECT account_cif FROM collection_assignments
				WHERE status IN ('active','sent_to_recovery') AND account_cif IS NOT NULL
			)`, user.ID)
		if err != nil {
			respondErr(w, 500, "Generation failed: "+err.Error())
			return
		}
		created := int64(0)
		if res != nil {
			created, _ = res.RowsAffected()
		}
		logCreditEvent(ctx, db, r, "collections", "assignment", "generate", "", "assignments_generated",
			fmt.Sprintf("Generated %d new collection assignments from the delinquency book", created), nil, map[string]any{"created": created})
		respond(w, map[string]any{"created": created}, "json")
	}
}

// collectionsAccountDetail returns a full account snapshot for a given CIF.
func collectionsAccountDetail(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cif := chi.URLParam(r, "cif")
		// Base the snapshot on the CIF itself (never 404 for a valid account) and
		// draw balances/name/product from the unified delinquency book, the
		// collection overlay, and the CIF-keyed payments ledger.
		rows, err := db.PGQuery(r.Context(), `
			WITH d AS (
			    SELECT cif,
			           MAX(customer_name)                       AS customer_name,
			           STRING_AGG(DISTINCT product_name, ', ')  AS product_name,
			           STRING_AGG(DISTINCT source, ',')         AS source,
			           MAX(dpd)                                 AS dpd,
			           SUM(outstanding_kobo)                    AS outstanding_kobo
			    FROM app.collections_delinquent_unified WHERE cif = $1 GROUP BY cif
			)
			SELECT
			    NULL::bigint                                        AS loan_id,
			    base.cif                                            AS applicant_cif,
			    COALESCE(d.customer_name, (SELECT full_name FROM app.customers WHERE cif = base.cif), base.cif) AS applicant_name,
			    COALESCE(d.product_name, '—')                       AS product_type,
			    COALESCE((SELECT SUM(loan_amount_kobo) FROM cbs_loans WHERE cbs_customer_id = base.cif),
			             d.outstanding_kobo, ca.outstanding_kobo, 0) AS principal_kobo,
			    COALESCE(d.source, '')                              AS loan_status,
			    NULL::timestamptz                                   AS loan_created_at,
			    ca.id                                               AS assignment_id,
			    ca.agent_user_id,
			    u.full_name                                         AS agent_name,
			    ca.assignment_date,
			    COALESCE(ca.dpd_bucket, CASE
			        WHEN COALESCE(d.dpd,0) <= 0   THEN '0'
			        WHEN d.dpd <= 30  THEN '1-30'
			        WHEN d.dpd <= 60  THEN '31-60'
			        WHEN d.dpd <= 90  THEN '61-90'
			        WHEN d.dpd <= 180 THEN '91-180'
			        WHEN d.dpd <= 360 THEN '181-360'
			        ELSE '360+' END)                                AS dpd_bucket,
			    COALESCE(ca.outstanding_kobo, d.outstanding_kobo, 0) AS outstanding_kobo,
			    ca.current_stage,
			    ca.notes                                            AS assignment_notes,
			    COALESCE(d.dpd, 0)                                  AS dpd_lower,
			    cw.id                                               AS watchlist_id,
			    cw.scenario                                         AS watchlist_scenario,
			    cw.notes                                            AS watchlist_notes,
			    wbu.full_name                                       AS watchlist_flagged_by,
			    cw.created_at                                       AS watchlist_flagged_at,
			    (SELECT COUNT(*) FROM collection_contacts WHERE cif_number = base.cif)                  AS total_contacts,
			    (SELECT COUNT(*) FROM collection_promises WHERE cif_number = base.cif)                  AS ptps_created,
			    (SELECT COUNT(*) FROM collection_promises WHERE cif_number = base.cif AND is_kept = true) AS ptps_kept,
			    (SELECT COALESCE(SUM(amount_kobo), 0) FROM collection_payments WHERE account_cif = base.cif) AS total_paid_kobo,
			    (SELECT MAX(cc.created_at) FROM collection_contacts cc WHERE cc.cif_number = base.cif)  AS last_contact_at,
			    (SELECT cc.outcome FROM collection_contacts cc WHERE cc.cif_number = base.cif ORDER BY cc.created_at DESC LIMIT 1) AS last_contact_outcome
			FROM (SELECT $1::text AS cif) base
			LEFT JOIN d ON d.cif = base.cif
			LEFT JOIN collection_assignments ca ON ca.account_cif = base.cif AND ca.status IN ('active','sent_to_recovery')
			LEFT JOIN o3c_users u ON u.id = ca.agent_user_id
			LEFT JOIN LATERAL (
			    SELECT id, scenario, notes, created_at, flagged_by FROM collections_watchlist
			    WHERE account_cif = base.cif AND status = 'active' LIMIT 1
			) cw ON TRUE
			LEFT JOIN o3c_users wbu ON wbu.id = cw.flagged_by
			LIMIT 1`, cif)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Account not found")
			return
		}
		respond(w, rows[0], "pg")
	}
}

// collectionsPortfolioKPIs returns PAR-based KPIs from collection_assignments.
func collectionsPortfolioKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Unified delinquency book — both the card/customer arrears (app.accounts)
		// and the Udara loan book (cbs_loans), aggregated per CIF. This is an
		// as-of-now snapshot, so date filters don't apply. PAR30/60/90 = cumulative
		// DPD > 30/60/90 (CBN definition).
		rows, err := db.PGQuery(r.Context(), `
			SELECT
				COALESCE(SUM(outstanding_kobo) FILTER (WHERE dpd > 30), 0) AS par30_kobo,
				COALESCE(SUM(outstanding_kobo) FILTER (WHERE dpd > 60), 0) AS par60_kobo,
				COALESCE(SUM(outstanding_kobo) FILTER (WHERE dpd > 90), 0) AS par90_kobo,
				COALESCE(SUM(outstanding_kobo), 0)                        AS total_outstanding_kobo,
				COUNT(*)                                                  AS total_accounts,
				COUNT(*) FILTER (WHERE dpd > 0)                           AS delinquent_accounts,
				0::numeric                                                AS current_rate_pct
			FROM (
				SELECT cif, MAX(dpd) AS dpd, SUM(outstanding_kobo) AS outstanding_kobo
				FROM app.collections_delinquent_unified
				GROUP BY cif
			) ca`)
		if err != nil || len(rows) == 0 {
			respond(w, map[string]any{
				"par30_kobo": int64(0), "par60_kobo": int64(0), "par90_kobo": int64(0),
				"total_outstanding_kobo": int64(0), "total_accounts": int64(0),
				"delinquent_accounts": int64(0), "current_rate_pct": 0.0,
			}, "pg")
			return
		}
		respond(w, rows[0], "pg")
	}
}

// collectionsDPDTrend returns 6-month PAR trend from collection_assignments.
func collectionsDPDTrend(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		from := r.URL.Query().Get("from")
		to := r.URL.Query().Get("to")
		rows, err := db.PGQuery(r.Context(), `
			WITH months AS (
				SELECT generate_series(
					DATE_TRUNC('month', NOW() - INTERVAL '5 months'),
					DATE_TRUNC('month', NOW()),
					'1 month'::interval
				) AS m
			)
			SELECT
				TO_CHAR(m.m, 'Mon YY') AS month,
				m.m                    AS month_sort,
				COALESCE(SUM(CASE WHEN ca.dpd_bucket IN ('31-60','61-90','91-180','181-360','360+')
				              THEN ca.outstanding_kobo END), 0)            AS par30_kobo,
				COALESCE(SUM(CASE WHEN ca.dpd_bucket IN ('61-90','91-180','181-360','360+')
				              THEN ca.outstanding_kobo END), 0)            AS par60_kobo,
				COALESCE(SUM(CASE WHEN ca.dpd_bucket IN ('91-180','181-360','360+')
				              THEN ca.outstanding_kobo END), 0)            AS par90_kobo
			FROM months m
			LEFT JOIN collection_assignments ca
				ON DATE_TRUNC('month', ca.updated_at) = m.m
				AND ($1 = '' OR ca.updated_at::date >= $1::date)
				AND ($2 = '' OR ca.updated_at::date <= $2::date)
			GROUP BY m.m
			ORDER BY m.m`, from, to)
		if err != nil {
			respond(w, []any{}, "pg")
			return
		}
		respond(w, rows, "pg")
	}
}

// collectionsRollRate returns DPD bucket distribution and MoM transition counts.
// A full roll-rate matrix requires historical snapshots; this endpoint provides
// the current DPD distribution plus last-month's distribution for comparison.
func collectionsRollRate(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		from := r.URL.Query().Get("from")
		to := r.URL.Query().Get("to")

		_ = from
		_ = to
		// Current DPD distribution from the unified delinquency book (per CIF), so it
		// reflects the live arrears snapshot regardless of assignment generation.
		current, err := db.PGQuery(ctx, `
			SELECT
				dpd_bucket,
				COUNT(*)                             AS account_count,
				COALESCE(SUM(outstanding_kobo), 0)  AS outstanding_kobo
			FROM (
				SELECT cif,
				       SUM(outstanding_kobo) AS outstanding_kobo,
				       CASE
				         WHEN MAX(dpd)<=0 THEN '0' WHEN MAX(dpd)<=30 THEN '1-30' WHEN MAX(dpd)<=60 THEN '31-60'
				         WHEN MAX(dpd)<=90 THEN '61-90' WHEN MAX(dpd)<=180 THEN '91-180' WHEN MAX(dpd)<=360 THEN '181-360' ELSE '360+'
				       END AS dpd_bucket
				FROM app.collections_delinquent_unified GROUP BY cif
			) d
			GROUP BY dpd_bucket
			ORDER BY
				CASE dpd_bucket
					WHEN '0'       THEN 0
					WHEN '1-30'    THEN 1
					WHEN '31-60'   THEN 2
					WHEN '61-90'   THEN 3
					WHEN '91-180'  THEN 4
					WHEN '181-360' THEN 5
					ELSE 6
				END`)
		if err != nil {
			respondErr(w, 500, "Roll rate query failed")
			return
		}

		// Movement this month: accounts that changed dpd_bucket in the current calendar month.
		// Proxied by comparing updated_at vs created_at bucket changes.
		cures, _ := db.PGQuery(ctx, `
			SELECT COUNT(*) AS cured_count
			FROM collection_assignments
			WHERE dpd_bucket = '0'
			  AND updated_at >= DATE_TRUNC('month', CURRENT_DATE)
			  AND updated_at > created_at`)

		respond(w, map[string]any{
			"current_distribution": current,
			"cured_this_month": func() any {
				if len(cures) > 0 {
					return cures[0]["cured_count"]
				}
				return 0
			}(),
		}, "pg")
	}
}

func collectionsKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dateFrom, err := validDate(r, "date_from")
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		dateTo, err := validDate(r, "date_to")
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		agent := qstr(r, "agent")

		var f Filter
		f.Date("Repayment_Date", `"Date"`, dateFrom, dateTo)
		f.Eq(" AND Rn_Create_User=?", ` AND "Agent"=?`, agent)

		ctx := r.Context()
		kpis := map[string]any{}
		var sources []string

		type spec struct{ key, pg string }
		for _, s := range []spec{
			{"total_collected",
				fmt.Sprintf(`SELECT COALESCE(SUM("Amount"),0) AS val FROM "Collections Log" WHERE 1=1%s`, f.PG())},
			{"collection_count",
				fmt.Sprintf(`SELECT COUNT(*) AS val FROM "Collections Log" WHERE 1=1%s`, f.PG())},
			{"paid_collections",
				fmt.Sprintf(`SELECT COALESCE(SUM("Amount"),0) AS val FROM "Collections Log" WHERE "Mode Of Payment" IS NOT NULL%s`, f.PG())},
			{"pending_collections",
				fmt.Sprintf(`SELECT COALESCE(SUM("Amount"),0) AS val FROM "Collections Log" WHERE "Mode Of Payment" IS NULL%s`, f.PG())},
		} {
			val, src, err := db.DualScalar(ctx, "val", s.pg, f.Args()...)
			if err != nil {
				respondErr(w, 500, "Query failed: "+s.key)
				return
			}
			kpis[s.key] = val
			sources = append(sources, src)
		}

		// MTD always uses current month; include agent filter but not date filter
		var af Filter
		af.Eq(" AND Rn_Create_User=?", ` AND "Agent"=?`, agent)
		mtd, src, _ := db.DualScalar(ctx, "val",
			fmt.Sprintf(`SELECT COALESCE(SUM("Amount"),0) AS val FROM "Collections Log" WHERE DATE_TRUNC('month',"Date")=DATE_TRUNC('month',CURRENT_DATE)%s`, af.PG()),
			af.Args()...)
		kpis["collections_mtd"] = mtd
		sources = append(sources, src)

		respond(w, kpis, pickSource(sources))
	}
}

func collectionsByAgent(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dateFrom, err := validDate(r, "date_from")
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		dateTo, err := validDate(r, "date_to")
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		var f Filter
		f.Date("Repayment_Date", `"Date"`, dateFrom, dateTo)
		data, src, err := db.DualQuery(r.Context(),
			fmt.Sprintf(`SELECT "Agent", COALESCE(SUM("Amount"),0) AS total, COUNT(*) AS count
			  FROM "Collections Log" WHERE "Agent" IS NOT NULL AND "Agent"!=''%s
			  GROUP BY "Agent" ORDER BY total DESC LIMIT 15`, f.PG()),
			f.Args()...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		respond(w, data, src)
	}
}

func collectionsByMode(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, src, err := db.DualQuery(r.Context(),
			`SELECT COALESCE("Mode Of Payment",'Pending') AS payment_status,
			        COALESCE(SUM("Amount"),0) AS total, COUNT(*) AS count
			 FROM "Collections Log" GROUP BY "Mode Of Payment" ORDER BY total DESC`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		respond(w, data, src)
	}
}

func collectionsMonthlyTrend(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, src, err := db.DualQuery(r.Context(),
			`SELECT TO_CHAR(DATE_TRUNC('month',"Date"),'Mon YYYY') AS month,
			        DATE_TRUNC('month',"Date") AS month_sort,
			        COALESCE(SUM("Amount"),0) AS total
			 FROM "Collections Log" WHERE "Date" IS NOT NULL
			 GROUP BY DATE_TRUNC('month',"Date") ORDER BY month_sort`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		respond(w, data, src)
	}
}

func collectionsLog(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dateFrom, err := validDate(r, "date_from")
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		dateTo, err := validDate(r, "date_to")
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		agent := qstr(r, "agent")
		limit := qint(r, "limit", 200, 1, 1000)

		var f Filter
		f.Date("Repayment_Date", `"Date"`, dateFrom, dateTo)
		f.Eq(" AND r.Rn_Create_User=?", ` AND cl."Agent"=?`, agent)

		data, src, err := db.DualQuery(r.Context(),
			fmt.Sprintf(`SELECT cl."Date", cl."CIF",
			        a.first_name AS "First Name", a.last_name AS "Last Name",
			        cl."Agent", cl."Amount", cl."Mode Of Payment", cl."Payment Receipt"
			 FROM "Collections Log" cl
			 LEFT JOIN app.customers a ON cl."CIF"=a.cif
			 WHERE 1=1%s ORDER BY cl."Date" DESC LIMIT %d`, f.PG(), limit),
			f.Args()...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		respond(w, data, src)
	}
}

func collectionsExport(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dateFrom, err := validDate(r, "date_from")
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		dateTo, err := validDate(r, "date_to")
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		agent := qstr(r, "agent")

		var f Filter
		f.Date("Repayment_Date", `"Date"`, dateFrom, dateTo)
		f.Eq(" AND r.Rn_Create_User=?", ` AND cl."Agent"=?`, agent)

		data, _, err := db.DualQuery(r.Context(),
			fmt.Sprintf(`SELECT cl."Date", cl."CIF",
			        a.first_name AS "First Name", a.last_name AS "Last Name",
			        cl."Agent", cl."Amount", cl."Payment Receipt"
			 FROM "Collections Log" cl
			 LEFT JOIN app.customers a ON cl."CIF"=a.cif
			 WHERE 1=1%s ORDER BY cl."Date" DESC`, f.PG()),
			f.Args()...)
		if err != nil {
			respondErr(w, 500, "Export failed")
			return
		}
		name := fmt.Sprintf("collections_%s_%s.csv",
			coalesce(dateFrom, "all"), coalesce(dateTo, "all"))
		streamCSV(w, name, data)
	}
}

func collectionsPromiseKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		from := r.URL.Query().Get("from")
		to := r.URL.Query().Get("to")
		rows, err := db.PGQuery(r.Context(), `
			SELECT
				COUNT(*)                                                      AS total,
				COUNT(*) FILTER (WHERE is_kept = TRUE)                        AS kept,
				COUNT(*) FILTER (WHERE is_kept = FALSE)                       AS broken,
				COALESCE(SUM(promised_amount_kobo), 0)                        AS amount_promised_kobo
			FROM collection_promises
			WHERE ($1 = '' OR created_at::date >= $1::date)
			  AND ($2 = '' OR created_at::date <= $2::date)`, from, to)
		if err != nil || len(rows) == 0 {
			respond(w, map[string]any{
				"total": int64(0), "kept": int64(0), "broken": int64(0),
				"amount_promised_kobo": int64(0),
			}, "pg")
			return
		}
		respond(w, rows[0], "pg")
	}
}

func collectionsRepaymentKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		from := r.URL.Query().Get("from")
		to := r.URL.Query().Get("to")
		rows, err := db.PGQuery(r.Context(), `
			SELECT
				COUNT(*) FILTER (WHERE status = 'Active')                         AS active,
				COUNT(*) FILTER (WHERE status = 'Active'
				                   AND (next_payment_date IS NULL
				                        OR next_payment_date >= CURRENT_DATE))    AS on_track,
				COUNT(*) FILTER (WHERE status = 'Active'
				                   AND next_payment_date < CURRENT_DATE)          AS behind,
				COALESCE(SUM(
					CASE WHEN status = 'Active'
					THEN (SELECT COALESCE(SUM(ri.amount_kobo),0)
					      FROM repayment_instalments ri
					      WHERE ri.plan_id = rp.id
					        AND ri.due_date >= DATE_TRUNC('month', CURRENT_DATE)
					        AND ri.due_date <  DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month'
					        AND ri.status != 'Paid')
					ELSE 0 END
				), 0)                                                              AS monthly_due_kobo
			FROM repayment_plans rp
			WHERE ($1 = '' OR rp.created_at::date >= $1::date)
			  AND ($2 = '' OR rp.created_at::date <= $2::date)`, from, to)
		if err != nil || len(rows) == 0 {
			respond(w, map[string]any{
				"active": int64(0), "on_track": int64(0),
				"behind": int64(0), "monthly_due_kobo": int64(0),
			}, "pg")
			return
		}
		respond(w, rows[0], "pg")
	}
}

func collectionsWriteoffKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		from := r.URL.Query().Get("from")
		to := r.URL.Query().Get("to")
		rows, err := db.PGQuery(r.Context(), `
			SELECT
				COUNT(*)                                                          AS total,
				COALESCE(SUM(wo.amount_kobo), 0)                                 AS amount_kobo,
				CASE WHEN SUM(wo.amount_kobo) = 0 OR SUM(wo.amount_kobo) IS NULL THEN 0
				     ELSE ROUND(
				       100.0 * SUM(rc.recovered_kobo) / NULLIF(SUM(wo.amount_kobo), 0), 1
				     )
				END                                                               AS recovery_rate_pct,
				COUNT(*) FILTER (WHERE wo.status = 'pending')                    AS pending
			FROM recovery_write_off_approvals wo
			JOIN recovery_cases rc ON wo.case_id = rc.id
			WHERE ($1 = '' OR wo.created_at::date >= $1::date)
			  AND ($2 = '' OR wo.created_at::date <= $2::date)`, from, to)
		if err != nil || len(rows) == 0 {
			respond(w, map[string]any{
				"total": int64(0), "amount_kobo": int64(0),
				"recovery_rate_pct": 0.0, "pending": int64(0),
			}, "pg")
			return
		}
		respond(w, rows[0], "pg")
	}
}

// ── Portfolio: all active loan accounts, DPD-sorted ─────────────────────────

func collectionsPortfolioAccounts(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		search := strings.TrimSpace(qstr(r, "q"))
		territory := qstr(r, "territory")   // "collections" | "recovery" | ""
		onWatchlist := qstr(r, "watchlist") // "true" | ""

		// Unified delinquency book (card arrears + Udara loans) aggregated per CIF,
		// with the workspace collection overlay (assignment, agent, stage, watchlist)
		// LEFT-JOINed by CIF.
		query := `
			SELECT
			    d.cif                                      AS loan_id,
			    d.cif                                      AS applicant_cif,
			    d.customer_name,
			    d.source                                   AS loan_status,
			    CASE
			        WHEN d.dpd <= 0   THEN '0'
			        WHEN d.dpd <= 30  THEN '1-30'
			        WHEN d.dpd <= 60  THEN '31-60'
			        WHEN d.dpd <= 90  THEN '61-90'
			        WHEN d.dpd <= 180 THEN '91-180'
			        WHEN d.dpd <= 360 THEN '181-360'
			        ELSE '360+' END                        AS dpd_bucket,
			    d.dpd                                      AS dpd_lower,
			    d.outstanding_kobo,
			    d.product_name,
			    ca.id                                      AS assignment_id,
			    ca.current_stage,
			    u.full_name                                AS agent_name,
			    cw.id                                      AS watchlist_id,
			    cw.scenario                                AS watchlist_scenario
			FROM (
			    SELECT cif,
			           MAX(customer_name)                       AS customer_name,
			           STRING_AGG(DISTINCT product_name, ', ')  AS product_name,
			           STRING_AGG(DISTINCT source, ',')         AS source,
			           MAX(dpd)                                 AS dpd,
			           SUM(outstanding_kobo)                    AS outstanding_kobo
			    FROM app.collections_delinquent_unified
			    GROUP BY cif
			) d
			LEFT JOIN collection_assignments ca ON ca.account_cif = d.cif AND ca.status IN ('active','sent_to_recovery')
			LEFT JOIN o3c_users u ON u.id = ca.agent_user_id
			LEFT JOIN LATERAL (
			    SELECT id, scenario FROM collections_watchlist
			    WHERE account_cif = d.cif AND status = 'active' LIMIT 1
			) cw ON TRUE
			WHERE 1=1`
		args := []any{}
		n := 1

		if search != "" {
			if clause, sargs, nn := buildCustomerSearch(search,
				[]string{"d.cif", "d.customer_name"}, "", n); clause != "" {
				query += " AND " + clause
				args = append(args, sargs...)
				n = nn
			}
		}
		if territory == "collections" {
			query += ` AND d.dpd <= 90`
		} else if territory == "recovery" {
			query += ` AND d.dpd > 90`
		}
		if onWatchlist == "true" {
			query += " AND cw.id IS NOT NULL"
		}
		_ = n

		query += " ORDER BY d.dpd DESC, d.outstanding_kobo DESC LIMIT 500"

		rows, err := db.PGQuery(ctx, query, args...)
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

// ── Watchlist CRUD ────────────────────────────────────────────────────────────

func collectionsWatchlistList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		status := qstr(r, "status")
		if status == "" {
			status = "active"
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT
			    cw.id, cw.account_cif, cw.scenario, cw.notes,
			    cw.dpd_at_flag, cw.outstanding_kobo, cw.status,
			    cw.resolved_at, cw.resolution_notes, cw.created_at,
			    u.full_name AS flagged_by_name
			FROM collections_watchlist cw
			LEFT JOIN o3c_users u ON u.id = cw.flagged_by
			WHERE ($1 = 'all' OR cw.status = $1)
			ORDER BY cw.created_at DESC
			LIMIT 200`, status)
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

func collectionsWatchlistAdd(db *core.DB) http.HandlerFunc {
	type body struct {
		AccountCIF      string `json:"account_cif"`
		Scenario        string `json:"scenario"`
		Notes           string `json:"notes"`
		DPDAtFlag       int    `json:"dpd_at_flag"`
		OutstandingKobo int64  `json:"outstanding_kobo"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.AccountCIF == "" || b.Scenario == "" {
			respondErr(w, 422, "account_cif and scenario are required")
			return
		}
		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO collections_watchlist
			    (account_cif, flagged_by, scenario, notes, dpd_at_flag, outstanding_kobo, status, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, 'active', NOW())
			RETURNING id, account_cif, scenario, notes, dpd_at_flag, outstanding_kobo, status, created_at`,
			b.AccountCIF, user.ID, b.Scenario, b.Notes, b.DPDAtFlag, b.OutstandingKobo)
		if err != nil {
			respondErr(w, 500, "Insert failed")
			return
		}
		logCreditEvent(r.Context(), db, r, "collections", "watchlist", fmt.Sprint(rows[0]["id"]), b.AccountCIF, "watchlist_flagged",
			fmt.Sprintf("Account added to watchlist — scenario: %s", b.Scenario), nil, map[string]any{"scenario": b.Scenario, "notes": b.Notes})
		respond(w, rows[0], "pg")
	}
}

func collectionsWatchlistResolve(db *core.DB) http.HandlerFunc {
	type body struct {
		Status          string `json:"status"` // resolved | escalated_to_recovery
		ResolutionNotes string `json:"resolution_notes"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Status != "resolved" && b.Status != "escalated_to_recovery" {
			respondErr(w, 422, "status must be resolved or escalated_to_recovery")
			return
		}
		user := core.UserFromCtx(r.Context())
		ctx := r.Context()

		// Load current flag first so escalation can carry outstanding/dpd into the
		// recovery case, and so we don't open a duplicate case on re-escalation.
		cur, cErr := db.PGQuery(ctx, `SELECT status, COALESCE(outstanding_kobo,0) AS outstanding_kobo, COALESCE(dpd_at_flag,0) AS dpd_at_flag FROM collections_watchlist WHERE id=$1`, id)
		if cErr != nil || len(cur) == 0 {
			respondErr(w, 404, "Watchlist entry not found")
			return
		}
		alreadyEscalated := str(cur[0]["status"]) == "escalated_to_recovery"
		wlOutstanding := toInt64(cur[0]["outstanding_kobo"])
		wlDPD := toInt64(cur[0]["dpd_at_flag"])

		rows, err := db.PGQuery(ctx, `
			UPDATE collections_watchlist
			SET status = $1, resolved_at = NOW(), resolved_by = $2, resolution_notes = $3
			WHERE id = $4
			RETURNING id, account_cif, scenario, status, resolved_at, resolution_notes`,
			b.Status, user.ID, b.ResolutionNotes, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Watchlist entry not found")
			return
		}
		cif := str(rows[0]["account_cif"])

		// Escalation must actually reach recovery — open a real recovery case
		// (mirrors send-to-recovery) instead of only flipping the flag's status.
		var caseRef string
		if b.Status == "escalated_to_recovery" && !alreadyEscalated && cif != "" {
			if ref, _, oErr := openRecoveryCase(ctx, db, cif, fmt.Sprint(wlDPD), wlOutstanding, nil); oErr == nil {
				caseRef = ref
			}
		}

		evtDesc := fmt.Sprintf("Watchlist flag resolved — status: %s", b.Status)
		if caseRef != "" {
			evtDesc = fmt.Sprintf("Watchlist flag escalated to recovery — case %s created", caseRef)
		}
		logCreditEvent(ctx, db, r, "collections", "watchlist", fmt.Sprint(id), cif, "watchlist_resolved",
			evtDesc, nil, map[string]any{"status": b.Status, "notes": b.ResolutionNotes, "case_ref": caseRef})
		out := rows[0]
		if caseRef != "" {
			out["recovery_case_ref"] = caseRef
		}
		respond(w, out, "pg")
	}
}

// ── Credit activity log endpoints ─────────────────────────────────────────────

func creditActivityFeed(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		page := qint(r, "page", 1, 1, 500)
		size := qint(r, "size", 50, 1, 200)
		from := r.URL.Query().Get("from")
		to := r.URL.Query().Get("to")
		mod := r.URL.Query().Get("module")
		act := r.URL.Query().Get("action")
		etype := r.URL.Query().Get("entity_type")
		cif := r.URL.Query().Get("cif")
		actor := r.URL.Query().Get("actor_id")

		where := " WHERE 1=1"
		args := []any{}

		addFilter := func(col, val string) {
			if val != "" {
				args = append(args, val)
				where += fmt.Sprintf(" AND %s = $%d", col, len(args))
			}
		}
		if from != "" {
			args = append(args, from)
			where += fmt.Sprintf(" AND ts >= $%d::date", len(args))
		}
		if to != "" {
			args = append(args, to)
			where += fmt.Sprintf(" AND ts <  $%d::date + INTERVAL '1 day'", len(args))
		}
		addFilter("module", mod)
		addFilter("action", act)
		addFilter("entity_type", etype)
		addFilter("account_cif", cif)
		addFilter("actor_id::text", actor)

		// Snapshot filter args before adding LIMIT/OFFSET for the COUNT query.
		countArgs := make([]any, len(args))
		copy(countArgs, args)

		offset := (page - 1) * size
		args = append(args, size, offset)
		limitClause := fmt.Sprintf(" ORDER BY ts DESC LIMIT $%d OFFSET $%d", len(args)-1, len(args))

		rows, err := db.PGQuery(ctx,
			`SELECT cal.id, cal.ts, cal.module, cal.actor_id, cal.actor_name, cal.actor_role,
			        cal.entity_type, cal.entity_id, cal.account_cif, cal.action, cal.description,
			        cal.previous_state, cal.new_state, cal.ip_address
			 FROM credit_activity_log cal`+where+limitClause, args...)
		if err != nil {
			respondErr(w, 500, err.Error())
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}

		var total int
		_ = db.PG.QueryRowContext(ctx, "SELECT COUNT(*) FROM credit_activity_log"+where, countArgs...).Scan(&total)

		respond(w, map[string]any{"data": rows, "total": total, "page": page, "size": size}, "credit_activity_feed")
	}
}

func creditActivityByCIF(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		cif := chi.URLParam(r, "cif")
		if cif == "" {
			respondErr(w, 400, "cif required")
			return
		}

		rows, err := db.PGQuery(ctx, `
			SELECT id, ts, module, actor_id, actor_name, actor_role,
			       entity_type, entity_id, action, description,
			       previous_state, new_state
			FROM credit_activity_log
			WHERE account_cif = $1
			ORDER BY ts DESC
			LIMIT 200`, cif)
		if err != nil {
			respondErr(w, 500, err.Error())
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}

		// respond() already wraps the payload as {"data": …}; return the rows
		// directly so the client sees r.data as the array (TimelineTab reads
		// r.data). Wrapping again here double-nests and crashes the timeline
		// with "x.map is not a function".
		respond(w, rows, "credit_activity_cif")
	}
}

// ── Batch payment upload ──────────────────────────────────────────────────────

func collectionsBatchPayment(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseMultipartForm(4 << 20); err != nil {
			respondErr(w, 400, "Invalid multipart form")
			return
		}
		file, _, err := r.FormFile("file")
		if err != nil {
			respondErr(w, 400, "Missing file field")
			return
		}
		defer file.Close()

		reader := csv.NewReader(file)
		reader.TrimLeadingSpace = true
		records, err := reader.ReadAll()
		if err != nil {
			respondErr(w, 400, "Invalid CSV")
			return
		}
		if len(records) < 2 {
			respondErr(w, 422, "CSV has no data rows")
			return
		}

		user := core.UserFromCtx(r.Context())
		ctx := r.Context()

		type result struct {
			Row     int    `json:"row"`
			CIF     string `json:"cif"`
			Success bool   `json:"success"`
			Error   string `json:"error,omitempty"`
		}
		var results []result
		processed, failed := 0, 0

		for i, rec := range records[1:] {
			rowNum := i + 2
			if len(rec) < 5 {
				results = append(results, result{Row: rowNum, Error: "not enough columns (need: cif,amount_naira,payment_date,channel,reference)"})
				failed++
				continue
			}
			cif := strings.TrimSpace(rec[0])
			amtNaira, parseErr := strconv.ParseFloat(strings.TrimSpace(rec[1]), 64)
			payDate := strings.TrimSpace(rec[2])
			channel := strings.TrimSpace(rec[3])
			reference := strings.TrimSpace(rec[4])

			if parseErr != nil || amtNaira <= 0 {
				results = append(results, result{Row: rowNum, CIF: cif, Error: "invalid amount"})
				failed++
				continue
			}
			if payDate == "" || channel == "" {
				results = append(results, result{Row: rowNum, CIF: cif, Error: "payment_date and channel required"})
				failed++
				continue
			}
			amtKobo := int64(math.Round(amtNaira * 100))

			// Validate the CIF is a known customer so a typo can't post a GL entry.
			if custRows, cErr := db.PGQuery(ctx, `SELECT 1 FROM app.customers WHERE cif = $1 LIMIT 1`, cif); cErr != nil || len(custRows) == 0 {
				results = append(results, result{Row: rowNum, CIF: cif, Error: "unknown CIF"})
				failed++
				continue
			}
			if _, dErr := time.Parse("2006-01-02", payDate); dErr != nil {
				results = append(results, result{Row: rowNum, CIF: cif, Error: "invalid payment_date (want YYYY-MM-DD)"})
				failed++
				continue
			}

			// Link the active assignment when there is one (nullable in the ledger).
			var assignmentID any
			if aRows, _ := db.PGQuery(ctx, `SELECT id FROM collection_assignments WHERE account_cif = $1 AND status = 'active' ORDER BY id DESC LIMIT 1`, cif); len(aRows) > 0 {
				assignmentID = toInt64(aRows[0]["id"])
			}

			tx, txErr := db.PG.BeginTx(ctx, nil)
			if txErr != nil {
				results = append(results, result{Row: rowNum, CIF: cif, Error: "tx start failed"})
				failed++
				continue
			}

			// Write to the CIF-keyed collections ledger (works for the whole
			// delinquency book, not just booked loans) so batch payments post and
			// show up in the account snapshot.
			var payID int64
			insErr := tx.QueryRowContext(ctx, `
				INSERT INTO collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by)
				VALUES ($1, $2, $3, $4, $5, $6, $7)
				RETURNING id`,
				assignmentID, cif, amtKobo, payDate, channel, reference, user.ID,
			).Scan(&payID)
			if insErr != nil {
				tx.Rollback() //nolint:errcheck
				results = append(results, result{Row: rowNum, CIF: cif, Error: "insert failed"})
				failed++
				continue
			}

			glRef := fmt.Sprintf("COL-BATCH-%d", payID)
			if jErr := postJournalTx(ctx, tx, glEntry{
				Date:          time.Now(),
				Description:   fmt.Sprintf("Batch collection payment — CIF %s", cif),
				Reference:     glRef,
				DebitAccount:  "1001",
				CreditAccount: "1100",
				AmountKobo:    amtKobo,
				SourceType:    "collections_payment",
				SourceID:      payID,
				PostedBy:      user.ID,
			}); jErr != nil {
				tx.Rollback() //nolint:errcheck
				results = append(results, result{Row: rowNum, CIF: cif, Error: "GL post failed"})
				failed++
				continue
			}
			tx.ExecContext(ctx, `UPDATE collection_payments SET gl_reference = $1 WHERE id = $2`, glRef, payID) //nolint:errcheck

			// Legacy parity: mirror to loan_repayments when the CIF maps to a booked
			// loan (best-effort — never fail the payment over this).
			if lr, lErr := db.PGQuery(ctx, `SELECT id FROM loan_applications WHERE applicant_cif = $1 AND status IN ('active','booked') ORDER BY created_at DESC LIMIT 1`, cif); lErr == nil && len(lr) > 0 {
				tx.ExecContext(ctx, `INSERT INTO loan_repayments (application_id, amount_kobo, payment_date, payment_method, reference, received_by, created_at)
					VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
					toInt64(lr[0]["id"]), amtKobo, payDate, channel, reference, user.ID) //nolint:errcheck
			}

			if cErr := tx.Commit(); cErr != nil {
				results = append(results, result{Row: rowNum, CIF: cif, Error: "commit failed"})
				failed++
				continue
			}

			results = append(results, result{Row: rowNum, CIF: cif, Success: true})
			processed++
		}

		respond(w, map[string]any{
			"processed": processed,
			"failed":    failed,
			"total":     processed + failed,
			"results":   results,
		}, "pg")
	}
}

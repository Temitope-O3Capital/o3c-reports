package handlers

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

/*
Reporting rollups — the nightly jobs that keep the reporting layer fed.

Two of them, both addressing tables that reports read and nothing ever wrote:

  - collections_daily_kpi is the source for Collections Performance and Agent
    Performance. It has never had a row. Neither have its own sources
    (collection_contacts, collection_promises, collection_payments), so this is
    not a backfill of missing history — it is the rollup those reports need,
    running from the day the collections team starts logging work.

  - card_txn_codes is the taxonomy every income figure depends on. New CCS
    transaction codes must surface as 'unclassified' on the registry rather than
    dropping silently out of revenue, so the sync runs nightly too.

Both report into Admin → Sync & Workers, and both are exposed as manual triggers
so an operator can re-roll a window after correcting activity rather than waiting
for the next batch.
*/

// rollupWindowDays is how far back the nightly pass re-rolls.
//
// 35 days rather than 1: agents log contacts and payments late, and a rollup that
// only ever touches yesterday leaves those corrections permanently invisible. A
// month-plus window means the current and previous month are always right.
const rollupWindowDays = 35

// batchRebuildReportingRollups runs the reporting rollups. Called as step 15 of
// the nightly batch.
func batchRebuildReportingRollups(ctx context.Context, db *core.DB) error {
	var firstErr error

	// Collections KPI.
	WorkerBeat(ctx, db, "reporting_rollups", "running", "collections_daily_kpi", "")
	from := time.Now().UTC().AddDate(0, 0, -rollupWindowDays).Format("2006-01-02")
	to := time.Now().UTC().Format("2006-01-02")

	rows, err := db.PGQuery(ctx,
		`SELECT app.rebuild_collections_daily_kpi($1::date, $2::date) AS n`, from, to)
	if err != nil {
		firstErr = fmt.Errorf("rebuild_collections_daily_kpi: %w", err)
		slog.Error("rollup: collections_daily_kpi", "err", err)
	} else {
		n := int64(0)
		if len(rows) > 0 {
			n = toInt64(rows[0]["n"])
		}
		slog.Info("rollup: collections_daily_kpi", "rows", n, "from", from, "to", to)
	}

	// Transaction code registry.
	codeRows, err := db.PGQuery(ctx, `SELECT app.sync_card_txn_codes() AS n`)
	if err != nil {
		if firstErr == nil {
			firstErr = fmt.Errorf("sync_card_txn_codes: %w", err)
		}
		slog.Error("rollup: sync_card_txn_codes", "err", err)
	} else {
		n := int64(0)
		if len(codeRows) > 0 {
			n = toInt64(codeRows[0]["n"])
		}
		if n > 0 {
			// Worth a warning, not just an info line: an unclassified code is
			// revenue that is not being counted in any category.
			slog.Warn("rollup: new transaction codes registered as unclassified — classify them",
				"count", n)
		}
	}

	errStr := ""
	phase := "idle"
	if firstErr != nil {
		errStr = firstErr.Error()
		phase = "error"
	}
	WorkerBeat(ctx, db, "reporting_rollups", phase, "", errStr)
	return firstErr
}

// RegisterReportingRollups mounts the manual triggers and the health view.
func RegisterReportingRollups(r chi.Router, db *core.DB) {
	read := core.RequirePages("reports", "kpi_dashboard")
	write := core.RequirePages("reports", "settings")

	r.With(read).Get("/rollups/status", rollupStatus(db))
	r.With(write).Post("/rollups/collections-kpi", rollupCollectionsKPI(db))
	r.With(write).Post("/rollups/txn-codes", rollupTxnCodes(db))
}

// rollupStatus reports what the reporting layer is actually standing on, so a
// dashboard reading zero can be told apart from a dashboard whose feed is dry.
func rollupStatus(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		out := map[string]any{}

		scalar := func(key, sql string) {
			if rows, _ := db.PGQuery(ctx, sql); len(rows) > 0 {
				for k, v := range rows[0] {
					if k == "v" {
						out[key] = v
					} else {
						out[key+"_"+k] = v
					}
				}
			}
		}

		scalar("collections_kpi_rows", `SELECT COUNT(*) AS v FROM app.collections_daily_kpi`)
		scalar("collections_kpi_latest", `SELECT MAX(kpi_date) AS v FROM app.collections_daily_kpi`)
		scalar("collection_contacts", `SELECT COUNT(*) AS v FROM app.collection_contacts`)
		scalar("collection_promises", `SELECT COUNT(*) AS v FROM app.collection_promises`)
		scalar("collection_payments", `SELECT COUNT(*) AS v FROM app.collection_payments`)
		scalar("txn_codes_total", `SELECT COUNT(*) AS v FROM app.card_txn_codes`)
		scalar("txn_codes_unclassified", `SELECT COUNT(*) AS v FROM app.card_txn_codes WHERE category='unclassified'`)
		scalar("kpi_targets_set", `SELECT COUNT(*) AS v FROM app.kpi_targets`)
		scalar("transactions_latest", `SELECT MAX(txn_date) AS v FROM app.transactions`)

		// The months where the card feed did not deliver. Any card figure for one
		// of these is understated, and a chart must not plot it as a real zero.
		gaps, _ := db.PGQuery(ctx, `
			SELECT TO_CHAR(m, 'YYYY-MM') AS month, COALESCE(t.n, 0) AS txn_count
			FROM generate_series(
			       DATE_TRUNC('month', CURRENT_DATE - INTERVAL '11 months'),
			       DATE_TRUNC('month', CURRENT_DATE), INTERVAL '1 month') AS g(m)
			LEFT JOIN (SELECT DATE_TRUNC('month', txn_date) AS m, COUNT(*) AS n
			           FROM app.transactions GROUP BY 1) t ON t.m = g.m
			WHERE COALESCE(t.n, 0) < 500
			ORDER BY 1`)
		if gaps == nil {
			gaps = []core.Row{}
		}
		out["card_feed_gap_months"] = gaps

		// The unclassified codes themselves, so they can be fixed rather than
		// merely counted.
		unclassified, _ := db.PGQuery(ctx, `
			SELECT c.code, c.description, COUNT(t.txn_id) AS txn_count,
			       ROUND(COALESCE(SUM(t.amount), 0)::numeric, 2) AS amount_ngn
			FROM app.card_txn_codes c
			LEFT JOIN app.transactions t ON t.txn_code = c.code
			WHERE c.category = 'unclassified'
			GROUP BY 1, 2 ORDER BY 4 DESC`)
		if unclassified == nil {
			unclassified = []core.Row{}
		}
		out["unclassified_codes"] = unclassified

		respond(w, out, "pg")
	}
}

func rollupCollectionsKPI(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		from, err := validDate(r, "date_from")
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		to, err := validDate(r, "date_to")
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		if from == "" {
			from = time.Now().UTC().AddDate(0, 0, -rollupWindowDays).Format("2006-01-02")
		}
		if to == "" {
			to = time.Now().UTC().Format("2006-01-02")
		}

		rows, err := db.PGQuery(r.Context(),
			`SELECT app.rebuild_collections_daily_kpi($1::date, $2::date) AS n`, from, to)
		if err != nil {
			respondErrLog(w, 500, "Rollup failed", err)
			return
		}
		n := int64(0)
		if len(rows) > 0 {
			n = toInt64(rows[0]["n"])
		}
		respond(w, map[string]any{
			"rows_built": n, "date_from": from, "date_to": to,
			// Said plainly, because "0 rows" on a rollup looks like a failure and
			// here it is the honest state of the world.
			"note": "0 rows means no collections activity has been logged in this window.",
		}, "pg")
	}
}

func rollupTxnCodes(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `SELECT app.sync_card_txn_codes() AS n`)
		if err != nil {
			respondErrLog(w, 500, "Code sync failed", err)
			return
		}
		n := int64(0)
		if len(rows) > 0 {
			n = toInt64(rows[0]["n"])
		}
		respond(w, map[string]any{"newly_registered": n}, "pg")
	}
}

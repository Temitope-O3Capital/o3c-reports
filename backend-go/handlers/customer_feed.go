package handlers

import (
	"context"
	"database/sql"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
	"github.com/o3c/reports/custfeed"
)

// custFeedInterval reads CUSTOMER_FEED_INTERVAL (a Go duration, e.g. "15m").
// The drops land every ~15 minutes, so that is the default. A value <= 0 disables the
// schedule and leaves the manual trigger.
func custFeedInterval() time.Duration {
	if v := os.Getenv("CUSTOMER_FEED_INTERVAL"); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
		slog.Warn("invalid CUSTOMER_FEED_INTERVAL, using default 15m", "value", v)
	}
	return 15 * time.Minute
}

// StartCustomerFeedWorker ingests new cust_file drops on a schedule.
//
// No-op when DATA_FEED_DIR is unset or missing, so a developer machine without the
// feed mounted stays quiet instead of logging a failure every quarter hour.
func StartCustomerFeedWorker(db *core.DB) {
	if !custfeed.Configured() {
		slog.Info("customer feed worker disabled (DATA_FEED_DIR unset or not a directory)")
		return
	}
	interval := custFeedInterval()
	if interval <= 0 {
		slog.Info("customer feed schedule disabled (CUSTOMER_FEED_INTERVAL <= 0); manual trigger only")
		return
	}

	runOnce := func() {
		// The first run after a cold start has thousands of backlog files to walk, so
		// the budget is generous; steady-state runs touch a handful.
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		defer cancel()
		if _, err := custfeed.Run(ctx, db, "scheduled", sql.NullInt64{}); err != nil {
			slog.Error("scheduled customer feed ingest failed", "err", err)
		}
	}

	time.Sleep(45 * time.Second) // let the server settle and migrations finish
	runOnce()

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for range ticker.C {
		runOnce()
	}
}

// RegisterCustomerFeed mounts the feed's trigger and status endpoints under
// /api/customer-feed. Triggering an ingest is an admin action; reading status is
// available to sales, who need to know how fresh the customer book is.
func RegisterCustomerFeed(r chi.Router, db *core.DB) {
	r.With(core.RequirePages("admin")).Post("/ingest", custFeedTrigger(db))
	r.With(core.RequirePages("admin", "sales", "crm_contacts")).Get("/status", custFeedStatus(db))
	r.With(core.RequirePages("admin", "sales", "crm_contacts")).Get("/runs", custFeedRuns(db))
}

func custFeedTrigger(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !custfeed.Configured() {
			respondErr(w, http.StatusServiceUnavailable,
				"Customer feed not configured — DATA_FEED_DIR is unset or not a directory")
			return
		}
		var triggeredBy sql.NullInt64
		if u := core.UserFromCtx(r.Context()); u != nil && u.ID != 0 {
			triggeredBy = sql.NullInt64{Int64: u.ID, Valid: true}
		}
		// Detached from the request: a backlog ingest outlives any sensible HTTP
		// timeout, and the caller polls /status.
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		defer cancel()

		res, err := custfeed.Run(ctx, db, "manual", triggeredBy)
		if err != nil {
			respondErr(w, http.StatusBadGateway, "Ingest failed: "+err.Error())
			return
		}
		respond(w, map[string]any{
			"run_id":       res.RunID,
			"files_seen":   res.FilesSeen,
			"files_read":   res.FilesRead,
			"files_empty":  res.FilesEmpty,
			"files_failed": res.FilesFail,
			"rows":         res.Rows,
			"rejected":     res.Rejected,
			"inserted":     res.Inserted,
			"updated":      res.Updated,
		}, "pg")
	}
}

// custFeedStatus reports the last run alongside how current the customer book is.
// `configured` is returned explicitly so the UI can distinguish "the feed has never
// run" from "this deployment has no feed attached".
func custFeedStatus(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		out := map[string]any{"configured": custfeed.Configured()}

		if rows, err := db.PGQuery(ctx, `
			SELECT id, kind, status, started_at, finished_at, error,
			       files_seen, files_parsed, files_empty, files_failed,
			       rows_read, rows_rejected, customers_inserted, customers_updated
			FROM customer_feed_runs ORDER BY started_at DESC LIMIT 1`); err == nil && len(rows) > 0 {
			out["last_run"] = rows[0]
		} else {
			out["last_run"] = nil
		}

		if rows, err := db.PGQuery(ctx, `
			SELECT COUNT(*)                                            AS customers,
			       COUNT(*) FILTER (WHERE source = 'feed')             AS from_feed,
			       MAX(last_seen)                                      AS newest_feed_touch,
			       MAX(GREATEST(account_created, first_seen_at))       AS newest_customer,
			       (SELECT COUNT(*) FROM customer_feed_files)          AS files_processed
			FROM app.customers`); err == nil && len(rows) > 0 {
			out["book"] = rows[0]
		}

		respond(w, out, "pg")
	}
}

func custFeedRuns(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT r.id, r.kind, r.status, r.started_at, r.finished_at, r.error,
			       r.files_seen, r.files_parsed, r.files_empty, r.files_failed,
			       r.rows_read, r.rows_rejected,
			       r.customers_inserted, r.customers_updated,
			       u.full_name AS triggered_by_name
			FROM customer_feed_runs r
			LEFT JOIN o3c_users u ON u.id = r.triggered_by
			ORDER BY r.started_at DESC
			LIMIT $1`, qint(r, "limit", 50, 1, 200))
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		respond(w, rows, "pg")
	}
}

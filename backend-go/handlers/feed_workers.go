package handlers

import (
	"context"
	"database/sql"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/acctfeed"
	"github.com/o3c/workspace/cardfeed"
	"github.com/o3c/workspace/core"
	"github.com/o3c/workspace/feedcore"
	"github.com/o3c/workspace/txnfeed"
)

// feedRunFn is a stream's ingest entrypoint (acctfeed.Run, cardfeed.Run, …).
type feedRunFn func(ctx context.Context, db *core.DB, kind string, by sql.NullInt64) (feedcore.Result, error)

// startFeedWorker runs a stream's ingest on the shared CUSTOMER_FEED_INTERVAL schedule.
// It mirrors StartCustomerFeedWorker: a no-op when the folder is not mounted, a generous
// budget for the cold-start backlog, then a steady tick. The stagger delay keeps the
// streams from all scanning their (large) folders at the same instant on boot.
func startFeedWorker(db *core.DB, name string, delay time.Duration, configured func() bool, run feedRunFn) {
	if !configured() {
		slog.Info("feed worker disabled (folder missing)", "stream", name)
		return
	}
	interval := custFeedInterval()
	if interval <= 0 {
		slog.Info("feed schedule disabled (CUSTOMER_FEED_INTERVAL <= 0); manual trigger only", "stream", name)
		return
	}
	runOnce := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		defer cancel()
		if _, err := run(ctx, db, "scheduled", sql.NullInt64{}); err != nil {
			slog.Error("scheduled feed ingest failed", "stream", name, "err", err)
		}
	}
	time.Sleep(delay)
	runOnce()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for range ticker.C {
		runOnce()
	}
}

// StartAccountFeedWorker ingests acct_file drops into app.accounts on a schedule.
func StartAccountFeedWorker(db *core.DB) {
	startFeedWorker(db, "accounts", 60*time.Second, acctfeed.Configured, acctfeed.Run)
}

// StartTxnFeedWorker ingests txn_file drops into app.transactions on a schedule.
func StartTxnFeedWorker(db *core.DB) {
	startFeedWorker(db, "transactions", 80*time.Second, txnfeed.Configured, txnfeed.Run)
}

// StartCardfamFeedWorker tracks cardfam_file drops on a schedule.
func StartCardfamFeedWorker(db *core.DB) {
	startFeedWorker(db, "cardfam", 120*time.Second, cardfeed.Configured, cardfeed.Run)
}

// streamRunner resolves a stream name to its Run + Configured funcs.
func streamRunner(stream string) (feedRunFn, func() bool, bool) {
	switch stream {
	case "accounts":
		return acctfeed.Run, acctfeed.Configured, true
	case "transactions":
		return txnfeed.Run, txnfeed.Configured, true
	case "cardfam":
		return cardfeed.Run, cardfeed.Configured, true
	}
	return nil, nil, false
}

// RegisterFeedWorkers mounts trigger/status/runs for the generic feed streams under
// /api/feed. Triggering is an admin action.
func RegisterFeedWorkers(r chi.Router, db *core.DB) {
	r.With(core.RequirePages("admin")).Post("/{stream}/ingest", feedTrigger(db))
	r.With(core.RequirePages("admin")).Get("/{stream}/status", feedStatus(db))
	r.With(core.RequirePages("admin")).Get("/runs", feedRuns(db))
}

func feedTrigger(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		stream := chi.URLParam(r, "stream")
		run, configured, ok := streamRunner(stream)
		if !ok {
			respondErr(w, http.StatusNotFound, "unknown feed stream")
			return
		}
		if !configured() {
			respondErr(w, http.StatusServiceUnavailable, "feed not configured — DATA_FEED_DIR unset or folder missing")
			return
		}
		var by sql.NullInt64
		if u := core.UserFromCtx(r.Context()); u != nil && u.ID != 0 {
			by = sql.NullInt64{Int64: u.ID, Valid: true}
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		defer cancel()
		res, err := run(ctx, db, "manual", by)
		if err != nil {
			respondErr(w, http.StatusBadGateway, "Ingest failed: "+err.Error())
			return
		}
		respond(w, map[string]any{
			"run_id": res.RunID, "files_seen": res.FilesSeen, "files_read": res.FilesRead,
			"files_empty": res.FilesEmpty, "files_failed": res.FilesFail, "rows": res.Rows,
			"rejected": res.Rejected, "inserted": res.Inserted, "updated": res.Updated,
		}, "pg")
	}
}

func feedStatus(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		stream := chi.URLParam(r, "stream")
		_, configured, ok := streamRunner(stream)
		if !ok {
			respondErr(w, http.StatusNotFound, "unknown feed stream")
			return
		}
		out := map[string]any{"stream": stream, "configured": configured()}
		if rows, err := db.PGQuery(r.Context(),
			`SELECT * FROM feed_runs WHERE stream=$1 ORDER BY id DESC LIMIT 1`, stream); err == nil && len(rows) > 0 {
			out["last_run"] = rows[0]
		} else {
			out["last_run"] = nil
		}
		if rows, err := db.PGQuery(r.Context(), `
			SELECT COUNT(*) AS files,
			       COUNT(*) FILTER (WHERE status='ok')     AS ok,
			       COUNT(*) FILTER (WHERE status='empty')  AS empty,
			       COUNT(*) FILTER (WHERE status='failed') AS failed
			FROM feed_files WHERE stream=$1`, stream); err == nil && len(rows) > 0 {
			out["files"] = rows[0]
		}
		respond(w, out, "pg")
	}
}

func feedRuns(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT r.*, u.full_name AS triggered_by_name
			FROM feed_runs r LEFT JOIN o3c_users u ON u.id = r.triggered_by
			ORDER BY r.id DESC LIMIT $1`, qint(r, "limit", 50, 1, 200))
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		respond(w, rows, "pg")
	}
}

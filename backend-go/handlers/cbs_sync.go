package handlers

import (
	"context"
	"database/sql"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/cbssync"
	"github.com/o3c/reports/core"
	"github.com/o3c/reports/udara"
)

// cbsSyncInterval reads CBS_SYNC_INTERVAL (a Go duration, e.g. "30m", "1h").
// Defaults to 1h; a value <= 0 disables scheduled syncing (manual trigger only).
func cbsSyncInterval() time.Duration {
	if v := os.Getenv("CBS_SYNC_INTERVAL"); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
		slog.Warn("invalid CBS_SYNC_INTERVAL, using default 1h", "value", v)
	}
	return time.Hour
}

// StartCBSSyncWorker periodically spools the Udara360 book into the snapshot tables.
// No-op if the CBS client is not configured. Runs one sync shortly after boot, then
// on the configured interval.
func StartCBSSyncWorker(c *udara.Client, db *core.DB) {
	if c == nil || !c.IsConfigured() {
		slog.Info("CBS sync worker disabled (Udara360 not configured)")
		return
	}
	interval := cbsSyncInterval()
	if interval <= 0 {
		slog.Info("CBS scheduled sync disabled (CBS_SYNC_INTERVAL <= 0); manual trigger only")
		return
	}

	runOnce := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		if _, err := cbssync.SyncAll(ctx, c, db, "scheduled", sql.NullInt64{}); err != nil {
			slog.Error("scheduled CBS sync failed", "err", err)
		}
	}

	// Close out any run this process's predecessor was in the middle of.
	//
	// A run is marked 'running' at the start and updated at the end, so a process
	// killed in between leaves the row 'running' forever. On this server that is
	// every deploy restart, and 58 such rows had accumulated since 31 July —
	// enough that "is a sync in flight?" was permanently answered yes. Nothing
	// that started before this process booted can still be running.
	reconcileStrandedCBSRuns(db)

	// Let the server settle before the first pull.
	time.Sleep(30 * time.Second)
	runOnce()

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for range ticker.C {
		// Also on every tick, not only at boot. A run stranded by a crash at
		// midday would otherwise sit 'running' until the next restart — which is
		// how 58 of them accumulated. The query is a cheap indexed no-op when
		// there is nothing to close.
		reconcileStrandedCBSRuns(db)
		runOnce()
	}
}

// RegisterCBSSync mounts sync trigger/status endpoints under /api/cbs.
// The manual trigger is admin-gated; status is available to any authenticated
// core-banking user.
func RegisterCBSSync(r chi.Router, c *udara.Client, db *core.DB) {
	r.With(core.RequirePages("admin")).Post("/sync", cbsSyncTrigger(c, db))
	r.Get("/sync/status", cbsSyncStatus(db))
	r.With(core.RequirePages("admin")).Get("/probe", cbsProbe(c))
	r.With(core.RequirePages("admin")).Get("/probe-all", cbsProbeAll(c))
	r.With(core.RequirePages("admin")).Get("/probe-detail", cbsProbeDetail(c))
}

// cbsProbeDetail hunts for a per-account detail endpoint (the real repayment schedule).
func cbsProbeDetail(c *udara.Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !c.IsConfigured() {
			cbsWriteJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "CBS not configured"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 4*time.Minute)
		defer cancel()
		cbsWriteJSON(w, http.StatusOK, cbssync.ProbeDetail(ctx, c))
	}
}

// cbsProbeAll enumerates the whole Udara API surface — every reachable endpoint,
// its record count, and field shape — so we can see all data Udara exposes.
func cbsProbeAll(c *udara.Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !c.IsConfigured() {
			cbsWriteJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "CBS not configured"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 4*time.Minute)
		defer cancel()
		cbsWriteJSON(w, http.StatusOK, cbssync.ProbeAll(ctx, c))
	}
}

// cbsProbe hits the Udara Search endpoints directly and reports the raw
// recordCount vs the number of items each page returns, plus whether a second
// page yields more — proof of whether the book size (e.g. 28 loans / 236 FDs) is
// the true total or a capped/paginated view.
func cbsProbe(c *udara.Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !c.IsConfigured() {
			cbsWriteJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "CBS not configured"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
		defer cancel()
		cbsWriteJSON(w, http.StatusOK, cbssync.Probe(ctx, c))
	}
}

func cbsSyncTrigger(c *udara.Client, db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !c.IsConfigured() {
			cbsWriteJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "CBS not configured"})
			return
		}
		var triggeredBy sql.NullInt64
		if u := core.UserFromCtx(r.Context()); u != nil && u.ID != 0 {
			triggeredBy = sql.NullInt64{Int64: u.ID, Valid: true}
		}
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
		defer cancel()
		res, err := cbssync.SyncAll(ctx, c, db, "manual", triggeredBy)
		if err != nil {
			cbsWriteJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
			return
		}
		cbsWriteJSON(w, http.StatusOK, map[string]any{
			"ok":        true,
			"products":  res.Products,
			"loans":     res.Loans,
			"fds":       res.FDs,
			"matched":   res.Matched,
			"unmatched": res.Unmatched,
		})
	}
}

func cbsSyncStatus(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		var (
			id                                       sql.NullInt64
			kind, status, errMsg                     sql.NullString
			startedAt, finishedAt                    sql.NullTime
			productsN, loansN, fdsN, matchedN, unmat sql.NullInt64
		)
		err := db.PG.QueryRowContext(ctx, `
			SELECT id, kind, started_at, finished_at, status, products_n, loans_n, fds_n,
			       matched_n, unmatched_n, error
			FROM cbs_sync_runs ORDER BY started_at DESC LIMIT 1`).
			Scan(&id, &kind, &startedAt, &finishedAt, &status, &productsN, &loansN, &fdsN,
				&matchedN, &unmat, &errMsg)

		last := map[string]any{}
		if err == nil {
			last = map[string]any{
				"id":          id.Int64,
				"kind":        kind.String,
				"status":      status.String,
				"started_at":  nullTimeStr(startedAt),
				"finished_at": nullTimeStr(finishedAt),
				"products":    productsN.Int64,
				"loans":       loansN.Int64,
				"fds":         fdsN.Int64,
				"matched":     matchedN.Int64,
				"unmatched":   unmat.Int64,
				"error":       errMsg.String,
			}
		}

		// Current snapshot row counts (independent of last run record).
		counts := map[string]any{
			"products":       scalarCount(ctx, db, "cbs_products"),
			"loans":          scalarCount(ctx, db, "cbs_loans"),
			"fixed_deposits": scalarCount(ctx, db, "cbs_fixed_deposits"),
			"linked":         scalarCount(ctx, db, "cbs_links"),
		}
		cbsWriteJSON(w, http.StatusOK, map[string]any{"last_run": last, "snapshot": counts})
	}
}

func scalarCount(ctx context.Context, db *core.DB, table string) int64 {
	var n sql.NullInt64
	// table is a fixed literal from this file, not user input.
	if err := db.PG.QueryRowContext(ctx, "SELECT count(*) FROM "+table).Scan(&n); err != nil {
		return 0
	}
	return n.Int64
}

func nullTimeStr(t sql.NullTime) any {
	if !t.Valid {
		return nil
	}
	return t.Time.Format(time.RFC3339)
}

func cbsWriteJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// reconcileStrandedCBSRuns closes runs left open when the process was killed.
//
// 'interrupted' rather than 'error': the sync did not fail, it was stopped, and
// conflating the two would make the failure rate read far worse than it is.
// Scoped to runs older than the 5-minute sync timeout so a genuinely in-flight
// run — there is at most one, the loop is sequential — is never touched.
func reconcileStrandedCBSRuns(db *core.DB) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	rows, err := db.PGQuery(ctx, `
		UPDATE cbs_sync_runs
		   SET status = 'interrupted',
		       finished_at = COALESCE(finished_at, started_at),
		       error = COALESCE(NULLIF(error,''),
		                        'Process restarted while this run was in flight; never completed')
		 WHERE status = 'running' AND started_at < NOW() - interval '30 minutes'
		 RETURNING id`)
	if err != nil {
		slog.Warn("could not reconcile stranded CBS runs", "err", err)
		return
	}
	if len(rows) > 0 {
		slog.Info("closed CBS sync runs stranded by a restart", "count", len(rows))
	}
}

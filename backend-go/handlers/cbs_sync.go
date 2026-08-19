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

	// Let the server settle before the first pull.
	time.Sleep(30 * time.Second)
	runOnce()

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for range ticker.C {
		runOnce()
	}
}

// RegisterCBSSync mounts sync trigger/status endpoints under /api/cbs.
// The manual trigger is admin-gated; status is available to any authenticated
// core-banking user.
func RegisterCBSSync(r chi.Router, c *udara.Client, db *core.DB) {
	r.With(core.RequirePages("admin")).Post("/sync", cbsSyncTrigger(c, db))
	r.Get("/sync/status", cbsSyncStatus(db))
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

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
	"github.com/o3c/reports/paystacksync"
)

// paystackSyncInterval reads PAYSTACK_SYNC_INTERVAL (a Go duration, e.g. "15m").
// Defaults to 30m; a value <= 0 disables scheduled syncing (manual trigger only).
func paystackSyncInterval() time.Duration {
	if v := os.Getenv("PAYSTACK_SYNC_INTERVAL"); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
		slog.Warn("invalid PAYSTACK_SYNC_INTERVAL, using default 30m", "value", v)
	}
	return 30 * time.Minute
}

// StartPaystackSyncWorker mirrors the live Paystack account into the local
// snapshot tables. No-op when PAYSTACK_SECRET_KEY is unset. Runs once shortly
// after boot, then on the configured interval.
//
// The first run has no watermark and walks the full history (~31k records today,
// roughly 315 paced requests), so it is given a generous timeout; later runs only
// re-pull the trailing overlap window.
func StartPaystackSyncWorker(db *core.DB) {
	if resolvePaystackKey(context.Background(), db) == "" {
		slog.Info("Paystack sync worker disabled (PAYSTACK_SECRET_KEY not configured)")
		return
	}
	interval := paystackSyncInterval()
	if interval <= 0 {
		slog.Info("Paystack scheduled sync disabled (PAYSTACK_SYNC_INTERVAL <= 0); manual trigger only")
		return
	}

	runOnce := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		defer cancel()
		secret := resolvePaystackKey(ctx, db)
		if secret == "" {
			return
		}
		if _, err := paystacksync.SyncAll(ctx, db, secret, "scheduled", sql.NullInt64{}); err != nil {
			slog.Error("scheduled Paystack sync failed", "err", err)
		}
	}

	// Let the server settle (and migrations finish) before the first pull.
	time.Sleep(45 * time.Second)
	runOnce()

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for range ticker.C {
		runOnce()
	}
}

// RegisterPaystackSync mounts sync trigger/status endpoints under /api/paystack.
// The manual trigger is settlement/admin gated; status is readable by anyone with
// the settlement or reconciliation page.
func RegisterPaystackSync(r chi.Router, db *core.DB) {
	r.With(core.RequirePages("settlement", "admin")).Post("/sync", paystackSyncTrigger(db))
	r.With(core.RequirePages("settlement", "reconciliation")).Get("/sync/status", paystackSyncStatus(db))
}

func paystackSyncTrigger(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		secret := resolvePaystackKey(r.Context(), db)
		if secret == "" {
			cbsWriteJSON(w, http.StatusServiceUnavailable,
				map[string]any{"error": "Paystack not configured — set PAYSTACK_SECRET_KEY"})
			return
		}
		var triggeredBy sql.NullInt64
		if u := core.UserFromCtx(r.Context()); u != nil && u.ID != 0 {
			triggeredBy = sql.NullInt64{Int64: u.ID, Valid: true}
		}
		kind := "manual"
		if qstr(r, "mode") == "backfill" {
			kind = "backfill" // ignore the watermark and walk the full history
		}

		// Detach from the request: a backfill outlives the HTTP request, and the
		// caller should not hold a connection open for it.
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		go func() {
			defer cancel()
			if _, err := paystacksync.SyncAll(ctx, db, secret, kind, triggeredBy); err != nil {
				slog.Error("manual Paystack sync failed", "kind", kind, "err", err)
			}
		}()

		cbsWriteJSON(w, http.StatusAccepted, map[string]any{
			"ok":     true,
			"kind":   kind,
			"status": "started",
			"note":   "Poll GET /api/paystack/sync/status for progress.",
		})
	}
}

func paystackSyncStatus(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		var (
			id                             sql.NullInt64
			kind, status, errMsg           sql.NullString
			startedAt, finishedAt, waterM  sql.NullTime
			txnN, trfN, setN, dspN         sql.NullInt64
		)
		err := db.PG.QueryRowContext(ctx, `
			SELECT id, kind, started_at, finished_at, status, watermark,
			       transactions_n, transfers_n, settlements_n, disputes_n, error
			FROM paystack_sync_runs ORDER BY started_at DESC LIMIT 1`).
			Scan(&id, &kind, &startedAt, &finishedAt, &status, &waterM,
				&txnN, &trfN, &setN, &dspN, &errMsg)

		last := map[string]any{}
		if err == nil {
			last = map[string]any{
				"id":           id.Int64,
				"kind":         kind.String,
				"status":       status.String,
				"started_at":   nullTimeStr(startedAt),
				"finished_at":  nullTimeStr(finishedAt),
				"watermark":    nullTimeStr(waterM),
				"transactions": txnN.Int64,
				"transfers":    trfN.Int64,
				"settlements":  setN.Int64,
				"disputes":     dspN.Int64,
				"error":        errMsg.String,
			}
		}

		cbsWriteJSON(w, http.StatusOK, map[string]any{
			"configured": resolvePaystackKey(ctx, db) != "",
			"last_run":   last,
			"snapshot": map[string]any{
				"transactions": scalarCount(ctx, db, "paystack_transactions"),
				"transfers":    scalarCount(ctx, db, "paystack_transfers"),
				"settlements":  scalarCount(ctx, db, "paystack_settlements"),
				"disputes":     scalarCount(ctx, db, "paystack_disputes"),
			},
		})
	}
}

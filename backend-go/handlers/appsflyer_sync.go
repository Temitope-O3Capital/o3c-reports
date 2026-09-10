package handlers

import (
	"context"
	"database/sql"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/appsflyer"
	"github.com/o3c/workspace/appsflyersync"
	"github.com/o3c/workspace/core"
)

// AppsFlyer acquisition sync — mirrors the "Blink by O3" attribution feed into the
// local snapshot tables (appsflyer_daily / appsflyer_events) on a schedule.
//
// Outbound-only: we poll AppsFlyer's Aggregate Pull API; nothing is exposed inbound
// and nothing is written back. No-op until APPSFLYER_API_TOKEN is configured (env or
// the encrypted api_credentials store), so this is safe to run before a token lands.

// resolveAppsFlyerToken returns the account-level API V2 bearer token: env var first,
// then the DB-stored credential. This is the Security-Center token, NOT the SDK dev key.
func resolveAppsFlyerToken(ctx context.Context, db *core.DB) string {
	return resolveCredKey(ctx, db, "APPSFLYER_API_TOKEN")
}

// appsflyerApps returns the platform targets to pull, defaulting to the confirmed
// "Blink by O3" ids and overridable via APPSFLYER_IOS_APP_ID / APPSFLYER_ANDROID_APP_ID
// (set either to "-" to disable that platform).
func appsflyerApps() []appsflyer.App {
	ios := coalesce(os.Getenv("APPSFLYER_IOS_APP_ID"), appsflyer.DefaultIOSAppID)
	android := coalesce(os.Getenv("APPSFLYER_ANDROID_APP_ID"), appsflyer.DefaultAndroidAppID)
	var apps []appsflyer.App
	if ios != "" && ios != "-" {
		apps = append(apps, appsflyer.App{AppID: ios, Platform: "ios"})
	}
	if android != "" && android != "-" {
		apps = append(apps, appsflyer.App{AppID: android, Platform: "android"})
	}
	return apps
}

// appsflyerSyncInterval reads APPSFLYER_SYNC_INTERVAL (a Go duration, e.g. "1h").
// Defaults to 1h; a value <= 0 disables scheduled syncing (manual trigger only).
// The report is a daily aggregate, so hourly is more than fresh enough and stays
// comfortably within the Aggregate Pull API's rate limits (2 apps = 2 calls/hour).
func appsflyerSyncInterval() time.Duration {
	if v := os.Getenv("APPSFLYER_SYNC_INTERVAL"); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
		slog.Warn("invalid APPSFLYER_SYNC_INTERVAL, using default 1h", "value", v)
	}
	return time.Hour
}

// appsflyerWindowDays is the trailing look-back a scheduled run re-pulls (default 30).
func appsflyerWindowDays() int {
	if v := os.Getenv("APPSFLYER_WINDOW_DAYS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return 30
}

// appsflyerBackfillDays is how far a backfill walks back (default 180).
func appsflyerBackfillDays() int {
	if v := os.Getenv("APPSFLYER_BACKFILL_DAYS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return 180
}

// StartAppsFlyerSyncWorker runs the acquisition sync on a timer. No-op when the
// token is unset. Runs once shortly after boot (once migrations have settled), then
// on the configured interval.
func StartAppsFlyerSyncWorker(db *core.DB) {
	if resolveAppsFlyerToken(context.Background(), db) == "" {
		slog.Info("AppsFlyer sync worker disabled (APPSFLYER_API_TOKEN not configured)")
		return
	}
	interval := appsflyerSyncInterval()
	if interval <= 0 {
		slog.Info("AppsFlyer scheduled sync disabled (APPSFLYER_SYNC_INTERVAL <= 0); manual trigger only")
		return
	}

	runOnce := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		token := resolveAppsFlyerToken(ctx, db)
		if token == "" {
			return
		}
		client := appsflyer.New(token)
		if _, err := appsflyersync.SyncAll(ctx, db, client, appsflyerApps(), "scheduled", appsflyerWindowDays(), sql.NullInt64{}); err != nil {
			slog.Error("scheduled AppsFlyer sync failed", "err", err)
		}
	}

	// Let the server settle (and migrations finish) before the first pull.
	time.Sleep(60 * time.Second)
	runOnce()

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for range ticker.C {
		runOnce()
	}
}

// RegisterAppsFlyerSync mounts the sync trigger/status endpoints under /api/appsflyer.
// The manual trigger is admin gated; status is readable by the marketing/reporting audience.
func RegisterAppsFlyerSync(r chi.Router, db *core.DB) {
	r.With(core.RequirePages("admin")).Post("/sync", appsflyerSyncTrigger(db))
	r.With(core.RequirePages("campaigns", "reports", "executive", "admin")).Get("/sync/status", appsflyerSyncStatus(db))
}

func appsflyerSyncTrigger(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := resolveAppsFlyerToken(r.Context(), db)
		if token == "" {
			cbsWriteJSON(w, http.StatusServiceUnavailable,
				map[string]any{"error": "AppsFlyer not configured — set APPSFLYER_API_TOKEN"})
			return
		}
		var triggeredBy sql.NullInt64
		if u := core.UserFromCtx(r.Context()); u != nil && u.ID != 0 {
			triggeredBy = sql.NullInt64{Int64: u.ID, Valid: true}
		}
		kind := "manual"
		window := appsflyerWindowDays()
		if qstr(r, "mode") == "backfill" {
			kind = "backfill"
			window = appsflyerBackfillDays()
		}
		if d := qstr(r, "days"); d != "" {
			if n, err := strconv.Atoi(d); err == nil && n > 0 {
				window = n
			}
		}

		// Detach from the request: a backfill outlives the HTTP request.
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
		go func() {
			defer cancel()
			client := appsflyer.New(token)
			if _, err := appsflyersync.SyncAll(ctx, db, client, appsflyerApps(), kind, window, triggeredBy); err != nil {
				slog.Error("manual AppsFlyer sync failed", "kind", kind, "err", err)
			}
		}()

		cbsWriteJSON(w, http.StatusAccepted, map[string]any{
			"ok":     true,
			"kind":   kind,
			"days":   window,
			"status": "started",
			"note":   "Poll GET /api/appsflyer/sync/status for progress.",
		})
	}
}

func appsflyerSyncStatus(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		var (
			id                    sql.NullInt64
			kind, status, errMsg  sql.NullString
			startedAt, finishedAt sql.NullTime
			fromD, toD            sql.NullString
			appsN, dailyN, eventN sql.NullInt64
		)
		err := db.PG.QueryRowContext(ctx, `
			SELECT id, kind, started_at, finished_at, status,
			       from_date::text, to_date::text, apps_n, daily_rows, event_rows, error
			FROM appsflyer_sync_runs ORDER BY id DESC LIMIT 1`).
			Scan(&id, &kind, &startedAt, &finishedAt, &status,
				&fromD, &toD, &appsN, &dailyN, &eventN, &errMsg)

		last := map[string]any{}
		if err == nil {
			last = map[string]any{
				"id":          id.Int64,
				"kind":        kind.String,
				"status":      status.String,
				"started_at":  nullTimeStr(startedAt),
				"finished_at": nullTimeStr(finishedAt),
				"from_date":   fromD.String,
				"to_date":     toD.String,
				"apps":        appsN.Int64,
				"daily_rows":  dailyN.Int64,
				"event_rows":  eventN.Int64,
				"error":       errMsg.String,
			}
		}

		apps := appsflyerApps()
		appIDs := make([]string, 0, len(apps))
		for _, a := range apps {
			appIDs = append(appIDs, a.Platform+":"+a.AppID)
		}

		cbsWriteJSON(w, http.StatusOK, map[string]any{
			"configured": resolveAppsFlyerToken(ctx, db) != "",
			"apps":       appIDs,
			"last_run":   last,
			"snapshot": map[string]any{
				"daily_rows": scalarCount(ctx, db, "appsflyer_daily"),
				"event_rows": scalarCount(ctx, db, "appsflyer_events"),
			},
		})
	}
}

// Package appsflyersync mirrors the AppsFlyer acquisition feed for the "Blink by O3"
// apps into local snapshot tables (appsflyer_daily, appsflyer_events), recording an
// audit row per run in appsflyer_sync_runs.
//
// AppsFlyer is the system of record; these tables are written ONLY by this worker
// and refreshed by upsert (never truncated), so a day's row survives after it ages
// out of the re-pull window. The feed is strictly read-only — nothing is written
// back to AppsFlyer.
//
// Cadence: unlike a paginated ledger, this is a date-range pull. Each scheduled run
// re-pulls a trailing window (default 30 days) so late-attributed installs, session
// activity and reattribution restate recent days rather than freezing at first sight.
// A backfill walks further back (default 180 days) in <=90-day chunks (the API's
// per-call ceiling). Money columns are USD, as AppsFlyer reports them — no FX here.
package appsflyersync

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/o3c/workspace/appsflyer"
	"github.com/o3c/workspace/core"
)

const (
	// maxWindowDays is the API's per-call ceiling for the aggregate report.
	maxWindowDays = 90
	// appDelay paces the per-app calls so a run stays well under the rate limit.
	appDelay = 2 * time.Second
)

// Result summarises one sync run.
type Result struct {
	Apps      int
	DailyRows int
	EventRows int
	From, To  string
}

// SyncAll pulls every app over the requested window and upserts the snapshot,
// bracketed by an appsflyer_sync_runs audit row. kind is "scheduled", "manual" or
// "backfill"; windowDays is the trailing look-back (clamped to the API ceiling and
// chunked when it exceeds it).
func SyncAll(ctx context.Context, db *core.DB, client *appsflyer.Client, apps []appsflyer.App,
	kind string, windowDays int, triggeredBy sql.NullInt64) (Result, error) {

	var res Result
	if client == nil || !client.IsConfigured() {
		return res, fmt.Errorf("appsflyer sync: APPSFLYER_API_TOKEN not configured")
	}
	if len(apps) == 0 {
		return res, fmt.Errorf("appsflyer sync: no apps configured")
	}
	if windowDays <= 0 {
		windowDays = 30
	}

	// AppsFlyer reports in the app timezone (UTC for Blink). Use UTC "today" so the
	// window lines up with the reported dates and we don't miss the current day.
	to := time.Now().UTC()
	from := to.AddDate(0, 0, -windowDays)
	res.From, res.To = from.Format("2006-01-02"), to.Format("2006-01-02")

	var runID int64
	if err := db.PG.QueryRowContext(ctx,
		`INSERT INTO appsflyer_sync_runs (kind, status, from_date, to_date, triggered_by)
		 VALUES ($1,'running',$2,$3,$4) RETURNING id`,
		kind, res.From, res.To, triggeredBy).Scan(&runID); err != nil {
		return res, fmt.Errorf("appsflyer sync: open run: %w", err)
	}

	daily, events, err := doSync(ctx, db, client, apps, from, to)
	res.Apps, res.DailyRows, res.EventRows = len(apps), daily, events
	if err != nil {
		_, _ = db.PG.ExecContext(ctx,
			`UPDATE appsflyer_sync_runs SET finished_at=NOW(), status='error', error=$2,
			     apps_n=$3, daily_rows=$4, event_rows=$5 WHERE id=$1`,
			runID, err.Error(), res.Apps, res.DailyRows, res.EventRows)
		slog.Error("appsflyer sync failed", "run_id", runID, "err", err)
		return res, err
	}

	_, _ = db.PG.ExecContext(ctx,
		`UPDATE appsflyer_sync_runs SET finished_at=NOW(), status='ok',
		     apps_n=$2, daily_rows=$3, event_rows=$4 WHERE id=$1`,
		runID, res.Apps, res.DailyRows, res.EventRows)
	slog.Info("appsflyer sync ok", "run_id", runID, "apps", res.Apps,
		"daily_rows", res.DailyRows, "event_rows", res.EventRows, "from", res.From, "to", res.To)
	return res, nil
}

func doSync(ctx context.Context, db *core.DB, client *appsflyer.Client, apps []appsflyer.App,
	from, to time.Time) (int, int, error) {

	var daily, events int
	for i, app := range apps {
		if i > 0 {
			select {
			case <-ctx.Done():
				return daily, events, ctx.Err()
			case <-time.After(appDelay):
			}
		}
		for _, chunk := range windows(from, to) {
			rows, err := client.FetchPartnersByDate(ctx, app.AppID, chunk.from, chunk.to)
			if err != nil {
				return daily, events, err
			}
			for _, row := range rows {
				d, e := upsertRow(ctx, db, app, row)
				daily += d
				events += e
			}
			// Country breakdown, from the geo report, into the parallel geo table.
			geo, err := client.FetchGeoByDate(ctx, app.AppID, chunk.from, chunk.to)
			if err != nil {
				return daily, events, err
			}
			for _, row := range geo {
				upsertGeoRow(ctx, db, app, row)
			}
		}
	}
	return daily, events, nil
}

type window struct{ from, to string }

// windows splits [from, to] into <= maxWindowDays chunks (the API per-call ceiling).
func windows(from, to time.Time) []window {
	var out []window
	for start := from; !start.After(to); start = start.AddDate(0, 0, maxWindowDays) {
		end := start.AddDate(0, 0, maxWindowDays-1)
		if end.After(to) {
			end = to
		}
		out = append(out, window{start.Format("2006-01-02"), end.Format("2006-01-02")})
	}
	return out
}

// upsertRow writes one report row into appsflyer_daily and its firing events into
// appsflyer_events. Returns (dailyRows, eventRows) touched (0 or 1 daily, N events).
func upsertRow(ctx context.Context, db *core.DB, app appsflyer.App, row appsflyer.Row) (int, int) {
	rawJSON, _ := json.Marshal(row.Raw)

	_, err := db.PG.ExecContext(ctx, `
		INSERT INTO appsflyer_daily
		  (app_id, platform, activity_date, media_source, campaign, agency,
		   impressions, clicks, installs, sessions, loyal_users,
		   total_cost_usd, total_revenue_usd, raw, synced_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
		ON CONFLICT (app_id, activity_date, media_source, campaign, agency) DO UPDATE SET
		  platform=EXCLUDED.platform, impressions=EXCLUDED.impressions, clicks=EXCLUDED.clicks,
		  installs=EXCLUDED.installs, sessions=EXCLUDED.sessions, loyal_users=EXCLUDED.loyal_users,
		  total_cost_usd=EXCLUDED.total_cost_usd, total_revenue_usd=EXCLUDED.total_revenue_usd,
		  raw=EXCLUDED.raw, synced_at=NOW()`,
		app.AppID, app.Platform, row.Date, row.MediaSource, row.Campaign, row.Agency,
		row.Impressions, row.Clicks, row.Installs, row.Sessions, row.LoyalUsers,
		row.CostUSD, row.RevenueUSD, string(rawJSON))
	if err != nil {
		slog.Error("appsflyer daily upsert", "app", app.AppID, "date", row.Date, "err", err)
		return 0, 0
	}

	ev := 0
	for _, e := range row.Events {
		_, err := db.PG.ExecContext(ctx, `
			INSERT INTO appsflyer_events
			  (app_id, platform, activity_date, media_source, campaign, agency,
			   event_name, unique_users, event_count, sales_usd, synced_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
			ON CONFLICT (app_id, activity_date, media_source, campaign, agency, event_name) DO UPDATE SET
			  platform=EXCLUDED.platform, unique_users=EXCLUDED.unique_users,
			  event_count=EXCLUDED.event_count, sales_usd=EXCLUDED.sales_usd, synced_at=NOW()`,
			app.AppID, app.Platform, row.Date, row.MediaSource, row.Campaign, row.Agency,
			e.Name, e.UniqueUsers, e.EventCount, e.SalesUSD)
		if err != nil {
			slog.Error("appsflyer event upsert", "app", app.AppID, "event", e.Name, "err", err)
			continue
		}
		ev++
	}
	return 1, ev
}

// upsertGeoRow writes one geo report row into appsflyer_geo (country-level). Rows
// with no country are skipped — they carry no geography to break down.
func upsertGeoRow(ctx context.Context, db *core.DB, app appsflyer.App, row appsflyer.Row) {
	if row.Country == "" {
		return
	}
	_, err := db.PG.ExecContext(ctx, `
		INSERT INTO appsflyer_geo
		  (app_id, platform, activity_date, country, media_source, campaign, agency,
		   impressions, clicks, installs, sessions, loyal_users, total_cost_usd, total_revenue_usd, synced_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
		ON CONFLICT (app_id, activity_date, country, media_source, campaign, agency) DO UPDATE SET
		  platform=EXCLUDED.platform, impressions=EXCLUDED.impressions, clicks=EXCLUDED.clicks,
		  installs=EXCLUDED.installs, sessions=EXCLUDED.sessions, loyal_users=EXCLUDED.loyal_users,
		  total_cost_usd=EXCLUDED.total_cost_usd, total_revenue_usd=EXCLUDED.total_revenue_usd, synced_at=NOW()`,
		app.AppID, app.Platform, row.Date, row.Country, row.MediaSource, row.Campaign, row.Agency,
		row.Impressions, row.Clicks, row.Installs, row.Sessions, row.LoyalUsers, row.CostUSD, row.RevenueUSD)
	if err != nil {
		slog.Error("appsflyer geo upsert", "app", app.AppID, "date", row.Date, "country", row.Country, "err", err)
	}
}

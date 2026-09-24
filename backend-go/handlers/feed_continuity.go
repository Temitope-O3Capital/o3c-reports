package handlers

// Continuity alerting for inbound feeds.
//
// app.v_pipeline_freshness answers "is data arriving?". On 2026-09-24 it reported
// feed_transactions as ok, minutes old, while 12 September held no rows at all and the
// 9th, 10th and 13th held two, two and three against a typical 111. Nothing raised a
// hand, because the feed resumed the next day and recency was never in question.
//
// That gap had already cost something measurable. The 14 September card cycle derived
// from this feed reconciled interest on 883 of 883 accounts exactly, because interest
// posts as one cycle-close entry on a day the feed has, while cash advance came in 12.9%
// short — and four of the window's 31 days are empty, which is 12.9% of the window.
//
// Recency and continuity are different properties, and only one of them was measured.
// app.v_feed_continuity (migration 291) measures the other; this turns it into a
// notification, reusing the alert state table and the claim-then-notify shape the
// freshness monitor already uses.
//
// BOUNDED TO DAYS WORTH ACTING ON. Only gaps inside feedGapLookbackDays alert. A feed
// that skipped a day last week is something someone can still chase; September's four
// missing days are a backlog, and a backlog belongs on a page rather than in an alarm
// that fires every morning for ever. The view still carries the full 60 days for anyone
// looking, which is where that history should be read.

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/o3c/workspace/core"
)

// How far back a gap still counts as actionable. A daily feed that skipped a day is
// worth chasing for about a week; past that, whoever could have refilled it has moved on.
const feedGapLookbackDays = 7

const feedContinuitySQL = `
	WITH win AS (
	    SELECT source_key,
	           count(*) FILTER (WHERE state = 'missing')::int AS missing_days,
	           count(*) FILTER (WHERE state = 'thin')::int    AS thin_days,
	           min(day) FILTER (WHERE state <> 'ok')          AS first_bad_day,
	           max(day) FILTER (WHERE state <> 'ok')          AS last_bad_day,
	           max(typical_day)::int                          AS typical_day
	      FROM app.v_feed_continuity
	     WHERE day >= CURRENT_DATE - $1::int
	     GROUP BY source_key)
	SELECT w.source_key, w.missing_days, w.thin_days, w.typical_day,
	       w.first_bad_day::text AS first_bad_day,
	       w.last_bad_day::text  AS last_bad_day,
	       COALESCE(f.label, w.source_key) AS label,
	       f.notes,
	       -- Ownership is configured once, on app.pipeline_source, and read the same way
	       -- the freshness monitor reads it, so a gap reaches whoever owns staleness.
	       COALESCE(array_to_string(s.notify_roles, ','), '') AS notify_roles
	  FROM win w
	  LEFT JOIN app.v_pipeline_freshness f ON f.source_key = w.source_key
	  LEFT JOIN app.pipeline_source s      ON s.source_key = w.source_key`

// checkFeedContinuity raises a "gap" alert for any feed that skipped or nearly skipped a
// day inside the lookback, and clears it once the window is clean again.
func checkFeedContinuity(ctx context.Context, db *core.DB) (raised, recovered int) {
	rows, err := db.PGQuery(ctx, feedContinuitySQL, feedGapLookbackDays)
	if err != nil {
		slog.Error("feed continuity: query failed", "err", err)
		return 0, 0
	}
	for _, r := range rows {
		if str(r["source_key"]) == "" {
			continue
		}
		if toInt64(r["missing_days"])+toInt64(r["thin_days"]) > 0 {
			if raisePipelineAlert(ctx, db, r, "gap") {
				raised++
			}
			continue
		}
		recovered += resolveFeedGapAlert(ctx, db, r)
	}
	return raised, recovered
}

// resolveFeedGapAlert closes an open gap alert and says what recovery actually means
// here. resolvePipelineAlerts is not reused because its recovery line talks about how
// old the newest data is, which was never the question a gap alert asked.
func resolveFeedGapAlert(ctx context.Context, db *core.DB, r core.Row) int {
	src := str(r["source_key"])
	closed, err := db.PGQuery(ctx, `
		UPDATE app.pipeline_alert_state
		   SET resolved_at = now()
		 WHERE source_key = $1 AND level = 'gap' AND resolved_at IS NULL
		 RETURNING notify_count`, src)
	if err != nil {
		slog.Error("feed continuity: resolve failed", "source", src, "err", err)
		return 0
	}
	if len(closed) == 0 {
		return 0
	}
	// Only announce recovery to people who were told it broke.
	if toInt64(closed[0]["notify_count"]) > 0 {
		NotifyRoles(ctx, db, pipelineNotifyRoles(r), NotifPayload{
			EventType: EvtSystemAlert,
			Title:     "No More Gaps: " + str(r["label"]),
			Body: fmt.Sprintf("Every one of the last %d days now carries data for %s.",
				feedGapLookbackDays, str(r["label"])),
			ActionURL: "/admin/data-freshness",
			EntityRef: src,
			GroupKey:  "pipeline_" + src + "_gap_recovered",
			Priority:  "normal",
		})
	}
	return 1
}

// feedGapDetail is the body of a gap alert. Written to be read by someone who has just
// been told a feed is healthy by every other signal they have.
func feedGapDetail(r core.Row) string {
	label := str(r["label"])
	missing := toInt64(r["missing_days"])
	thin := toInt64(r["thin_days"])
	typical := toInt64(r["typical_day"])

	var what string
	switch {
	case missing > 0 && thin > 0:
		what = fmt.Sprintf("%d day(s) with no rows at all and %d well below a normal day", missing, thin)
	case missing > 0:
		what = fmt.Sprintf("%d day(s) with no rows at all", missing)
	default:
		what = fmt.Sprintf("%d day(s) well below a normal day", thin)
	}

	msg := fmt.Sprintf("%s has %s in the last %d days (%s to %s). A typical day carries about %d rows. "+
		"The feed is arriving now, so the freshness monitor reads it as healthy: this is about days that were "+
		"skipped, not about how old the newest data is. Anything computed over that period is short by whatever "+
		"those days held.",
		label, what, feedGapLookbackDays,
		str(r["first_bad_day"]), str(r["last_bad_day"]), typical)

	if notes := str(r["notes"]); notes != "" {
		msg += " " + notes
	}
	return msg
}

// feedGapWindowStart is the first day the current check considered, for logging.
func feedGapWindowStart() string {
	return time.Now().AddDate(0, 0, -feedGapLookbackDays).Format("2006-01-02")
}

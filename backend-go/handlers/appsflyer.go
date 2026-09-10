package handlers

import (
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

// AppsFlyer acquisition read API — powers the Marketing → Acquisition tab.
//
// Everything here reads the local mirror (appsflyer_daily / appsflyer_events)
// populated by the sync worker; it never calls AppsFlyer live. Access mirrors the
// marketing/analytics surface (page "campaigns") plus reporting/executive.

// afFunnelOrder is the canonical signup→activation journey for "Blink by O3".
// The funnel endpoint returns known events in this order; any event not listed is
// appended afterwards (so a newly-defined app event still shows, just at the end).
var afFunnelOrder = []string{
	"first_open",
	"registration_start",
	"registration_details_submitted",
	"registration_email_verified",
	"registration_passcode_created",
	"af_complete_registration",
	"kyc_start",
	"kyc_result",
	"bvn_start",
	"bvn_result",
	"onboarding_start",
	"onboarding_complete",
	"card_cta_tapped",
	"af_login",
}

// afFunnelRank returns a stable ordering rank for an event name.
func afFunnelRank(name string) int {
	for i, n := range afFunnelOrder {
		if n == name {
			return i
		}
	}
	return len(afFunnelOrder) + 1 // unknown events sort to the end, keeping their group
}

// appsflyerProductApps maps a "product" (a mobile app in its own right) to the
// AppsFlyer app ids that belong to it. Mobile Analytics is organised by product:
//   - "blink" → the two "Blink by O3" apps we actually poll (iOS + Android).
//   - "app"   → O3's main "o3cards" app; defined here for forward-compatibility but
//     not on AppsFlyer yet, so it simply has no rows (an empty dashboard).
//
// An unknown product yields no ids → an empty (but valid) result.
func appsflyerProductApps(product string) []string {
	switch product {
	case "", "blink":
		var ids []string
		for _, a := range appsflyerApps() {
			ids = append(ids, a.AppID)
		}
		return ids
	case "app", "o3cards":
		return []string{"id1565911719", "com.o3cards.o3cards"}
	}
	return nil
}

// RegisterAppsFlyer mounts the acquisition read endpoints under /api/appsflyer.
func RegisterAppsFlyer(r chi.Router, db *core.DB) {
	access := core.RequirePages("campaigns", "reports", "executive")
	r.With(access).Get("/summary", appsflyerSummary(db))
	r.With(access).Get("/timeseries", appsflyerTimeseries(db))
	r.With(access).Get("/sources", appsflyerSources(db))
	r.With(access).Get("/funnel", appsflyerFunnel(db))
	r.With(access).Get("/campaigns", appsflyerCampaigns(db))
	r.With(access).Get("/scorecard", appsflyerScorecard(db))
	r.With(access).Get("/geo", appsflyerGeo(db))
}

// afParams pulls the shared scope from the request: product (default "blink"),
// platform ("ios"|"android"|""), and the from/to window (default trailing 30 days).
func afParams(r *http.Request) (product, platform, from, to string) {
	product = qstr(r, "product")
	if product == "" {
		product = "blink"
	}
	if p := qstr(r, "platform"); p == "ios" || p == "android" {
		platform = p
	}
	to = qstr(r, "to")
	if to == "" {
		to = time.Now().UTC().Format("2006-01-02")
	}
	from = qstr(r, "from")
	if from == "" {
		from = time.Now().UTC().AddDate(0, 0, -30).Format("2006-01-02")
	}
	return product, platform, from, to
}

// afWhereFor builds the shared WHERE predicate + bound args for an explicit window.
// A product with no known app ids resolves to an always-false predicate so a
// dashboard renders empty rather than leaking another product's rows. All values are
// bound, never interpolated.
func afWhereFor(product, platform, from, to string) (where string, args []any) {
	args = []any{from, to}
	where = "activity_date BETWEEN $1 AND $2"
	ids := appsflyerProductApps(product)
	if len(ids) == 0 {
		return where + " AND FALSE", args
	}
	ph := make([]string, 0, len(ids))
	for _, id := range ids {
		args = append(args, id)
		ph = append(ph, fmt.Sprintf("$%d", len(args)))
	}
	where += " AND app_id IN (" + strings.Join(ph, ",") + ")"
	if platform == "ios" || platform == "android" {
		args = append(args, platform)
		where += fmt.Sprintf(" AND platform = $%d", len(args))
	}
	return where, args
}

// afRange is the request-scoped predicate every read endpoint shares.
func afRange(r *http.Request) (where string, args []any) {
	product, platform, from, to := afParams(r)
	return afWhereFor(product, platform, from, to)
}

// afPrevWindow returns the equal-length window immediately preceding [from,to], for
// period-over-period deltas. Falls back to the same window on unparseable dates.
func afPrevWindow(from, to string) (pFrom, pTo string) {
	f, err1 := time.Parse("2006-01-02", from)
	t, err2 := time.Parse("2006-01-02", to)
	if err1 != nil || err2 != nil || !t.After(f) {
		return from, to
	}
	length := t.Sub(f) // inclusive span
	pTo = f.AddDate(0, 0, -1).Format("2006-01-02")
	pFrom = f.AddDate(0, 0, -1).Add(-length).Format("2006-01-02")
	return pFrom, pTo
}

// appsflyerSummary returns KPI totals overall and per platform, plus the media-source
// mix, for the KPI strip and headline cards.
func appsflyerSummary(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		where, args := afRange(r)

		byPlat, _ := db.PGQuery(ctx, `
			SELECT platform,
			       COALESCE(SUM(installs),0)           AS installs,
			       COALESCE(SUM(sessions),0)           AS sessions,
			       COALESCE(SUM(loyal_users),0)        AS loyal_users,
			       COALESCE(SUM(total_cost_usd),0)     AS cost_usd,
			       COALESCE(SUM(total_revenue_usd),0)  AS revenue_usd,
			       COUNT(*)                            AS rows
			FROM appsflyer_daily WHERE `+where+`
			GROUP BY platform ORDER BY platform`, args...)

		var installs, sessions, loyal int64
		var cost, revenue float64
		for _, row := range byPlat {
			installs += toInt64(row["installs"])
			sessions += toInt64(row["sessions"])
			loyal += toInt64(row["loyal_users"])
			cost += toFloat(row["cost_usd"])
			revenue += toFloat(row["revenue_usd"])
		}

		// Distinct paid sources (anything not Organic/None) that carried an install.
		paid, _ := db.PGQuery(ctx, `
			SELECT COUNT(DISTINCT media_source) AS n
			FROM appsflyer_daily
			WHERE `+where+` AND installs > 0
			  AND media_source NOT IN ('Organic','None','')`, args...)
		paidSources := int64(0)
		if len(paid) > 0 {
			paidSources = toInt64(paid[0]["n"])
		}

		// Previous equal-length window, for period-over-period deltas.
		product, platform, from, to := afParams(r)
		pFrom, pTo := afPrevWindow(from, to)
		pWhere, pArgs := afWhereFor(product, platform, pFrom, pTo)
		prev := map[string]any{"installs": 0, "sessions": 0, "loyal_users": 0, "cost_usd": 0.0}
		if pr, _ := db.PGQuery(ctx, `
			SELECT COALESCE(SUM(installs),0) installs, COALESCE(SUM(sessions),0) sessions,
			       COALESCE(SUM(loyal_users),0) loyal_users, COALESCE(SUM(total_cost_usd),0) cost_usd
			FROM appsflyer_daily WHERE `+pWhere, pArgs...); len(pr) > 0 {
			prev = map[string]any{
				"installs": toInt64(pr[0]["installs"]), "sessions": toInt64(pr[0]["sessions"]),
				"loyal_users": toInt64(pr[0]["loyal_users"]), "cost_usd": toFloat(pr[0]["cost_usd"]),
			}
		}

		respond(w, map[string]any{
			"totals": map[string]any{
				"installs":     installs,
				"sessions":     sessions,
				"loyal_users":  loyal,
				"cost_usd":     cost,
				"revenue_usd":  revenue,
				"paid_sources": paidSources,
			},
			"previous":    prev,
			"prev_from":   pFrom,
			"prev_to":     pTo,
			"by_platform": byPlat,
		}, "pg")
	}
}

// appsflyerScorecard returns per-dimension efficiency & quality metrics for the
// action-driving scorecard. dimension = "source" (default) or "campaign". Raw
// aggregates only — the client derives CPI, CTR, CVR, loyal-user (usage) rate and
// sessions/install so the maths is visible and one place owns the formulas.
func appsflyerScorecard(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		where, args := afRange(r)

		groupBy := "media_source"
		keyExpr := "media_source AS key, media_source"
		if qstr(r, "dimension") == "campaign" {
			groupBy = "campaign, media_source"
			keyExpr = "campaign AS key, media_source"
		}
		rows, _ := db.PGQuery(ctx, `
			SELECT `+keyExpr+`,
			       COALESCE(SUM(impressions),0)    AS impressions,
			       COALESCE(SUM(clicks),0)         AS clicks,
			       COALESCE(SUM(installs),0)       AS installs,
			       COALESCE(SUM(sessions),0)       AS sessions,
			       COALESCE(SUM(loyal_users),0)    AS loyal_users,
			       COALESCE(SUM(total_cost_usd),0) AS cost_usd
			FROM appsflyer_daily WHERE `+where+`
			GROUP BY `+groupBy+`
			HAVING COALESCE(SUM(installs),0) > 0
			ORDER BY installs DESC, key`, args...)
		respond(w, map[string]any{"rows": rows}, "pg")
	}
}

// appsflyerTimeseries returns daily installs / sessions / loyal users for the trend.
func appsflyerTimeseries(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		where, args := afRange(r)
		rows, _ := db.PGQuery(ctx, `
			SELECT activity_date::text AS date,
			       COALESCE(SUM(installs),0)    AS installs,
			       COALESCE(SUM(sessions),0)    AS sessions,
			       COALESCE(SUM(loyal_users),0) AS loyal_users
			FROM appsflyer_daily WHERE `+where+`
			GROUP BY activity_date ORDER BY activity_date`, args...)
		respond(w, map[string]any{"series": rows}, "pg")
	}
}

// appsflyerSources returns the media-source breakdown (installs, sessions, spend).
func appsflyerSources(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		where, args := afRange(r)
		rows, _ := db.PGQuery(ctx, `
			SELECT media_source,
			       COALESCE(SUM(installs),0)       AS installs,
			       COALESCE(SUM(sessions),0)       AS sessions,
			       COALESCE(SUM(loyal_users),0)    AS loyal_users,
			       COALESCE(SUM(total_cost_usd),0) AS cost_usd
			FROM appsflyer_daily WHERE `+where+`
			GROUP BY media_source ORDER BY installs DESC, media_source`, args...)
		respond(w, map[string]any{"sources": rows}, "pg")
	}
}

// appsflyerCampaigns returns installs / engagement / spend grouped by campaign
// (with its media source), for the Campaigns tab. Rows with no installs and no
// sessions are dropped so the "None" no-campaign bucket doesn't dominate the list.
func appsflyerCampaigns(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		where, args := afRange(r)
		rows, _ := db.PGQuery(ctx, `
			SELECT campaign, media_source,
			       COALESCE(SUM(installs),0)       AS installs,
			       COALESCE(SUM(sessions),0)       AS sessions,
			       COALESCE(SUM(loyal_users),0)    AS loyal_users,
			       COALESCE(SUM(total_cost_usd),0) AS cost_usd
			FROM appsflyer_daily WHERE `+where+`
			GROUP BY campaign, media_source
			HAVING COALESCE(SUM(installs),0) > 0 OR COALESCE(SUM(sessions),0) > 0
			ORDER BY installs DESC, campaign`, args...)
		respond(w, map[string]any{"campaigns": rows}, "pg")
	}
}

// appsflyerGeo returns the country breakdown (installs / sessions / loyal / spend)
// from the parallel geo mirror. Country is the finest geography the aggregate feed
// exposes (no state/region).
func appsflyerGeo(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		where, args := afRange(r)
		rows, _ := db.PGQuery(ctx, `
			SELECT country,
			       COALESCE(SUM(installs),0)       AS installs,
			       COALESCE(SUM(sessions),0)       AS sessions,
			       COALESCE(SUM(loyal_users),0)    AS loyal_users,
			       COALESCE(SUM(total_cost_usd),0) AS cost_usd
			FROM appsflyer_geo WHERE `+where+`
			GROUP BY country
			HAVING COALESCE(SUM(installs),0) > 0
			ORDER BY installs DESC, country`, args...)
		respond(w, map[string]any{"countries": rows}, "pg")
	}
}

// appsflyerFunnel returns the signup→activation funnel (unique users per event),
// ordered along the canonical journey.
func appsflyerFunnel(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		where, args := afRange(r)
		rows, _ := db.PGQuery(ctx, `
			SELECT event_name,
			       COALESCE(SUM(unique_users),0) AS unique_users,
			       COALESCE(SUM(event_count),0)  AS event_count
			FROM appsflyer_events WHERE `+where+`
			GROUP BY event_name`, args...)

		sort.SliceStable(rows, func(i, j int) bool {
			ri, rj := afFunnelRank(str(rows[i]["event_name"])), afFunnelRank(str(rows[j]["event_name"]))
			if ri != rj {
				return ri < rj
			}
			return str(rows[i]["event_name"]) < str(rows[j]["event_name"])
		})
		respond(w, map[string]any{"funnel": rows}, "pg")
	}
}

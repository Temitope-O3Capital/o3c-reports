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
//
// THIS LIST IS A DECLARATION OF BELIEF, AND IT HAS BEEN WRONG BEFORE. It originally
// placed onboarding_start/onboarding_complete after bvn_result, which made the Funnel
// tab report 227 users converting from a step with 9 — a "2,522% conversion" — and sent
// the "What to Act On" card hunting for its sharpest drop among events that are not
// sequential at all. Corrected 2026-09-28 on measured evidence: onboarding_start is
// 95.3% of first_open in August and 93.8% in September, i.e. Blink fires onboarding at
// APP-OPEN, before registration, not after BVN. onboarding_complete (200) likewise
// exceeds registration_start (124), which is impossible downstream of it.
//
// Only that one move was made. The remaining order below is still the original
// declaration and is NOT fully corroborated — see the caveat under it. Do not "fix" the
// rest by sorting on volume: the client validates this list against its own counts
// (lib/insights.ts checkSequence), and an order derived from those counts would make
// the check vacuous. Get the real sequence from whoever owns the Blink app.
var afFunnelOrder = []string{
	"first_open",
	"onboarding_start",
	"onboarding_complete",
	"registration_start",
	"registration_details_submitted",
	"registration_email_verified",
	"registration_passcode_created",
	"af_complete_registration",
	"kyc_start",
	"kyc_result",
	"bvn_start",
	"bvn_result",
	"card_cta_tapped",
}

// af_login was removed from the list above on 2026-09-29. It is not a stage of a
// first-time onboarding journey: a user who logs in is by definition already
// registered, and they do it again every session (1.20 fires per user-day over the
// month). Declaring it the TERMINAL step asserted "users who logged in finished
// onboarding", which is backwards — and it read 35 user-days sitting directly after
// bvn_result's 9, so it also manufactured a violation. It is now an unplaced event:
// still shown, badged, and excluded from every step-to-step conversion.
//
// This is the same class of correction as the onboarding move, and made on the same
// basis — what the event MEANS, never on which way its count happens to point.

// WHY THIS FEED CANNOT FULLY VERIFY A FUNNEL, and why small violations survive.
//
// appsflyer_events.unique_users is unique PER DAY per source/campaign/agency, so
// summing it over a window yields user-days, not users. That is sound for an event each
// user fires once and inflates every event they repeat. Measured over 2026-08-29→09-28
// (event_count ÷ unique_users): first_open 1.03 and af_complete_registration 1.07 are
// effectively once-per-user; registration_start 2.27, bvn_start 2.50 and
// onboarding_complete 1.94 clearly are not.
//
// So a correct order can still show a later step a few users "bigger" than the one
// before it. A few such residuals remain, all small (+1 to +25 user-days) against the
// +218 the onboarding misplacement produced. The client reports them rather than hiding
// them, and confines conversion to the corroborated run. Do not paper over them with a
// tolerance threshold: that would be tuning the check until the data looks clean, and
// it is the gross misordering this guard exists to catch.
//
// SOME "STEPS" ARE THE SAME EVENT UNDER THREE NAMES. Comparing steps WITHIN a single
// day removes the user-days problem entirely — on one day, unique_users really is
// unique users — and that test found something the window totals hid. Over
// 2026-08-29→09-28, kyc_start and registration_details_submitted carry an IDENTICAL
// count on all 21 days they both appear (48 user-days each); af_complete_registration
// matches both on 20 of those 21 (47). They are not three stages a user passes
// through, they are one moment Blink reports three times, so a "conversion rate"
// between them is near-100% by construction and means nothing.
//
// That, not a bad ordering, is what most of the residual violations were: reordering
// events that move in lockstep can never make them monotonic. afAliasedSteps below
// detects it from the per-day counts and marks the later row `same_as` (the earlier
// name it duplicates), so the client can say "same event as X" instead of implying a
// stage. Which of the names Blink should actually emit is a question for the app team;
// until they answer, the page says what is true rather than inventing a funnel out of
// one event.

// afAliasMinDays is how many days two events must BOTH appear on before identical
// daily counts are called aliasing rather than coincidence. Two rare events can match
// for two or three days by chance; matching on ten-plus separate days does not happen
// to genuinely distinct steps. This is a floor on evidence, not a tolerance on the
// comparison — the counts themselves must agree exactly, on every shared day.
const afAliasMinDays = 10

// afAliasedSteps maps each event that duplicates an EARLIER one in the funnel to that
// earlier event's name — names that are not separate steps at all.
//
// Every pair is compared, not just neighbours. The real case is not adjacent: over
// 2026-08-29→09-28 the duplicate of registration_details_submitted (rank 4) is
// kyc_start (rank 8), four steps further down. An adjacency-only version of this
// function found nothing on live data and silently did no work.
//
// `daily` is one row per event per day; events observed on different sets of days are
// by definition not the same event.
func afAliasedSteps(rows []core.Row, daily []core.Row) map[string]string {
	byEvent := map[string]map[string]int64{}
	for _, r := range daily {
		ev := str(r["event_name"])
		if byEvent[ev] == nil {
			byEvent[ev] = map[string]int64{}
		}
		byEvent[ev][str(r["d"])] = toInt64(r["uu"])
	}
	sameDays := func(a, b map[string]int64) bool {
		if len(a) < afAliasMinDays || len(a) != len(b) {
			return false
		}
		for d, v := range a {
			if w, ok := b[d]; !ok || w != v {
				return false
			}
		}
		return true
	}
	// rows arrive in funnel order, so the FIRST match found scanning backwards is the
	// earliest-ranked name for that moment — the one the journey is described by, and
	// the only one of the group that keeps its step-to-step conversion.
	out := map[string]string{}
	for i := 1; i < len(rows); i++ {
		cur := str(rows[i]["event_name"])
		for j := 0; j < i; j++ {
			earlier := str(rows[j]["event_name"])
			if sameDays(byEvent[earlier], byEvent[cur]) {
				out[cur] = earlier
				break
			}
		}
	}
	return out
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
//
// Each row carries `ordered`: true when the event appears in afFunnelOrder above, false
// when it is an app event we never placed in the journey and the sort merely appended
// alphabetically. The client MUST NOT compute step-to-step conversion across an
// unordered row — position carries no meaning there. The client also re-validates the
// ordered run against its own counts (see lib/insights.ts checkSequence), because this
// list is a declaration of belief and the app has already outgrown it once:
// onboarding_start sits at rank 10 here but fires at app-open, which produced a
// "2,522% conversion" on the Funnel tab until the client started checking.
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
		for _, row := range rows {
			rank := afFunnelRank(str(row["event_name"]))
			row["rank"] = rank
			row["ordered"] = rank < len(afFunnelOrder)
		}

		// Flag adjacent steps that are one event under two names (see the block above
		// afFunnelRank). Best-effort: if the per-day query fails, every row simply
		// keeps same_as_prev=false and the client behaves exactly as it did before.
		daily, _ := db.PGQuery(ctx, `
			SELECT event_name, activity_date::text AS d,
			       COALESCE(SUM(unique_users),0) AS uu
			FROM appsflyer_events WHERE `+where+`
			GROUP BY event_name, activity_date`, args...)
		alias := afAliasedSteps(rows, daily)
		for _, row := range rows {
			// Names the earlier event this row duplicates, empty when it is a step in
			// its own right. Whether that duplicate happens to be the row directly
			// above — the only place a meaningless ~100% conversion would be drawn —
			// the client can see for itself; it does not need a second field to
			// disagree with.
			row["same_as"] = alias[str(row["event_name"])]
		}
		respond(w, map[string]any{"funnel": rows}, "pg")
	}
}

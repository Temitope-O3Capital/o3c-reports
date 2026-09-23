package handlers

// Customer retention — the lifecycle store and the views over it.
//
// The workspace could already SEE churn in aggregate: a lifecycle taxonomy is
// computed inside customer360.go and growth.go and rendered in six screens. What it
// could not do was act on one customer, because the bucket was recomputed on every
// query and stored nowhere. Migration 289 gives it a home; this keeps it current and
// serves it.
//
// Read the coverage note in migration 289 before trusting any bucket. app.transactions
// is card-only, there is no savings ledger in this database, and ~13,300 of 21,300
// parties carry bucket='unknown' because we hold no money history for them at all —
// which is NOT the same as "they never transacted".

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

// retentionWorkerKey is the heartbeat key shown on the Sync Status page.
const retentionWorkerKey = "retention_lifecycle"

// StartRetentionWorker recomputes app.customer_lifecycle once a day at 03:30.
//
// 03:30 rather than the 02:00 recovery sweep or the 08:00 alert runs: the overnight
// batch (00:05) and the recovery escalation (02:00) have finished by then, so a
// customer escalated to recovery overnight is already flagged when their bucket is
// scored — has_open_recovery is what keeps a customer in collections out of a
// win-back queue, and computing it before the escalation ran would miss a night.
//
// The recompute is a full rebuild (see the function's own comment) and takes about
// five seconds over a million transactions, so there is no incremental bookkeeping to
// drift out of step.
func StartRetentionWorker(db *core.DB) {
	now := time.Now()
	next := time.Date(now.Year(), now.Month(), now.Day(), 3, 30, 0, 0, now.Location())
	if now.After(next) {
		next = next.Add(24 * time.Hour)
	}
	time.Sleep(next.Sub(now))
	for {
		runRetentionRecompute(db)
		time.Sleep(24 * time.Hour)
	}
}

func runRetentionRecompute(db *core.DB) {
	// Guard the CYCLE, not the goroutine: without this one bad row kills the worker
	// for the life of the process while the hub still reports it as running.
	defer recoverPanic(retentionWorkerKey)

	ctx := context.Background()
	WorkerBeat(ctx, db, retentionWorkerKey, "running", "", "")

	rows, err := db.PGQuery(ctx, `SELECT app.compute_customer_lifecycle() AS n`)
	if err != nil {
		slog.Error("retention: lifecycle recompute failed", "err", err)
		WorkerBeat(ctx, db, retentionWorkerKey, "error", err.Error(), "")
		return
	}
	written := int64(0)
	if len(rows) > 0 {
		written = toInt64(rows[0]["n"])
	}

	// The detail line a head reads the next morning. It names the workable queue
	// rather than the raw total, because the total is dominated by the ~13,300
	// parties we hold no history for and would read as reassuring nonsense.
	var workable, unknown int64
	var workableKobo int64
	if s, _ := db.PGQuery(ctx, `
		SELECT COUNT(*) FILTER (WHERE bucket IN ('lapsed','churned')
		                          AND measured AND contactable AND NOT has_open_recovery) AS workable,
		       COALESCE(SUM(value_kobo) FILTER (WHERE bucket IN ('lapsed','churned')
		                          AND measured AND contactable AND NOT has_open_recovery), 0) AS workable_kobo,
		       COUNT(*) FILTER (WHERE bucket = 'unknown') AS unknown
		  FROM app.customer_lifecycle`); len(s) > 0 {
		workable = toInt64(s[0]["workable"])
		workableKobo = toInt64(s[0]["workable_kobo"])
		unknown = toInt64(s[0]["unknown"])
	}

	detail := fmt.Sprintf("%d parties scored; %d workable for win-back (%s); %d unmeasured",
		written, workable, formatKoboShort(workableKobo), unknown)
	slog.Info("retention: lifecycle recomputed",
		"parties", written, "workable", workable, "unmeasured", unknown)
	WorkerBeat(ctx, db, retentionWorkerKey, "ok", detail, "")
}

// formatKoboShort renders a kobo amount as naira for a log or heartbeat line.
// Deliberately ASCII "NGN": this string reaches SMS-adjacent surfaces and the naira
// sign forces UCS-2 encoding, which triples the cost of a message.
func formatKoboShort(kobo int64) string {
	naira := float64(kobo) / 100
	switch {
	case naira >= 1e9:
		return fmt.Sprintf("NGN %.2fbn", naira/1e9)
	case naira >= 1e6:
		return fmt.Sprintf("NGN %.1fm", naira/1e6)
	case naira >= 1e3:
		return fmt.Sprintf("NGN %.0fk", naira/1e3)
	}
	return fmt.Sprintf("NGN %.0f", naira)
}

// ── Read API ─────────────────────────────────────────────────────────────────

// RegisterRetention mounts the retention read API.
//
// Access follows the 2026-09-15 decision that the Call Center owns At-Risk and
// Dormant with the buckets REASSIGNABLE to Sales, so both heads hold the page, as do
// Care (which now owns the email channel), Collections (whose open cases are the
// reason a customer is excluded from win-back) and the BI/executive roles that report
// on it. Agents reach the same facts through Customer 360, not through this list.
func RegisterRetention(r chi.Router, db *core.DB) {
	access := core.RequirePages("retention")
	r.With(access).Get("/summary", retentionSummary(db))
	r.With(access).Get("/customers", retentionList(db))
	// The Customer 360 panel is opened by anyone who can already open the customer,
	// so it rides customer360 rather than the retention page.
	r.With(core.RequirePages("customer360", "crm_contacts", "retention")).
		Get("/party/{id}", retentionForParty(db))
}

// retentionSummary — GET /api/retention/summary
// The bucket and tier distribution, plus the one number that matters: how many
// customers are actually workable for win-back and what they are worth.
func retentionSummary(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		buckets, err := db.PGQuery(ctx, `
			SELECT bucket,
			       COUNT(*)                                        AS parties,
			       COUNT(*) FILTER (WHERE contactable)              AS contactable,
			       COUNT(*) FILTER (WHERE has_open_recovery)        AS in_recovery,
			       COALESCE(SUM(value_kobo), 0)                     AS value_kobo
			  FROM app.customer_lifecycle
			 GROUP BY bucket`)
		if err != nil {
			respondErrLog(w, 500, "Could not load the retention summary", err)
			return
		}
		tiers, _ := db.PGQuery(ctx, `
			SELECT value_tier,
			       COUNT(*)                     AS parties,
			       COALESCE(SUM(value_kobo), 0) AS value_kobo
			  FROM app.customer_lifecycle
			 GROUP BY value_tier`)
		// The workable set: lapsed or churned, we actually hold history for them,
		// we can reach them, and they are not already a collections conversation.
		head, _ := db.PGQuery(ctx, `
			SELECT COUNT(*)                                   AS workable,
			       COALESCE(SUM(value_kobo), 0)               AS workable_kobo,
			       COUNT(*) FILTER (WHERE open_products > 0)  AS workable_with_open_product,
			       MAX(computed_at)                           AS computed_at
			  FROM app.customer_lifecycle
			 WHERE bucket IN ('lapsed','churned')
			   AND measured AND contactable AND NOT has_open_recovery`)

		out := map[string]any{"buckets": buckets, "tiers": tiers}
		if len(head) > 0 {
			out["workable"] = head[0]
		}
		respond(w, out, "json")
	}
}

// retentionList — GET /api/retention/customers
// The ranked working list. Defaults to the win-back cut because that is what the
// screen exists for; every filter is a fixed whitelist, so no user text reaches SQL.
func retentionList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		limit := qint(r, "limit", 100, 1, 500)
		offset := qint(r, "offset", 0, 0, 100000)

		where := "cl.measured"
		switch normalizeHelpdeskFilter(qstr(r, "bucket")) {
		case "active":
			where += " AND cl.bucket='active'"
		case "cooling":
			where += " AND cl.bucket='cooling'"
		case "at_risk":
			where += " AND cl.bucket='at_risk'"
		case "dormant":
			where += " AND cl.bucket='dormant'"
		case "lapsed":
			where += " AND cl.bucket='lapsed'"
		case "churned":
			where += " AND cl.bucket='churned'"
		default:
			where += " AND cl.bucket IN ('lapsed','churned')"
		}
		switch normalizeHelpdeskFilter(qstr(r, "tier")) {
		case "vip":
			where += " AND cl.value_tier='vip'"
		case "gold":
			where += " AND cl.value_tier='gold'"
		case "silver":
			where += " AND cl.value_tier='silver'"
		case "mass":
			where += " AND cl.value_tier='mass'"
		}
		// Default ON: a win-back list that includes unreachable customers or people
		// already in recovery is a list an agent has to clean by hand every morning.
		if qstr(r, "include_unreachable") != "1" {
			where += " AND cl.contactable"
		}
		if qstr(r, "include_recovery") != "1" {
			where += " AND NOT cl.has_open_recovery"
		}
		if qstr(r, "open_product") == "1" {
			where += " AND cl.open_products > 0"
		}

		total := 0
		if tr, _ := db.PGQuery(ctx,
			"SELECT COUNT(*) AS n FROM app.customer_lifecycle cl WHERE "+where); len(tr) > 0 {
			total = int(toInt64(tr[0]["n"]))
		}

		rows, err := db.PGQuery(ctx, `
			SELECT cl.party_id, cl.bucket, cl.value_tier, cl.value_kobo,
			       cl.lifetime_value_kobo, cl.last_txn_at, cl.days_since_txn,
			       cl.open_products, cl.has_open_recovery, cl.contactable,
			       p.full_name, p.primary_phone, p.primary_email,
			       (SELECT c.cif FROM app.customers c
			         WHERE c.party_id = cl.party_id ORDER BY c.cif LIMIT 1) AS cif
			  FROM app.customer_lifecycle cl
			  JOIN app.parties p ON p.party_id = cl.party_id
			 WHERE `+where+`
			 ORDER BY cl.value_kobo DESC, cl.party_id
			 LIMIT $1 OFFSET $2`, limit, offset)
		if err != nil {
			respondErrLog(w, 500, "Could not load the retention list", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, map[string]any{"customers": rows, "total": total}, "pg")
	}
}

// retentionForParty — GET /api/retention/party/{id}
// One customer's lifecycle row, for the Customer 360 panel.
func retentionForParty(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := toInt64FromStr(chi.URLParam(r, "id"))
		if id == 0 {
			respondErr(w, 400, "Invalid customer id")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT party_id, bucket, value_tier, value_kobo, lifetime_value_kobo,
			       last_txn_at, days_since_txn, open_products, measured,
			       has_open_recovery, contactable, computed_at
			  FROM app.customer_lifecycle WHERE party_id = $1`, id)
		if err != nil {
			respondErrLog(w, 500, "Could not load the retention profile", err)
			return
		}
		if len(rows) == 0 {
			// Not an error: a party minted since the last overnight run simply has no
			// row yet. The caller renders "not yet scored" rather than an alarm.
			respond(w, map[string]any{"scored": false}, "json")
			return
		}
		respond(w, map[string]any{"scored": true, "lifecycle": rows[0]}, "pg")
	}
}

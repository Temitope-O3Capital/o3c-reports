package handlers

import (
	"context"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/o3c/workspace/core"
)

// The collections queue refresh, on a timer.
//
// WHY THIS EXISTS. Generate Assignments does two jobs: it recomputes the outstanding
// balance and DPD bucket on rows already being worked, and it creates a row for a
// delinquent customer who has none. Both sat behind a head-gated button — and the credit
// activity log showed the endpoint had been invoked **zero times, ever**.
//
// The cost of that, measured on 2026-09-22: 255 open card assignments had drifted from
// their live balances — 141 overstated, 114 understated, N90,186,756.95 of absolute error.
// A queue nobody recomputes is not "a bit stale"; it is wrong in whichever direction each
// customer moved since the row was written, and an agent picks up the phone on it.
//
// WHAT IS AND IS NOT AUTOMATED. The run creates rows UNASSIGNED — agent_user_id stays
// NULL — so distributing work to named agents remains a human act, exactly as before.
// What is automated is arithmetic: recomputing balances, and putting a delinquent customer
// into the unassigned pool so they are not invisible until someone remembers to click.
//
// The identity guards are unchanged and still apply: a Udara borrower with no cbs_links
// bridge, or one whose bare id is still held by a card-namespace row, is REFUSED and
// logged at Error rather than written under a guess.
const (
	collectionsQueueDefaultInterval = time.Hour
	automationAccountEmail          = "automation@o3capital.internal"
)

// StartCollectionsQueueWorker runs the generate/refresh cycle on a timer.
//
// It REFUSES to run at all if the automation service account is missing, rather than
// falling back to some other user id: assigned_by is NOT NULL, and silently signing
// automated work with a real person's id is how an audit trail starts lying. Migration 279
// creates the account.
func StartCollectionsQueueWorker(db *core.DB) {
	if strings.EqualFold(strings.TrimSpace(os.Getenv("COLLECTIONS_QUEUE_WORKER")), "off") {
		slog.Warn("collections queue worker disabled by COLLECTIONS_QUEUE_WORKER=off — " +
			"assignment balances will go stale until someone presses Generate Assignments")
		return
	}

	interval := collectionsQueueDefaultInterval
	if v := strings.TrimSpace(os.Getenv("COLLECTIONS_QUEUE_INTERVAL_MINUTES")); v != "" {
		if m, err := strconv.Atoi(v); err == nil && m >= 5 {
			interval = time.Duration(m) * time.Minute
		}
	}

	// Let the CBS book land first — the delinquency view reads cbs_loans, which
	// StartCBSSyncWorker fills shortly after boot. Refreshing before it arrives would
	// compute against an empty book.
	time.Sleep(2 * time.Minute)

	run := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()

		actorID, err := automationActorID(ctx, db)
		if err != nil {
			slog.Error("collections queue refresh SKIPPED — no automation service account; "+
				"refusing to attribute automated assignments to a real user (see migration 279)",
				"err", err)
			return
		}

		created, refused, err := runCollectionsGenerate(ctx, db, actorID)
		if err != nil {
			slog.Error("collections queue refresh failed", "err", err)
			return
		}
		slog.Info("collections queue refresh ok",
			"created", created, "refused_udara_ids", len(refused), "actor_id", actorID)
	}

	run()
	t := time.NewTicker(interval)
	defer t.Stop()
	for range t.C {
		run()
	}
}

// automationActorID resolves the service account created by migration 279. It deliberately
// does NOT create the row on the fly: a user account is a security object, and one should
// appear through a reviewed migration, never as a side effect of a worker starting.
func automationActorID(ctx context.Context, db *core.DB) (int64, error) {
	rows, err := db.PGQuery(ctx,
		`SELECT id FROM o3c_users WHERE LOWER(email) = $1 AND deleted_at IS NULL LIMIT 1`,
		automationAccountEmail)
	if err != nil {
		return 0, err
	}
	if len(rows) == 0 {
		return 0, errNoAutomationAccount
	}
	return toInt64(rows[0]["id"]), nil
}

var errNoAutomationAccount = errAutomationAccount{}

type errAutomationAccount struct{}

func (errAutomationAccount) Error() string {
	return "automation service account " + automationAccountEmail + " not found"
}

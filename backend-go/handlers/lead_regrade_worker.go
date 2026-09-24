package handlers

// Keeps the qualified book honest.
//
// The rule, agreed 14 Sept 2026: a call qualifies a lead only when the customer says
// they are interested. Migration 248 applied it to 1,809 leads that afternoon, and
// crmStageForCall has applied it to every call since. Neither of those catches a lead
// that arrives at 'qualified' by some other door.
//
// One did. The backfill that joined the two lead books wrote its own note, so migration
// 248 — which matched the single string 'Advanced by a call-centre call' — never tested
// those leads against the rule. By 24 Sept 2026, 48 sat at qualified without one call
// where anybody said they were interested; one had last recorded "Not Interested".
// Migration 298 cleared them and left app.regrade_unqualified_leads() behind so the rule
// is a thing that runs rather than a memory of one afternoon. This worker runs it.
//
// THE TRAP, if this is ever rewritten: the rule asks whether a lead EVER recorded
// answered_interested, never what its most recent call was. Ten leads said yes in
// August, were called again on 23 September and did not pick up. They are real customers
// waiting on Sales, and a last-call rule demotes exactly them. The function is written
// that way deliberately; keep it that way.
//
// Quiet by design. A re-grade writes a stage_regraded event that the activities trigger
// puts on the lead's own timeline, so anyone opening the lead sees why it moved. That is
// the right place for it. A notification every morning saying "0 leads re-graded" would
// train people to ignore the one morning it says 40.

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/o3c/workspace/core"
)

const (
	// Daily is enough: nothing here is time-critical, and the live path already applies
	// the rule to every call as it happens. This is the net under it.
	leadRegradeInterval = 24 * time.Hour

	// Past the startup rush, so a boot does not pay for this.
	leadRegradeBootDelay = 10 * time.Minute
)

// StartLeadRegradeWorker re-applies the qualification rule to leads that reached
// 'qualified' without a call recording that the customer was interested.
func StartLeadRegradeWorker(db *core.DB) {
	run := func() {
		// On the cycle, not the goroutine: a panic here costs one run, not the worker.
		defer recoverPanic("lead_regrade")
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()

		WorkerBeat(ctx, db, "lead_regrade", "running", "", "")
		rows, err := db.PGQuery(ctx, `SELECT count(*)::int AS n FROM app.regrade_unqualified_leads()`)
		if err != nil {
			slog.Error("lead regrade: failed", "err", err)
			WorkerBeat(ctx, db, "lead_regrade", "error", "", err.Error())
			return
		}
		n := int64(0)
		if len(rows) > 0 {
			n = toInt64(rows[0]["n"])
		}
		// Worth a log line at Info only when it actually moved something: a daily "0"
		// in the log is the same noise as a daily notification saying nothing happened.
		if n > 0 {
			slog.Info("lead regrade: leads moved out of qualified", "count", n)
		}
		WorkerBeat(ctx, db, "lead_regrade", "ok", pluralLeadsRegraded(n), "")
	}

	time.Sleep(leadRegradeBootDelay)
	run()
	ticker := time.NewTicker(leadRegradeInterval)
	defer ticker.Stop()
	for range ticker.C {
		run()
	}
}

func pluralLeadsRegraded(n int64) string {
	switch n {
	case 0:
		return "nothing to re-grade"
	case 1:
		return "1 lead re-graded"
	default:
		return fmt.Sprintf("%d leads re-graded", n)
	}
}

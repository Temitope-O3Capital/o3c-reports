package cbssync

// One walk of the Udara call-over report, two captures written from it.
//
// WHY THIS FILE EXISTS. repayments.go and gl_postings.go both read
// /api/Report/v1/GetTransactionCallOverReport, over the same lookback window, with the
// same page size, the same page ceiling and the same ordering assumption — and they did
// it independently, an hour apart, on the same schedule. Measured on 2026-10-19: 7,511
// rows scanned twice an hour, 7-8 minutes per run inside a 15-minute context, against
// the slowest endpoint Udara exposes. Forty-five of roughly sixty sync errors in the
// preceding fortnight were `context deadline exceeded`, and this was the traffic
// producing them. The second walk learned nothing the first had not already fetched.
//
// WHY THE DUPLICATION WAS DEFENSIBLE UNTIL NOW, AND WHAT CHANGED. glWalkWindow carried a
// comment saying it was "duplicated rather than shared because the two files are
// independent capture jobs with independent failure/backfill stories, and sharing a
// helper across them would couple their windowing behaviour by accident". That was a
// real concern and it is answered rather than ignored:
//
//   * The WALK is shared. It is the part that was already identical in both files, to
//     the page size and the guard text, and keeping two copies in step by hand is the
//     accident waiting to happen — not sharing one.
//   * The WRITES stay separate and independently fallible. Each capture classifies the
//     same raw rows its own way and writes through its own path with its own guards:
//     the repayment side keeps guardLegCount and requireRepaymentSchema, the GL side
//     keeps its own idempotency. A failure on one does NOT cost the other, because the
//     rows are already in hand by then — which is strictly better than before, where a
//     failure in the first worker's fetch told the second worker nothing.
//   * The BACKFILL story is untouched. BackfillRepayments walks per-account history, not
//     this window, and is still reachable only through CBS_REPAYMENT_BACKFILL.
//   * SyncRepayments and SyncGLPostings still exist and still work standalone, each
//     doing its own walk. cmd/liveverify calls them that way and should keep being able
//     to. Only the scheduled path is merged.
//
// So the coupling that was feared is the coupling that is avoided: one fetch, two
// independent writers.

import (
	"context"
	"fmt"
	"log/slog"
	"net/url"
	"strconv"
	"time"

	"github.com/o3c/workspace/core"
	"github.com/o3c/workspace/udara"
)

// ledgerWalk is what one pass over the call-over window produced.
type ledgerWalk struct {
	Rows       []map[string]any // rows at or after the cutoff, newest-first
	Pages      int
	Scanned    int
	OldestDate string
	NewestDate string
}

// walkCallOverOnce walks the call-over report newest-first and stops as soon as it is
// past the cutoff. Behaviour is deliberately identical to the two walks it replaces,
// including the guard text, because any difference here would be a silent change to what
// gets captured.
func walkCallOverOnce(ctx context.Context, c *udara.Client, cutoff string) (ledgerWalk, error) {
	var w ledgerWalk
	for page := 1; page <= repaymentMaxPages; page++ {
		q := url.Values{}
		q.Set("PageNumber", strconv.Itoa(page))
		q.Set("PageSize", strconv.Itoa(repaymentPageSize))
		rows, err := fetchCallOver(ctx, c, q)
		if err != nil {
			return w, err
		}
		if page == 1 && len(rows) == 0 {
			// The live ledger is never empty. An empty first page is a failed fetch
			// wearing a 200, which is exactly how the loan book got wiped once (see
			// guardRefresh). Fail the run rather than report a quiet zero.
			return w, fmt.Errorf("%w: call-over page 1 returned 0 rows; "+
				"treating as a failed fetch rather than an empty ledger", errRepaymentGuard)
		}
		if len(rows) == 0 {
			break
		}
		w.Pages++
		w.Scanned += len(rows)

		inWindow := 0
		for _, m := range rows {
			d := gstr(m, "financialDate")
			if d >= cutoff {
				w.Rows = append(w.Rows, m)
				inWindow++
			}
			if d == "" {
				continue
			}
			if w.OldestDate == "" || d < w.OldestDate {
				w.OldestDate = d
			}
			if w.NewestDate == "" || d > w.NewestDate {
				w.NewestDate = d
			}
		}

		// Ordered financialDate DESC: a page with nothing at or after the cutoff means
		// we have walked past the window.
		if inWindow == 0 {
			break
		}
		if len(rows) < repaymentPageSize {
			break // short page = end of ledger
		}
		if page == repaymentMaxPages {
			slog.Warn("cbs ledger capture: hit the page ceiling before reaching the cutoff",
				"max_pages", repaymentMaxPages, "page_size", repaymentPageSize,
				"cutoff", cutoff, "oldest_seen", w.OldestDate)
		}
	}
	return w, nil
}

// SyncLedgerCaptures fetches the window ONCE and runs both captures over it.
//
// The returned error is non-nil only when the shared fetch failed, because that is the
// one failure both captures share. A write failure on either side is returned inside its
// own result's error slot by the caller's logging — the other side still gets written,
// since the rows are already in hand.
func SyncLedgerCaptures(ctx context.Context, c *udara.Client, db *core.DB) (RepaymentResult, GLPostingsResult, error) {
	var rep RepaymentResult
	var gl GLPostingsResult

	if c == nil || !c.IsConfigured() {
		return rep, gl, fmt.Errorf("cbs ledger capture: udara client not configured")
	}
	// Checked before the fetch, not after: if the capture columns are missing there is
	// no point spending eight minutes of Udara's time to discover it.
	if err := requireRepaymentSchema(ctx, db); err != nil {
		return rep, gl, err
	}
	loans, err := loadLoanAccounts(ctx, db)
	if err != nil {
		return rep, gl, err
	}

	cutoff := time.Now().AddDate(0, 0, -lookbackDays()).Format("2006-01-02")
	w, err := walkCallOverOnce(ctx, c, cutoff)
	if err != nil {
		return rep, gl, err
	}

	// Both results report the same walk, because they are the same walk.
	rep.Pages, rep.Scanned, rep.OldestDate, rep.NewestDate = w.Pages, w.Scanned, w.OldestDate, w.NewestDate
	gl.Pages, gl.Scanned, gl.OldestDate, gl.NewestDate = w.Pages, w.Scanned, w.OldestDate, w.NewestDate

	// Independently fallible from here on. The GL side is written first only because it
	// is the simpler of the two; neither order affects the other.
	glRes, glErr := applyGLRows(ctx, db, w.Rows, &gl)
	if glErr != nil {
		slog.Error("cbs ledger capture: GL postings not written (repayment side still attempted)", "err", glErr)
	} else {
		gl = glRes
	}

	repRes, repErr := applyRepaymentRows(ctx, db, w.Rows, cutoff, loans, &rep)
	if repErr != nil {
		slog.Error("cbs ledger capture: repayment legs not written (GL side already attempted)", "err", repErr)
	} else {
		rep = repRes
	}

	// Surface whichever side failed, having attempted both. The fetch — the expensive,
	// shared part — succeeded, so this is not a run to retry wholesale.
	switch {
	case glErr != nil && repErr != nil:
		return rep, gl, fmt.Errorf("both captures failed to write: gl: %v; repayments: %w", glErr, repErr)
	case glErr != nil:
		return rep, gl, fmt.Errorf("gl postings write: %w", glErr)
	case repErr != nil:
		return rep, gl, fmt.Errorf("repayment legs write: %w", repErr)
	}
	return rep, gl, nil
}

// StartLedgerCaptureWorker replaces StartRepaymentWorker and StartGLPostingsWorker with
// a single loop, so the call-over report is fetched once an hour instead of twice.
//
// Both heartbeat keys are still written, so the Worker Hub rows and the migration 375
// freshness sources behave exactly as before and one half failing is still visible on
// its own row.
func StartLedgerCaptureWorker(c *udara.Client, db *core.DB) {
	if c == nil || !c.IsConfigured() {
		slog.Info("CBS ledger capture disabled (Udara360 not configured)")
		return
	}
	interval := repaymentInterval()
	if interval <= 0 {
		slog.Info("CBS ledger capture disabled (CBS_REPAYMENT_INTERVAL <= 0)")
		return
	}

	runOnce := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
		defer cancel()
		repaymentBeat(ctx, db, "running", "", "")
		glPostingsBeat(ctx, db, "running", "", "")

		rep, gl, err := SyncLedgerCaptures(ctx, c, db)

		// Detail lines keep the wording the two workers used, because they are what
		// the Worker Hub shows and what the audit trail reads back. "scanned" is now
		// the shared figure on both rows, which is the point.
		repDetail := fmt.Sprintf("%d legs, %d new, %d already held, %d unmatched; principal %d kobo, interest %d kobo (%s..%s)",
			rep.Legs, rep.Inserted, rep.Duplicate, rep.Unmatched,
			rep.PrincipalKobo, rep.InterestKobo, rep.OldestDate, rep.NewestDate)
		glDetail := fmt.Sprintf("%d scanned, %d new, %d already held (%s..%s)",
			gl.Scanned, gl.Inserted, gl.Duplicate, gl.OldestDate, gl.NewestDate)

		if err != nil {
			slog.Error("CBS ledger capture failed",
				"pages", rep.Pages, "scanned", rep.Scanned, "legs", rep.Legs, "err", err)
			// Both rows carry the error: a shared fetch failure genuinely stopped
			// both captures, and a write failure on one is reported on both so the
			// Hub never shows a confident green beside a failed run.
			repaymentBeat(ctx, db, "error", repDetail, err.Error())
			glPostingsBeat(ctx, db, "error", glDetail, err.Error())
			return
		}

		slog.Info("CBS ledger capture ok",
			"pages", rep.Pages, "scanned", rep.Scanned,
			"legs", rep.Legs, "legs_inserted", rep.Inserted, "legs_duplicate", rep.Duplicate,
			"unmatched", rep.Unmatched, "journal_receipts", rep.JournalReceipts,
			"gl_inserted", gl.Inserted, "gl_duplicate", gl.Duplicate,
			"window", rep.OldestDate+".."+rep.NewestDate)
		repaymentBeat(ctx, db, "ok", repDetail, "")
		glPostingsBeat(ctx, db, "ok", glDetail, "")
	}

	// Let the server settle, and let the CBS book sync land first — the repayment side
	// resolves loan accounts against cbs_loans, which StartCBSSyncWorker fills 30s
	// after boot. This is the repayment worker's old 90s delay; the GL worker's 150s
	// delay existed only to avoid racing the repayment worker on the same endpoint,
	// which is no longer a thing that can happen.
	time.Sleep(90 * time.Second)

	if envBool("CBS_REPAYMENT_BACKFILL") {
		slog.Warn("CBS repayment BACKFILL requested by CBS_REPAYMENT_BACKFILL=1 — " +
			"walking the full per-account history once before the hourly window takes over")
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
		repaymentBeat(ctx, db, "running", "", "")
		res, err := BackfillRepayments(ctx, c, db)
		if err != nil {
			slog.Error("CBS repayment backfill failed", "err", err)
			repaymentBeat(ctx, db, "error", "", err.Error())
		} else {
			repaymentBeat(ctx, db, "ok", fmt.Sprintf("backfill: %d legs, %d new, %d already held",
				res.Legs, res.Inserted, res.Duplicate), "")
		}
		cancel()
	}

	runOnce()

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for range ticker.C {
		runOnce()
	}
}

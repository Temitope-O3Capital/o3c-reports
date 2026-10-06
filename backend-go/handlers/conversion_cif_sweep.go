package handlers

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/o3c/workspace/core"
)

const (
	// Boot delay keeps startup quiet; the interval is hourly because the thing it waits
	// for — a CIF appearing in the customer book — arrives in batches, not continuously.
	conversionCIFSweepBootDelay = 4 * time.Minute
	conversionCIFSweepInterval  = time.Hour
)

// StartConversionCIFSweep re-tries the conversions that could not name a customer yet.
//
// WHY A SWEEP AND NOT JUST THE ONE-SHOT MATCH. ccStampConversionCIF runs at the moment a
// call is logged, and that is the wrong moment to insist on an answer, because the customer
// book does not arrive continuously — it lands in BATCHES. Measured 2026-10-06:
// app.customers gained no CIFs at all between 2026-09-08 and 2026-09-13, then 309 on the
// 14th and 296 on the 15th. An agent converting someone on the 10th had nothing to match
// against; the CIF existed four days later and nothing would ever have looked again.
//
// It happens not to have bitten the six conversions on the book — every one of their CIFs
// already existed on the day of the call, checked one by one. That is luck, not design: the
// window where it would bite is six days wide and recent.
//
// So the match is tried once when the conversion is recorded, and again every hour for as
// long as it stays unverified. An unverified conversion then clears itself the moment the
// card is issued, and the two that remain are the two that genuinely have no customer
// behind them.
//
// WHAT IT DELIBERATELY DOES NOT DO. It never clears a flag by guessing. The rule is
// ccResolveCustomerCIF's — exactly one match on a 10-digit number — because the customer
// book carries 8,739 people on shared numbers, 4,113 of them on 8012345678 alone. A sweep
// that resolved ambiguously would silently attach thousands of conversions to the wrong
// person, and it would do it unattended, which is worse than leaving the flag up.
//
// Name matching was tested and rejected rather than assumed: the card book stores
// two-token names ("BANJI OJO") where the leads carry three ("Banji Oyewole Ojo"), so an
// exact full-name rule resolved 1 of 8 — and that one was already found by phone. A looser
// rule would have to match on surname alone, against a book holding "OWOLABI TAIWO" twice.
func StartConversionCIFSweep(db *core.DB) {
	run := func() {
		// On the cycle, not the goroutine: a panic costs one run, not the worker.
		defer recoverPanic("conversion_cif_sweep")
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()

		WorkerBeat(ctx, db, "conversion_cif_sweep", "running", "", "")
		rows, err := db.PGQuery(ctx, `
			SELECT id, customer_name, customer_phone,
			       GREATEST(0, EXTRACT(epoch FROM (NOW() - COALESCE(updated_at, created_at)))/86400)::int AS age_days
			  FROM app.call_center_leads
			 WHERE status = 'converted'
			   AND COALESCE(btrim(customer_cif), '') = ''
			 ORDER BY id`)
		if err != nil {
			slog.Error("conversion cif sweep: load unverified", "err", err)
			WorkerBeat(ctx, db, "conversion_cif_sweep", "error", "", err.Error())
			return
		}
		if len(rows) == 0 {
			WorkerBeat(ctx, db, "conversion_cif_sweep", "ok",
				"every conversion names its customer", "")
			return
		}

		matched, stale := 0, 0
		names := make([]string, 0, len(rows))
		for _, r := range rows {
			leadID := toInt64(r["id"])
			if cif, ok := ccResolveCustomerCIF(ctx, db, str(r["customer_phone"])); ok {
				ccStampConversionCIF(ctx, db, leadID, str(r["customer_phone"]), "conversion_cif_sweep")
				slog.Info("unverified conversion resolved by sweep",
					"lead", leadID, "cif", cif)
				matched++
				continue
			}
			// Still nothing. Named in the heartbeat so the backlog is legible without
			// opening the page, and counted as stale past a fortnight — by then the card
			// would have been issued if it were coming, and the question belongs with the
			// agent who logged it rather than with the matcher.
			if toInt64(r["age_days"]) >= 14 {
				stale++
			}
			names = append(names, str(r["customer_name"]))
		}

		detail := fmt.Sprintf("%d resolved, %d still unverified", matched, len(names))
		if stale > 0 {
			detail += fmt.Sprintf(" (%d older than a fortnight — ask the agent who logged it)", stale)
		}
		if len(names) > 0 && len(names) <= 6 {
			detail += ": " + strings.Join(names, ", ")
		}
		// 'ok' and not 'error'. An unverified conversion is a real state an agent can
		// legitimately produce — converting someone whose card is not issued yet — and a
		// worker that cries error while behaving correctly is one people stop reading.
		WorkerBeat(ctx, db, "conversion_cif_sweep", "ok", detail, "")
		if matched > 0 {
			slog.Info("conversion cif sweep", "resolved", matched, "still_unverified", len(names))
		}
	}

	time.Sleep(conversionCIFSweepBootDelay)
	run()
	ticker := time.NewTicker(conversionCIFSweepInterval)
	defer ticker.Stop()
	for range ticker.C {
		run()
	}
}

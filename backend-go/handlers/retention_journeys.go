package handlers

// Retention journeys — the event-driven half of the build.
//
// WHY EVENTS AND NOT A BEHAVIOUR SCORE. The obvious retention engine watches a
// customer go quiet and intervenes. This database cannot support that yet: the
// transaction ledger is card-only, covers ~37% of parties, and has two near-empty
// months inside the last twelve (2025-11 and 2025-12 hold 3 rows each, 2026-05 holds
// 7, against ~4,500 in a normal month). Any frequency or trend model reads those gaps
// as mass churn, and a message that tells an active customer we have missed them is
// worse than no message.
//
// A deposit maturing and a loan being repaid are different in kind: hard, dated
// facts, carried on rows we actually hold, with a real moment attached. So the
// journeys ride those, and the behavioural half waits for the feed repairs.
//
// Nothing here sends anything unless CUSTOMER_MESSAGING_MODE says so — see
// customer_dispatch.go. Default is off.

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/o3c/workspace/core"
)

const journeyWorkerKey = "retention_journeys"

// StartRetentionJourneyWorker runs daily at 09:00 — inside business hours, so a
// customer who replies or calls back reaches a staffed floor rather than a voicemail.
func StartRetentionJourneyWorker(db *core.DB) {
	now := time.Now()
	next := time.Date(now.Year(), now.Month(), now.Day(), 9, 0, 0, 0, now.Location())
	if now.After(next) {
		next = next.Add(24 * time.Hour)
	}
	time.Sleep(next.Sub(now))
	for {
		runRetentionJourneys(db)
		time.Sleep(24 * time.Hour)
	}
}

func runRetentionJourneys(db *core.DB) {
	defer recoverPanic(journeyWorkerKey)
	ctx := context.Background()

	mode := customerSendMode()
	if mode == modeOff {
		// 'idle', not 'ok': the worker ran and did nothing because it is not armed.
		// 'ok' here would show green "Healthy" forever while no customer was ever
		// contacted, which is exactly how the Graph pollers hid being unconfigured.
		WorkerBeat(ctx, db, journeyWorkerKey, "idle", describeSendMode(), "")
		return
	}
	WorkerBeat(ctx, db, journeyWorkerKey, "running", "", "")

	var sent, suppressed, previewed int
	for _, r := range []struct {
		name string
		run  func(context.Context, *core.DB) (int, int, int)
	}{
		{"fd_maturity", journeyFDMaturity},
		{"loan_repaid", journeyLoanRepaid},
	} {
		s, sup, p := r.run(ctx, db)
		sent, suppressed, previewed = sent+s, suppressed+sup, previewed+p
		slog.Info("retention journey ran", "journey", r.name, "sent", s, "suppressed", sup, "preview", p)
	}

	detail := fmt.Sprintf("%s · %d sent, %d previewed, %d suppressed",
		describeSendMode(), sent, previewed, suppressed)
	WorkerBeat(ctx, db, journeyWorkerKey, "ok", detail, "")
}

// tally folds one SendToCustomer result into the counters.
func tally(state string, sent, suppressed, previewed *int) {
	switch {
	case state == "sent":
		*sent++
	case state == "preview":
		*previewed++
	default:
		*suppressed++
	}
}

// journeyFDMaturity reaches a depositor before their money comes free.
//
// THE ROLLOVER SUPPRESSION IS THE WHOLE TRICK. Udara leaves rolloverCount empty on
// all 385 deposits and zeroes the principal on every closed one, so the core banking
// system cannot tell us whether a maturing deposit is being rolled. Migration 276
// derives it instead, and without that this journey would tell a customer their
// deposit is maturing when they have already rolled it — and ~27% of the book is
// money rolling. That was decision 5 of the five agreed on 2026-09-15: do not
// auto-roll, and suppress the nudge once a deposit has rolled.
func journeyFDMaturity(ctx context.Context, db *core.DB) (sent, suppressed, previewed int) {
	for _, step := range []struct {
		days    int
		journey string
	}{
		{14, "fd_maturity_t14"},
		{3, "fd_maturity_t3"},
		{0, "fd_maturity_t0"},
	} {
		rows, err := db.PGQuery(ctx, `
			SELECT l.entity_id                          AS party_id,
			       COALESCE(p.full_name,'')             AS name,
			       COALESCE(NULLIF(c.phone,''), p.primary_phone) AS phone,
			       f.principal_kobo, f.maturity_date,
			       COALESCE(NULLIF(c.cif,''),'')        AS cif
			  FROM app.cbs_fixed_deposits f
			  JOIN app.cbs_links l ON l.cbs_customer_id = f.cbs_customer_id
			                      AND l.entity_type = 'party'
			  JOIN app.parties  p ON p.party_id = l.entity_id
			  LEFT JOIN app.customers c ON c.party_id = l.entity_id
			 WHERE f.status = 'Active'
			   AND f.maturity_date::date = CURRENT_DATE + $1::int
			   -- Already rolled: the money is staying, so there is nothing to say.
			   AND NOT EXISTS (SELECT 1 FROM app.fd_rollover_links x
			                    WHERE x.prior_account = f.cbs_account_number)
			   AND length(app.norm_phone(COALESCE(NULLIF(c.phone,''), p.primary_phone))) = 10`,
			step.days)
		if err != nil {
			slog.Error("journeyFDMaturity", "step", step.journey, "err", err)
			continue
		}
		for _, r := range rows {
			when := "on " + toDateStr(r["maturity_date"])
			switch step.days {
			case 0:
				when = "today"
			case 3:
				when = "in 3 days"
			case 14:
				when = "in 2 weeks"
			}
			// GSM-7 only. "NGN" rather than the naira sign, a plain hyphen rather
			// than an em-dash: one character outside the alphabet forces the whole
			// message to UCS-2 and triples the bill across a whole run.
			body := customerSMSSafe(fmt.Sprintf(
				"O3 Capital: Hello %s, your fixed deposit of %s matures %s. "+
					"To roll it over or discuss your options, call us on 0201-330-5300. Reply STOP to opt out.",
				firstName(str(r["name"])), formatKoboShort(toInt64(r["principal_kobo"])), when))

			tally(SendToCustomer(ctx, db, CustomerMessage{
				PartyID: toInt64(r["party_id"]),
				CIF:     str(r["cif"]),
				Channel: "sms",
				// Servicing: this is about a product they hold, which is the
				// legitimate-interest basis. It is NOT marketing.
				Purpose: "servicing",
				Journey: step.journey,
				To:      str(r["phone"]),
				Body:    body,
			}), &sent, &suppressed, &previewed)
		}
	}
	return
}

// journeyLoanRepaid approaches a borrower who has finished paying and has not come
// back. The highest-intent moment a lender gets: they have just proved they repay,
// and they no longer have the facility.
//
// Near-dormant today, by design rather than by accident: the loan book began on
// 2026-02-09, 41 of 44 borrowers still have an open loan, and only 3 have fully
// repaid. The journey exists so the moment is not missed as the book matures.
func journeyLoanRepaid(ctx context.Context, db *core.DB) (sent, suppressed, previewed int) {
	rows, err := db.PGQuery(ctx, `
		SELECT l.entity_id AS party_id,
		       COALESCE(p.full_name,'')                      AS name,
		       COALESCE(NULLIF(c.phone,''), p.primary_phone)  AS phone,
		       COALESCE(NULLIF(c.cif,''),'')                  AS cif
		  FROM app.cbs_loans ln
		  JOIN app.cbs_links l ON l.cbs_customer_id = ln.cbs_customer_id
		                      AND l.entity_type = 'party'
		  JOIN app.parties  p ON p.party_id = l.entity_id
		  LEFT JOIN app.customers c ON c.party_id = l.entity_id
		 WHERE ln.status = 'Closed'
		   -- Closed in the last week: a fresh event, not a backlog sweep. Without
		   -- this the first run would message every borrower who ever repaid.
		   AND ln.maturity_date::date BETWEEN CURRENT_DATE - 7 AND CURRENT_DATE
		   -- Nothing open anywhere, or this is a customer we are still lending to.
		   AND NOT EXISTS (SELECT 1 FROM app.cbs_loans o
		                    WHERE o.cbs_customer_id = ln.cbs_customer_id
		                      AND o.status <> 'Closed')
		   -- A restructure is not a repayment (migration 277).
		   AND NOT EXISTS (SELECT 1 FROM app.loan_restructure_links x
		                    WHERE x.prior_account = ln.cbs_account_number)
		   AND length(app.norm_phone(COALESCE(NULLIF(c.phone,''), p.primary_phone))) = 10`)
	if err != nil {
		slog.Error("journeyLoanRepaid", "err", err)
		return
	}
	for _, r := range rows {
		body := customerSMSSafe(fmt.Sprintf(
			"O3 Capital: Congratulations %s, your loan is fully repaid. "+
				"Thank you for banking with us. If you need another facility, call 0201-330-5300. Reply STOP to opt out.",
			firstName(str(r["name"]))))

		tally(SendToCustomer(ctx, db, CustomerMessage{
			PartyID: toInt64(r["party_id"]),
			CIF:     str(r["cif"]),
			Channel: "sms",
			// Congratulating someone on their own loan is servicing; the offer of
			// another facility is the part that would need marketing consent, so it
			// is phrased as a number to call rather than an offer pushed at them.
			Purpose: "servicing",
			Journey: "loan_repaid",
			To:      str(r["phone"]),
			Body:    body,
		}), &sent, &suppressed, &previewed)
	}
	return
}

// firstName keeps an SMS short and personal without guessing at titles.
func firstName(full string) string {
	for i, r := range full {
		if r == ' ' {
			return full[:i]
		}
	}
	if full == "" {
		return "there"
	}
	return full
}

func toDateStr(v any) string {
	if t, ok := v.(time.Time); ok {
		return t.Format("2 January")
	}
	return str(v)
}

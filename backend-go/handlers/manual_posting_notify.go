package handlers

import (
	"context"
	"fmt"

	"github.com/o3c/workspace/core"
)

// ─────────────────────────────────────────────────────────────────────────────
// Manual postings — the maker-checker chain that told nobody anything.
//
// settlements_ops.go carries a four-step money flow: raise → approve → post to the
// ledger → return, with the maker-checker control enforced in the WHERE clause so a
// person cannot approve their own entry. It is careful code. It also contained no
// notification of any kind, and the three event constants written for it
// (manual_posting_submitted / _approved / _rejected) had been declared in notify.go
// and never once used — the surest sign the wiring was simply forgotten.
//
// The consequence is the one every unannounced approval queue has: an entry waits for a
// second pair of eyes that nobody knows is needed, and the person who raised it finds
// out it was returned by going to look. The approvals page is real but it is a place
// you must remember to visit.
//
// WHO HEARS WHAT. Approvers hear that something is waiting; the initiator hears what
// happened to theirs. Nobody hears about their own action. The pending alert is grouped
// so a batch of corrections on a bad settlement day is one digest, while the outcome
// alerts are per-entry and ungrouped — "your ₦2.4m correction was returned" is specific,
// actionable, and rare enough to be worth an email every time.
// ─────────────────────────────────────────────────────────────────────────────

// manualPostingApproverRoles are the people who can give the second pair of eyes.
var manualPostingApproverRoles = []string{"finance_head", "settlement_head", "cfo"}

type manualPostingFacts struct {
	Ref         string
	AmountKobo  int64
	Narrative   string
	InitiatedBy int64
}

func manualPostingFactsFor(ctx context.Context, db *core.DB, id any) (manualPostingFacts, bool) {
	rows, err := db.PGQuery(ctx, `
		SELECT 'MP-' || LPAD(id::text, 5, '0') AS ref,
		       amount_kobo,
		       COALESCE(narrative, '')      AS narrative,
		       COALESCE(initiated_by, 0)    AS initiated_by
		  FROM manual_postings WHERE id = $1`, id)
	if err != nil || len(rows) == 0 {
		return manualPostingFacts{}, false
	}
	return manualPostingFacts{
		Ref:         str(rows[0]["ref"]),
		AmountKobo:  toInt64(rows[0]["amount_kobo"]),
		Narrative:   str(rows[0]["narrative"]),
		InitiatedBy: toInt64(rows[0]["initiated_by"]),
	}, true
}

// notifyManualPostingRaised tells the approvers an entry is waiting. Grouped per day:
// a bad settlement day produces a run of corrections, and one digest that keeps
// counting is read where twenty separate pings are not.
func notifyManualPostingRaised(ctx context.Context, db *core.DB, id any, raisedBy string) {
	f, ok := manualPostingFactsFor(ctx, db, id)
	if !ok {
		return
	}
	NotifyRoles(ctx, db, manualPostingApproverRoles, NotifPayload{
		EventType: EvtManualPostingSubmitted,
		Title:     "A Manual Posting Needs Approval",
		Body: fmt.Sprintf("%s · %s · %s. Raised by %s, and it cannot be approved by them.",
			f.Ref, fmtKoboGo(f.AmountKobo), f.Narrative, raisedBy),
		ActionURL: "/settlements/manual-postings",
		EntityRef: fmt.Sprintf("manual_posting:%v", id),
		GroupKey:  "finance:postings:pending:" + nowDateKey(ctx, db),
		Priority:  "high",
	})
}

// notifyManualPostingDecided tells whoever raised it what happened. Ungrouped: this is
// one person, one entry, one outcome they are waiting on.
func notifyManualPostingDecided(ctx context.Context, db *core.DB, id any, outcome, by, reason string) {
	f, ok := manualPostingFactsFor(ctx, db, id)
	if !ok || f.InitiatedBy == 0 {
		return
	}
	var evt, title, body string
	switch outcome {
	case "approved":
		evt, title = EvtManualPostingApproved, "Your Manual Posting Was Approved"
		body = fmt.Sprintf("%s · %s was approved by %s. It reaches the ledger when it is posted.",
			f.Ref, fmtKoboGo(f.AmountKobo), by)
	case "posted":
		evt, title = EvtManualPostingApproved, "Your Manual Posting Reached the Ledger"
		body = fmt.Sprintf("%s · %s has been posted by %s.", f.Ref, fmtKoboGo(f.AmountKobo), by)
	default: // rejected | returned
		evt, title = EvtManualPostingRejected, "Your Manual Posting Was "+
			map[string]string{"returned": "Returned", "rejected": "Rejected"}[outcome]
		body = fmt.Sprintf("%s · %s was %s by %s.", f.Ref, fmtKoboGo(f.AmountKobo), outcome, by)
		if reason != "" {
			body += " Reason: " + reason
		}
	}
	Notify(ctx, db, NotifPayload{
		EventType: evt,
		UserID:    f.InitiatedBy,
		Title:     title,
		Body:      body,
		ActionURL: "/settlements/manual-postings",
		EntityRef: fmt.Sprintf("manual_posting:%v", id),
		Priority:  "high",
	})
}

// fmtKoboGo renders kobo as whole naira for a notification body.
//
// Whole naira deliberately: a notification is a summons, not a reconciliation, and
// "2,400,000" is read at a glance where "2,400,000.00" is not. The exact figure to the
// kobo is on the posting itself, which is where it has to tie out.
//
// "NGN" and not the naira sign, because a notification can be delivered by SMS and ₦ is
// outside GSM-7: one of them re-encodes the entire message to UCS-2 and halves the
// characters that fit, which silently truncates the narrative.
func fmtKoboGo(kobo int64) string {
	naira := kobo / 100
	if kobo%100 >= 50 {
		naira++
	}
	s := fmt.Sprintf("%d", naira)
	neg := ""
	if naira < 0 {
		neg, s = "-", s[1:]
	}
	out := ""
	for i, c := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			out += ","
		}
		out += string(c)
	}
	return neg + "NGN " + out
}

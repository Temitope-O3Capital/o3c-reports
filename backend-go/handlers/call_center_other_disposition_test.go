package handlers

import "testing"

// ccDispositionCode is the single writer-side normaliser: every disposition an agent
// picks passes through it before it reaches the contact, the lead, and every report.
// It is a top-to-bottom switch of substring tests, so adding a case can silently
// capture a label that used to fall through to a later one — the failure is not a
// build error, it is a call recorded as the wrong outcome.
//
// These tests pin the whole vocabulary rather than only the new entries, because the
// entries added on 2026-09-28 were inserted ABOVE existing cases.

// Every label the manual Call Log form (LogCallModal.tsx DISPOSITIONS_BY_PURPOSE)
// can submit must resolve to a real disposition.
//
// Eight of these used to resolve to nothing: ccDispositionCode returned the fallback
// "other", ccDispositionByCode found no such code, and helpdesk.go's applyQueueContact
// returned without touching the contact. A lead marked Converted kept being dialled;
// a collections account marked Paid kept being chased. The assertion is therefore not
// just "maps to something" but "maps to the outcome that label means".
func TestEveryCallLogLabelResolvesToItsOwnOutcome(t *testing.T) {
	want := map[string]string{
		// Support
		"Issue Resolved":       "resolved",
		"Closed":               "closed",
		"Information Provided": "info_provided",
		"Escalated":            "escalated",
		"Complaint Logged":     "complaint_logged",
		"Callback Scheduled":   "callback",
		"Pending / Follow-up":  "pending_followup",
		// Marketing / sales
		"Interested":     "answered_interested",
		"Not Ready Yet":  "not_ready",
		"Not Eligible":   "not_eligible",
		"Not Interested": "answered_not_interested",
		"Converted":      "converted",
		"Wrong Number":   "wrong_number",
		"Do Not Call":    "do_not_call",
		// Collections
		"Promise to Pay": "ptp",
		"Paid":           "paid",
		"Dispute":        "dispute",
		// Universal
		"Unreachable / No Answer": "no_answer",
		"Call Dropped":            "call_dropped",
	}
	for label, code := range want {
		got := ccDispositionCode(label)
		if got != code {
			t.Errorf("ccDispositionCode(%q) = %q, want %q", label, got, code)
		}
		// Resolving to a code is only half of it — applyQueueContact looks the code up
		// again, and a code with no entry is the silent no-op this test exists to stop.
		if _, ok := ccDispositionByCode(got); !ok {
			t.Errorf("ccDispositionCode(%q) = %q, which ccDispositionByCode cannot resolve — "+
				"the contact will never be updated", label, got)
		}
	}
}

// The four outcomes added because agents were filing them under "Not Interested",
// which closes a contact. Each must resolve, and the two that are NOT a loss must
// leave the contact workable.
func TestRescuedOutcomesResolveAndOnlyTheLossesClose(t *testing.T) {
	for _, tc := range []struct {
		label, code, status string
	}{
		{"Information Sent — Awaiting Reply", "info_sent", ""},
		{"Rate or Charges Too High", "price_objection", "closed"},
		{"Wants a Product We Do Not Offer", "wrong_product", "closed"},
		{"Customer Rejected the Call", "call_rejected", ""},
	} {
		got := ccDispositionCode(tc.label)
		if got != tc.code {
			t.Fatalf("ccDispositionCode(%q) = %q, want %q", tc.label, got, tc.code)
		}
		d, ok := ccDispositionByCode(got)
		if !ok {
			t.Fatalf("%q resolved to %q but there is no such disposition", tc.label, got)
		}
		if d.Status != tc.status {
			t.Errorf("%s status = %q, want %q", tc.code, d.Status, tc.status)
		}
	}
}

// "Other" exists to stop agents forcing a call into a destructive option. It would
// defeat itself if it were destructive, so: no status move, no DNC, no callback.
func TestOtherIsAlwaysSafeToPick(t *testing.T) {
	d, ok := ccDispositionByCode("other")
	if !ok {
		t.Fatal("there is no 'other' disposition")
	}
	if d.Status != "" {
		t.Errorf("Other moves the contact to %q — it must never close or invalidate one", d.Status)
	}
	if d.AddToDNC {
		t.Error("Other suppresses the number — an escape hatch must not be a DNC")
	}
	if d.NeedsCallback {
		t.Error("Other demands a callback time — it should ask for prose, not a date")
	}
	if !d.NeedsNote {
		t.Error("Other does not require a note, which is the only thing that stops it " +
			"becoming the fastest answer on the form")
	}
}

// It must also sort last, so it is what an agent reaches for having read the rest —
// not the first thing their eye lands on.
func TestOtherSortsLastInEveryPurpose(t *testing.T) {
	for _, purpose := range []string{"", "marketing", "sales", "collections", "support", "retention"} {
		list := ccDispositionsForPurpose(purpose)
		if len(list) == 0 {
			t.Errorf("purpose %q offers no dispositions at all", purpose)
			continue
		}
		seen := false
		for i, d := range list {
			if d.Code != "other" {
				continue
			}
			seen = true
			if i != len(list)-1 {
				t.Errorf("purpose %q puts Other at position %d of %d — it must be last",
					purpose, i+1, len(list))
			}
		}
		if !seen {
			t.Errorf("purpose %q offers no Other, so an unanticipated outcome has "+
				"nowhere to go but a wrong option", purpose)
		}
	}
}

// The note requirement has to hold on the server, because the browser is not the only
// client and a required field is exactly what a hurried agent works around.
func TestOtherRequiresRealProseNotAPlaceholder(t *testing.T) {
	// Defeats of a mandatory field that must NOT pass.
	for _, junk := range []string{"", " ", ".", "-", "n/a", "N/A", "ok", "none", "xx"} {
		if !ccDispositionNoteMissing("Other — Describe What Happened", junk) {
			t.Errorf("note %q was accepted as an explanation for Other", junk)
		}
	}
	// A genuine one-line account must pass.
	for _, real := range []string{
		"Customer has died, brother asked us to stop calling",
		"Number now belongs to his former employer's front desk",
	} {
		if ccDispositionNoteMissing("Other — Describe What Happened", real) {
			t.Errorf("genuine explanation %q was rejected", real)
		}
	}
	// The explanation may arrive in any of the write-up fields.
	if ccDispositionNoteMissing("Other — Describe What Happened", "", "He is in prison until next year") {
		t.Error("an explanation in the second field should satisfy the requirement")
	}
	// And no other disposition may demand one.
	for _, d := range ccDispositions {
		if d.Code == "other" {
			continue
		}
		if ccDispositionNoteMissing(d.Label) {
			t.Errorf("%s demands a note; only Other should", d.Code)
		}
	}
}

// Guards the substring ordering directly. Each of these pairs shares a word, and the
// switch resolves them by the order its cases appear — the kind of thing that breaks
// when somebody adds a case in the obvious place.
func TestSimilarLabelsDoNotCaptureEachOther(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		// Both contain "information", and they mean opposite things about whether the
		// contact is finished.
		{"Information Provided", "info_provided"},
		{"Information Sent — Awaiting Reply", "info_sent"},
		// "Issue Resolved" must reach the support close.
		{"Issue Resolved", "resolved"},
		// The bare word "resolved" matches the support disposition's LABEL in
		// ccDispositionByCode before the switch runs, so it resolves to "resolved" and
		// never reaches the `l == "resolved"` case that would make it "connected".
		// Pre-existing, and harmless: isRawCallOutcome rejects the bare word at the log
		// path before it ever gets here. Pinned so the precedence is not "fixed" by
		// accident — ccDispositionCode's own doc comment used to claim otherwise.
		{"resolved", "resolved"},
		// "Closed" is a generic close; "Callback Scheduled" must still be a callback.
		{"Closed", "closed"},
		{"Callback Scheduled", "callback"},
		// "Paid" must not be captured by "Promise to Pay", nor the reverse.
		{"Paid", "paid"},
		{"Promise to Pay", "ptp"},
		// The pre-existing pair this switch has always depended on.
		{"Not Interested", "answered_not_interested"},
		{"Interested", "answered_interested"},
		// A win-back label that contains "interested" and must keep its own code.
		{"Interested in a New Offer", "winback_wants_offer"},
		// Anything genuinely unrecognised still groups rather than inventing a code.
		{"had a chat about the weather", "other"},
	} {
		if got := ccDispositionCode(tc.in); got != tc.want {
			t.Errorf("ccDispositionCode(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// A rejected call is a live number and a reachable person, so it must not be counted
// as a connect — nobody spoke — and must not close the contact.
func TestRejectedCallIsNotAConnectAndNotALoss(t *testing.T) {
	d, ok := ccDispositionByCode("call_rejected")
	if !ok {
		t.Fatal("no call_rejected disposition")
	}
	if d.Connected {
		t.Error("a rejected call counted as a connect — nobody spoke")
	}
	if out := ccCallOutcome(d); out != "no_answer" {
		t.Errorf("ccCallOutcome(call_rejected) = %q, want no_answer", out)
	}
	if d.Status != "" {
		t.Errorf("a rejected call moved the contact to %q — the number is live and the "+
			"person is reachable, so it stays workable", d.Status)
	}
}

package handlers

import (
	"strings"
	"testing"
	"time"
)

// parseLeadFollowUp carries the follow-up date that the Sales module used to lose.
// The old My Dashboard dialog collected one and posted it to /api/crm/activities,
// an endpoint gated on the crm_* pages that no sales officer holds — so every save was
// refused with a 403 and crm_activities stayed on 0 rows. Unifying the dialogs was only
// lossless because this accepts the date on the sales endpoint instead.

func TestFollowUpBareDateLandsAtFivePMLocal(t *testing.T) {
	d := time.Now().AddDate(0, 0, 3).Format("2006-01-02")
	got, msg := parseLeadFollowUp(d)
	if msg != "" {
		t.Fatalf("a plain date three days out should be accepted, got %q", msg)
	}
	ts, ok := got.(time.Time)
	if !ok {
		t.Fatalf("expected a time.Time, got %T", got)
	}
	// 17:00 local, not midnight: a follow-up stored at midnight is overdue the moment
	// it is saved, and a UTC midnight reads as the previous day west of UTC.
	if ts.Hour() != 17 {
		t.Errorf("a bare date should land at 17:00 local so it is not born overdue; got %02d:00", ts.Hour())
	}
	if ts.Location() != time.Local {
		t.Errorf("the date an officer types is local, not UTC; got %v", ts.Location())
	}
}

func TestFollowUpEmptyMeansLeaveItAlone(t *testing.T) {
	// nil is what makes COALESCE($2, next_action_at) a no-op. Logging a call must not
	// silently clear a callback someone already booked.
	for _, in := range []string{"", "   "} {
		got, msg := parseLeadFollowUp(in)
		if msg != "" {
			t.Errorf("%q should be accepted as 'no follow-up', got %q", in, msg)
		}
		if got != nil {
			t.Errorf("%q must yield nil so the existing date survives; got %v", in, got)
		}
	}
}

func TestFollowUpTodayIsAllowed(t *testing.T) {
	// "Call them back this afternoon", set at 09:00, is a real thing to want.
	if _, msg := parseLeadFollowUp(time.Now().Format("2006-01-02")); msg != "" {
		t.Errorf("today must be allowed, got %q", msg)
	}
}

func TestFollowUpRejectsThePast(t *testing.T) {
	old := time.Now().AddDate(0, 0, -30).Format("2006-01-02")
	got, msg := parseLeadFollowUp(old)
	if msg == "" {
		t.Fatal("a date a month ago is a typo, not a plan")
	}
	if got != nil {
		t.Error("a rejected value must not also be returned")
	}
}

func TestFollowUpRejectsAMistypedYear(t *testing.T) {
	// The failure this guards: a year typed wrong parks the follow-up where nobody
	// will ever see it, and the lead silently stops appearing as due.
	far := time.Now().AddDate(3, 0, 0).Format("2006-01-02")
	if _, msg := parseLeadFollowUp(far); msg == "" {
		t.Error("three years out should be refused as a likely mistyped year")
	}
}

func TestFollowUpAcceptsRFC3339(t *testing.T) {
	ts := time.Now().Add(48 * time.Hour).Format(time.RFC3339)
	if _, msg := parseLeadFollowUp(ts); msg != "" {
		t.Errorf("a full timestamp should be accepted, got %q", msg)
	}
}

func TestFollowUpRejectsNonsenseWithAReadableMessage(t *testing.T) {
	got, msg := parseLeadFollowUp("next tuesday")
	if msg == "" {
		t.Fatal("unparseable input must be refused")
	}
	if got != nil {
		t.Error("a rejected value must not also be returned")
	}
	// The message goes straight to the agent, so it has to say what to type.
	if !strings.Contains(msg, "2026-10-03") {
		t.Errorf("the error should show the expected shape; got %q", msg)
	}
}

// Every kind the unified dialog can send must be one the server knows. The dialog is
// the only caller now, so a rename on either side breaks silently otherwise — and the
// two copies of this list that used to exist in the frontend had already drifted on
// whether 'other' was valid (it is not).
func TestEveryKindTheSalesDialogSendsIsAccepted(t *testing.T) {
	sentByDialog := []string{
		// The journey rail.
		"interested", "handed_to_sales", "documents_requested",
		"application_submitted", "approved",
		// The record-only chips.
		"call", "meeting", "email", "note",
	}
	for _, k := range sentByDialog {
		if _, ok := leadActivityLabel[k]; !ok {
			t.Errorf("the Sales dialog offers %q but the server rejects it", k)
		}
	}
	if _, ok := leadActivityLabel["other"]; ok {
		t.Error("'other' is not a kind the server accepts; the dialog must not offer it")
	}
	// Only the five journey kinds may move a lead.
	for _, k := range []string{"call", "meeting", "email", "note"} {
		if _, moves := leadActivityStage[k]; moves {
			t.Errorf("%q is a record-only kind and must never move the stage", k)
		}
	}
}

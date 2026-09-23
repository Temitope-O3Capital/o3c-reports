package handlers

import (
	"strings"
	"testing"
)

// The win-back disposition set is the only place a churn REASON will ever be
// captured: a schema-wide search on 2026-09-23 found no closure-reason field
// anywhere, and of 6,539 churned customers we can explain 347 (5.3%) — only because
// they defaulted. These tests pin the mapping, because two of the labels contain
// words the generic matcher in leadStatusFromCall keys on and would silently
// mis-route.

func TestWinbackDispositionsMapCorrectly(t *testing.T) {
	for _, c := range []struct{ label, want string }{
		// The win: they are coming back. Must be terminal so a later no-answer
		// cannot knock it out of the converted count.
		{"Reactivating — Will Use Again", "converted"},
		// Warm: hand to Sales. Rides the existing 'interested' branch.
		{"Interested in a New Offer", "interested"},
		// Reasons for leaving. All close the contact; what matters is the record.
		{"Left Over Charges or Rates", "closed"},
		{"Left Over Service or an Unresolved Issue", "closed"},
		{"Using Another Provider", "closed"},
		{"No Longer Needs the Product", "closed"},
		// A refusal to return is a refusal.
		{"Not Interested in Returning", "called"},
	} {
		if got := leadStatusFromCall("", &c.label); got != c.want {
			t.Errorf("leadStatusFromCall(%q) = %q, want %q", c.label, got, c.want)
		}
	}
}

// The two traps that made explicit handling necessary. If someone reorders the
// switch in leadStatusFromCall, these fail before a customer is mislabelled.
func TestWinbackLabelsAreNotCaughtByTheGenericMatcher(t *testing.T) {
	// "Unresolved" contains "resolved", which maps to a SUPPORT resolution.
	// The outcome is the same word but the meaning is the opposite: this customer
	// left BECAUSE the issue was never resolved.
	unresolved := "Left Over Service or an Unresolved Issue"
	if !strings.Contains(strings.ToLower(unresolved), "resolved") {
		t.Fatal("the label no longer contains the word this test guards against; " +
			"if it was renamed, this test can go")
	}
	if got := leadStatusFromCall("", &unresolved); got != "closed" {
		t.Errorf("leadStatusFromCall(%q) = %q — the generic 'resolved' branch caught it", unresolved, got)
	}

	// "Reactivating — Will Use Again" matches none of the generic keywords and
	// would fall through to a bare "called", losing the only outcome a win-back
	// call exists to produce.
	react := "Reactivating — Will Use Again"
	if got := leadStatusFromCall("", &react); got != "converted" {
		t.Errorf("leadStatusFromCall(%q) = %q, want \"converted\" — a reactivation "+
			"must not fall through to a generic logged call", react, got)
	}
}

// A win-back call is not a marketing call: it must not offer qualification
// language to someone who has already been our customer for years.
func TestRetentionPurposeOffersItsOwnVocabulary(t *testing.T) {
	ds := ccDispositionsForPurpose("retention")
	if len(ds) == 0 {
		t.Fatal("the retention purpose offers no dispositions at all")
	}
	byCode := map[string]ccDisposition{}
	for _, d := range ds {
		byCode[d.Code] = d
	}
	// The universal ones must still be there — a win-back number can be wrong, or
	// unanswered, or belong to someone who wants no further contact.
	for _, code := range []string{"no_answer", "wrong_number", "do_not_call", "callback", "call_dropped"} {
		if _, ok := byCode[code]; !ok {
			t.Errorf("retention purpose is missing the universal disposition %q", code)
		}
	}
	// Marketing qualification language must NOT be offered.
	for _, code := range []string{"not_eligible", "answered_interested", "answered_not_interested"} {
		if _, ok := byCode[code]; ok {
			t.Errorf("retention purpose offers %q — that is marketing qualification "+
				"language, and this customer already bought from us", code)
		}
	}
	// At least one disposition must capture a REASON, or the set fails its purpose.
	reasons := 0
	for c := range byCode {
		if strings.HasPrefix(c, "winback_") && c != "winback_reactivated" && c != "winback_wants_offer" {
			reasons++
		}
	}
	if reasons < 3 {
		t.Errorf("only %d win-back reason codes — churn reason is captured nowhere "+
			"else in the schema, so this set is where it has to come from", reasons)
	}
}

// Every win-back disposition that closes the contact must also be recognised by the
// lead-status machinery as NOT leaving the lead on 'interested', or a customer who
// just told us why they left would keep reading as a warm lead.
func TestWinbackClosuresDoNotLeaveALeadInterested(t *testing.T) {
	interestedRank := ccLeadStatusRank["interested"]
	for _, d := range ccDispositions {
		if !strings.HasPrefix(d.Code, "winback_") || d.Status != "closed" {
			continue
		}
		label := d.Label
		status := leadStatusFromCall(ccCallOutcome(d), &label)
		if ccLeadStatusRank[status] >= interestedRank || leadDeclinedOnCall(ccCallOutcome(d), &label) {
			continue // moved by the rank guard, or recognised as a refusal
		}
		t.Errorf("disposition %q (%s) closes the contact but maps to %q (rank %d, "+
			"below interested) and is not recognised as a refusal — a lead logged "+
			"Interested and then won back would freeze", d.Code, d.Label, status,
			ccLeadStatusRank[status])
	}
}

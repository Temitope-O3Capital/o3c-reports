package handlers

import (
	"strings"
	"testing"
)

// Retention routing turns a lifecycle bucket into a phone call, so the cases worth
// pinning are the ones that decide who gets rung and who is left alone.

// A win-back call is an offer, so it is marketing, so it is opt-in. With no marketing
// consent on file this must resolve to a refusal rather than a queue. If this test ever
// starts failing because the purpose was switched to servicing, that is not a fix — it
// is 4,615 people being called about an offer they never agreed to hear.
func TestARetentionCallIsMarketingAndThereforeOptIn(t *testing.T) {
	if !consentIsOptIn(purposeMarketing) {
		t.Fatal("marketing must be opt-in, or retention routing has no gate at all")
	}
}

// Churned is deliberately not called. 6,517 parties sit there — the largest measured
// bucket by a wide margin — and a call to someone long gone is a different conversation
// from a nudge to someone drifting. Including it would quietly make the win-back list
// mostly people who already left.
func TestChurnedIsNotAWinBackCall(t *testing.T) {
	for _, b := range retentionCallBuckets {
		if b == "churned" {
			t.Error("churned belongs to a separate, deliberate campaign — not the nightly nudge")
		}
		if b == "unknown" {
			t.Error("unknown means no transaction history, not lapsed: calling them " +
				"asserts a behaviour never measured")
		}
		if b == "active" {
			t.Error("an active customer does not need winning back")
		}
	}
	if len(retentionCallBuckets) == 0 {
		t.Fatal("no buckets means the job silently does nothing forever")
	}
}

// Priority drives what the floor works first, and it must speak the dialler's existing
// vocabulary — batchSyncCollectionsToDialler writes exactly these three words.
func TestPriorityMatchesTheDiallerVocabulary(t *testing.T) {
	cases := map[string]string{
		"vip": "High", "gold": "High", "silver": "Medium",
		"mass": "Low", "unclassified": "Low", "": "Low",
	}
	for tier, want := range cases {
		if got := retentionPriority(tier); got != want {
			t.Errorf("tier %q → %q, want %q", tier, got, want)
		}
	}
	// An unrecognised tier must fall to Low, never to High: a value we cannot read is
	// not evidence that the customer is valuable.
	if retentionPriority("platinum") != "Low" {
		t.Error("an unknown tier must not be promoted to High")
	}
}

// The heartbeat is the only place anyone sees what the nightly run decided, so it has to
// be stable and complete. Map iteration order would make it reshuffle every night and
// look like the data had changed.
func TestExclusionSummaryIsStableAndComplete(t *testing.T) {
	res := AudienceResult{ExcludedBy: map[string]int64{
		exSuppressed: 3, exNoMoneyHistory: 10, exInCollections: 7,
	}}
	first := retentionExclusionSummary(res)
	for i := 0; i < 20; i++ {
		if retentionExclusionSummary(res) != first {
			t.Fatal("summary order must not depend on map iteration")
		}
	}
	// Reported in the documented order, not the order they happened to be inserted.
	if !strings.HasPrefix(first, " (10 "+exNoMoneyHistory) {
		t.Errorf("expected the fixed reason order; got %q", first)
	}
	for _, want := range []string{exNoMoneyHistory, exInCollections, exSuppressed} {
		if !strings.Contains(first, want) {
			t.Errorf("summary dropped %q: %q", want, first)
		}
	}
	// Zero counts are omitted rather than printed as noise.
	if strings.Contains(first, exNoConsent) {
		t.Errorf("a zero count should not appear: %q", first)
	}
	if retentionExclusionSummary(AudienceResult{ExcludedBy: map[string]int64{}}) != "" {
		t.Error("nothing excluded should render as nothing, not an empty bracket")
	}
}

// Off unless explicitly switched on. Queueing someone for a call is a decision about how
// the contact centre spends its day, and a missing or mistyped setting must not make it.
func TestTheQueueIsOffUnlessExplicitlyOn(t *testing.T) {
	// Absent, mistyped, or a near-miss like "true" must all leave it off. A setting
	// that turns on a thing which rings customers has to fail closed.
	for _, v := range []string{"", "   ", "true", "yes", "1", "enabled", "ON!", "off", "no"} {
		if retentionQueueOn(v) {
			t.Errorf("%q must NOT enable the call queue", v)
		}
	}
	for _, v := range []string{"on", "On", "ON", "  on  "} {
		if !retentionQueueOn(v) {
			t.Errorf("%q should enable the queue", v)
		}
	}
}

// A cap that falls back to "no cap" on a typo is how a first live run dials the whole
// book in one night.
func TestABadCapFallsBackToTheDefault(t *testing.T) {
	for _, v := range []string{"", "lots", "-5", "0", "  "} {
		if got := retentionParseMax(v, 50); got != 50 {
			t.Errorf("%q → %d, want the 50 default", v, got)
		}
	}
	if got := retentionParseMax(" 120 ", 50); got != 120 {
		t.Errorf("a real value should win; got %d", got)
	}
}

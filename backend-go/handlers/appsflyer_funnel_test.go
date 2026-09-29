package handlers

import (
	"testing"

	"github.com/o3c/workspace/core"
)

// The case these tests exist for: the Blink "funnel" reports kyc_start and
// registration_details_submitted with an IDENTICAL user count on all 21 days they both
// appear (48 user-days each over 2026-08-29→09-28). They are one moment under two
// names, so the funnel was showing a stage that does not exist, and no reordering could
// ever have made the sequence monotonic.
//
// Window totals cannot catch this: 48 → 48 looks exactly like a step every user passes.
// Only the per-day counts separate them, which is why the detector works off `daily`.
//
// Note the two names are FOUR steps apart in the declared order. The first version of
// this detector only compared neighbours, so against live data it found nothing at all
// and did no work — hence TestAfAliasedStepsFindsNonAdjacentDuplicates below.

func day(ev, d string, uu int64) core.Row {
	return core.Row{"event_name": ev, "d": d, "uu": uu}
}

// spread builds one row per day for an event, so a fixture can clear the
// afAliasMinDays evidence floor without twenty literal rows.
func spread(ev string, counts ...int64) []core.Row {
	out := make([]core.Row, 0, len(counts))
	for i, c := range counts {
		out = append(out, day(ev, string(rune('a'+i)), c))
	}
	return out
}

func funnelRows(names ...string) []core.Row {
	out := make([]core.Row, 0, len(names))
	for _, n := range names {
		out = append(out, core.Row{"event_name": n})
	}
	return out
}

// Eleven days of counts — above afAliasMinDays, and irregular enough that matching it
// by chance is not a plausible reading.
var aliasCounts = []int64{3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5}

func TestAfAliasedStepsFlagsTwoNamesForOneEvent(t *testing.T) {
	var daily []core.Row
	daily = append(daily, spread("registration_details_submitted", aliasCounts...)...)
	daily = append(daily, spread("kyc_start", aliasCounts...)...)

	got := afAliasedSteps(funnelRows("registration_details_submitted", "kyc_start"), daily)
	if got["kyc_start"] != "registration_details_submitted" {
		t.Fatalf("identical daily counts over %d days should name the earlier event; got %q",
			len(aliasCounts), got["kyc_start"])
	}
	// The claim always attaches to the LATER name: the earlier one is how the journey
	// is described, and it keeps its own step-to-step conversion.
	if _, flagged := got["registration_details_submitted"]; flagged {
		t.Error("the earliest name in a duplicate group is the real step and must not be flagged")
	}
}

func TestAfAliasedStepsFindsNonAdjacentDuplicates(t *testing.T) {
	// The live shape: the two names sit four steps apart with ordinary steps between.
	var daily []core.Row
	daily = append(daily, spread("registration_details_submitted", aliasCounts...)...)
	daily = append(daily, spread("registration_email_verified", 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7)...)
	daily = append(daily, spread("af_complete_registration", 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6)...)
	daily = append(daily, spread("kyc_start", aliasCounts...)...)

	got := afAliasedSteps(funnelRows(
		"registration_details_submitted", "registration_email_verified",
		"af_complete_registration", "kyc_start"), daily)

	if got["kyc_start"] != "registration_details_submitted" {
		t.Fatal("a duplicate four steps down the funnel must still be found — " +
			"comparing only neighbours is what made an earlier version of this a no-op")
	}
	if len(got) != 1 {
		t.Errorf("the genuinely distinct steps must be left alone; got %v", got)
	}
}

func TestAfAliasedStepsIgnoresASingleDayOfDisagreement(t *testing.T) {
	b := append([]int64{}, aliasCounts...)
	b[7] = 7 // af_complete_registration matched on 20 of 21 real days, not all 21

	var daily []core.Row
	daily = append(daily, spread("kyc_start", aliasCounts...)...)
	daily = append(daily, spread("af_complete_registration", b...)...)

	got := afAliasedSteps(funnelRows("kyc_start", "af_complete_registration"), daily)
	if got["af_complete_registration"] != "" {
		t.Error("one day of genuine disagreement means these are not the same event; " +
			"the comparison is exact by design and must never soften into 'close enough'")
	}
}

func TestAfAliasedStepsNeedsEnoughDaysToBeEvidence(t *testing.T) {
	var daily []core.Row
	daily = append(daily, spread("bvn_start", 2, 2, 2)...)
	daily = append(daily, spread("bvn_result", 2, 2, 2)...)

	got := afAliasedSteps(funnelRows("bvn_start", "bvn_result"), daily)
	if got["bvn_result"] != "" {
		t.Errorf("two rare events can match for 3 days by chance; aliasing needs at least %d",
			afAliasMinDays)
	}
}

func TestAfAliasedStepsRejectsDifferentDaySets(t *testing.T) {
	// Same counts, different days. A step cannot be "the same event" as one that fires
	// on days it does not.
	var daily []core.Row
	for i := range aliasCounts {
		daily = append(daily, day("first_open", string(rune('a'+i)), 4))
		daily = append(daily, day("onboarding_start", string(rune('m'+i)), 4))
	}
	got := afAliasedSteps(funnelRows("first_open", "onboarding_start"), daily)
	if got["onboarding_start"] != "" {
		t.Error("events observed on disjoint days are not the same event")
	}
}

func TestAfAliasedStepsNamesTheEarliestOfThree(t *testing.T) {
	// Blink reports this moment under three names. All later ones point at the first,
	// so the page describes one step rather than a chain of duplicates.
	var daily []core.Row
	for _, ev := range []string{"registration_details_submitted", "af_complete_registration", "kyc_start"} {
		daily = append(daily, spread(ev, aliasCounts...)...)
	}
	got := afAliasedSteps(funnelRows(
		"registration_details_submitted", "af_complete_registration", "kyc_start"), daily)

	if got["af_complete_registration"] != "registration_details_submitted" ||
		got["kyc_start"] != "registration_details_submitted" {
		t.Errorf("every duplicate should name the earliest event in its group; got %v", got)
	}
}

func TestAfAliasedStepsSurvivesAnEmptyFeed(t *testing.T) {
	if len(afAliasedSteps(nil, nil)) != 0 {
		t.Error("no rows means nothing to flag")
	}
	// A failed per-day query (the best-effort path in appsflyerFunnel) must degrade to
	// "flag nothing", never to a wrong flag.
	got := afAliasedSteps(funnelRows("first_open", "onboarding_start"), nil)
	if got["onboarding_start"] != "" {
		t.Error("absent per-day data must not produce an aliasing claim")
	}
}

// af_login was removed from afFunnelOrder on 2026-09-29: a login is not a stage of a
// first-time onboarding journey. Pinned so it is not quietly re-added — as the terminal
// step it asserted that logging in completes onboarding, and users log in repeatedly.
func TestAfLoginIsNotAFunnelStep(t *testing.T) {
	for _, n := range afFunnelOrder {
		if n == "af_login" {
			t.Fatal("af_login is a recurring event, not a step: a user who logs in is " +
				"already registered, and does it again every session")
		}
	}
	if afFunnelRank("af_login") < len(afFunnelOrder) {
		t.Error("af_login must rank as unplaced so the client excludes it from conversions")
	}
}

// The funnel order is a declaration of belief. These are the facts the 2026-09-28
// correction established from measured evidence; pinned so a later tidy-up cannot
// quietly put onboarding back after BVN.
func TestFunnelOrderKeepsOnboardingAtAppOpen(t *testing.T) {
	if afFunnelRank("onboarding_start") >= afFunnelRank("registration_start") {
		t.Error("Blink fires onboarding_start at app-open (95.3% of first opens in " +
			"August, 93.8% in September), so it precedes registration")
	}
	if afFunnelRank("first_open") != 0 {
		t.Error("first_open is the base every other step is measured against")
	}
}

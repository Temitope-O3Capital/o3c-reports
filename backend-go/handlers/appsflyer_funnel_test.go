package handlers

import "testing"

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

// Unplaced events must stay unplaced. The original bug on this page was a "sharpest
// drop" drawn between card_blocked_kyc_required and card_issuance_failed — 17 users
// against 1 — two events the sort had merely appended alphabetically.
func TestUnplacedEventsRankAfterEveryDeclaredStep(t *testing.T) {
	for _, ev := range []string{"card_issuance_failed", "card_blocked_kyc_required", "af_initiated_checkout"} {
		if afFunnelRank(ev) < len(afFunnelOrder) {
			t.Errorf("%s is not a declared step and must rank as unplaced", ev)
		}
	}
	for i, n := range afFunnelOrder {
		if afFunnelRank(n) != i {
			t.Errorf("declared step %s ranks %d, want %d", n, afFunnelRank(n), i)
		}
	}
}

package handlers

import "testing"

// The rule this file pins: a basis recorded against a contact list counts for your
// OWN CUSTOMERS, not only for strangers.
//
// Before, campaignSendVerdict ignored listBasis entirely on the known-customer
// branch. A bureau-sourced prospect could be marketed to on a recorded
// legitimate_interest while an active customer of ten years could not, even though
// an existing relationship is the stronger of the two bases. The only route to your
// own customers was a per-party consent row for every one of them, which is why
// marketing consent sat at zero and every campaign reported it would send nothing.

func TestARecordedBasisCoversCustomersNotJustProspects(t *testing.T) {
	for _, basis := range []string{"opt_in_collected", "legitimate_interest", "third_party_asserted"} {
		pOK, _ := prospectMarketingVerdict(basis)
		cOK, _ := customerMarketingVerdict(basis)
		if !pOK {
			t.Fatalf("%s should allow a prospect", basis)
		}
		if !cOK {
			t.Errorf("%s allows a prospect but not a customer — that is the inversion "+
				"this change exists to remove", basis)
		}
	}
}

func TestNotForMarketingRefusesCustomersToo(t *testing.T) {
	if ok, reason := customerMarketingVerdict("not_for_marketing"); ok {
		t.Fatalf("not_for_marketing allowed a customer (reason %q)", reason)
	}
}

// Nothing recorded still refuses. The point of the change is to make a deliberate
// decision count, not to remove the need for one.
func TestNoBasisStillRefusesAndSaysHowToFixIt(t *testing.T) {
	for _, basis := range []string{"", "   ", "something_invented"} {
		ok, reason := customerMarketingVerdict(basis)
		if ok {
			t.Errorf("basis %q should not authorise marketing", basis)
		}
		if reason == "" {
			t.Errorf("basis %q refused with no explanation", basis)
		}
	}
	_, reason := customerMarketingVerdict("")
	for _, want := range []string{"record consent", "marketing basis"} {
		if !contains(reason, want) {
			t.Errorf("the refusal should name the fix; missing %q in %q", want, reason)
		}
	}
}

// The vocabulary must stay in step with contact_lists.consent_basis (migration 345)
// and with setListConsentBasis, or a value the UI can store would be unreadable here
// and would silently refuse.
func TestCustomerBasisVocabularyMatchesWhatTheUICanStore(t *testing.T) {
	for _, basis := range []string{
		"opt_in_collected", "third_party_asserted", "legitimate_interest", "not_for_marketing",
	} {
		_, reason := customerMarketingVerdict(basis)
		if contains(reason, "no marketing consent recorded") {
			t.Errorf("%q is storable by the UI but falls through to the default branch", basis)
		}
	}
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && indexOf(haystack, needle) >= 0
}

func indexOf(h, n string) int {
	for i := 0; i+len(n) <= len(h); i++ {
		if h[i:i+len(n)] == n {
			return i
		}
	}
	return -1
}

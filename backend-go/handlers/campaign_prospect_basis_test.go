package handlers

import (
	"strings"
	"testing"
)

// The prospect question, now answered by a person instead of by omission.
//
// app.party_contact_consent is keyed on party_id, and the 28,529 bought-in CRC contacts
// are not parties — so no consent row can exist for them either way. campaignSendVerdict
// used to let them through with a note, which settled a compliance question by default.
// It now reads contact_lists.consent_basis, and a list with nothing recorded is refused.
//
// prospectMarketingVerdict is pure so this can be pinned without a database: the entire
// decision is these five values, and which way each one fails is the point.

func TestProspectBasisVocabularyAndDirection(t *testing.T) {
	cases := []struct {
		basis   string
		allowed bool
		why     string
	}{
		{"opt_in_collected", true, "they asked us to contact them"},
		{"legitimate_interest", true, "existing relationship, related subject"},
		{"third_party_asserted", true, "allowed, but labelled as someone else's assertion"},
		{"not_for_marketing", false, "explicitly decided against"},
		{"", false, "nothing recorded — must refuse rather than inherit permission"},
		{"   ", false, "whitespace is not a decision"},
		{"made_up", false, "an unrecognised basis must not read as permission"},
		{"OPT_IN_COLLECTED", false, "the stored vocabulary is lower case; a near-miss must not pass"},
	}
	for _, c := range cases {
		ok, reason := prospectMarketingVerdict(c.basis)
		if ok != c.allowed {
			t.Errorf("basis %q: allowed=%v, want %v (%s). reason: %q",
				c.basis, ok, c.allowed, c.why, reason)
		}
		if reason == "" {
			t.Errorf("basis %q: no reason recorded; every prospect decision has to be "+
				"explainable after the fact", c.basis)
		}
	}
}

// A third-party assertion is allowed but must never read as consent we collected. If it
// is ever questioned, the record should say whose claim it was.
func TestThirdPartyBasisIsLabelledHonestly(t *testing.T) {
	_, reason := prospectMarketingVerdict("third_party_asserted")
	for _, want := range []string{"asserted", "not collected by us"} {
		if !strings.Contains(reason, want) {
			t.Errorf("reason %q does not make clear the consent was the source's claim "+
				"rather than ours (missing %q)", reason, want)
		}
	}
}

// The refusal has to say what to do about it. "No basis" with no instruction is a dead
// end for whoever is trying to send the campaign.
func TestMissingBasisRefusalSaysHowToFixIt(t *testing.T) {
	_, reason := prospectMarketingVerdict("")
	if !strings.Contains(reason, "contact list") {
		t.Errorf("reason %q does not tell the officer where to set the basis", reason)
	}
}

// Every value the CHECK constraint in migration 343 allows must be understood here, or a
// basis somebody records through the UI would be stored and then silently refused.
func TestEveryStoredBasisIsUnderstood(t *testing.T) {
	// Exactly the list in contact_lists_consent_basis_chk.
	stored := []string{"opt_in_collected", "third_party_asserted", "legitimate_interest", "not_for_marketing"}
	for _, b := range stored {
		_, reason := prospectMarketingVerdict(b)
		if strings.Contains(reason, "no recorded basis") {
			t.Errorf("%q is storable but falls through to the unrecorded branch, so a "+
				"recorded decision would be ignored", b)
		}
	}
}

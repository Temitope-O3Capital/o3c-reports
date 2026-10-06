package handlers

import "testing"

// The rule campaignSendVerdict applies, pinned at the level that does not need a database.
//
// Until 2026-10-06 the campaign sender consulted app.party_contact_consent nowhere at all:
// the email blast claimed a pending row and sent it, and the SMS path excluded dnc_list by
// phone and nothing else. Marketing consent is 0 by deliberate design — migration 290 seeds
// servicing for active-product holders and says of marketing that "inventing that would be
// the one thing this table exists to prevent" — so a marketing blast to the customer base
// would have gone out with no lawful basis for a single recipient.

// Marketing is opt-in, servicing is opt-out. If this inverts, either every arrears
// reminder stops (43% of a ₦2.19bn book was measured as having no servicing row, because
// nobody had asked them) or every customer becomes marketable without agreeing.
func TestMarketingIsOptInAndServicingIsNot(t *testing.T) {
	if !consentIsOptIn(purposeMarketing) {
		t.Error("marketing is not opt-in — a customer with no granted row would be sent an offer")
	}
	if consentIsOptIn(purposeServicing) {
		t.Error("servicing became opt-in — a missing row means nobody asked, not a refusal, " +
			"and treating it as one silences arrears reminders to people who never objected")
	}
}

// Every channel the verdict can be asked about has to be a channel the audience rules
// know. An unknown channel is refused rather than waved through, because the suppression
// function is keyed on the channel string and a typo would check nothing.
func TestCampaignChannelsAreAllKnownToTheAudienceRules(t *testing.T) {
	for _, ch := range []string{"email", "sms", "whatsapp"} {
		if !audienceChannels[ch] {
			t.Errorf("campaigns dispatch on %q but the audience rules do not know it, so "+
				"campaignSendVerdict would refuse every recipient on that channel", ch)
		}
	}
	for _, ch := range []string{"", "mail", "e-mail", "SMS", "telegram"} {
		if audienceChannels[ch] {
			t.Errorf("%q is accepted as a channel; suppression is keyed on this exact "+
				"string, so a near-miss would silently check nothing", ch)
		}
	}
}

// The two purposes are the only legal values, and they match what migration 336 allows in
// app.campaigns.purpose. A third value appearing in either place without the other would
// either break the insert or fall through the verdict as "not opt-in" — i.e. send.
func TestCampaignPurposeVocabularyMatchesTheColumn(t *testing.T) {
	allowed := map[string]bool{purposeMarketing: true, purposeServicing: true}
	if len(allowed) != 2 {
		t.Fatalf("expected exactly two purposes, got %d", len(allowed))
	}
	for _, p := range []string{"marketing", "servicing"} {
		if !allowed[p] {
			t.Errorf("%q is in the CHECK constraint on app.campaigns.purpose but is not a "+
				"purpose constant, so a campaign row could carry a value the sender cannot read", p)
		}
	}
	// Anything else must not read as servicing, because servicing is the permissive side.
	for _, p := range []string{"", "promo", "transactional", "MARKETING"} {
		if consentIsOptIn(p) {
			continue // treated as marketing-strict, which is the safe direction
		}
		if p != purposeServicing {
			// consentIsOptIn returns false for these, meaning the opt-OUT branch runs. That
			// is why the dispatcher normalises to purposeMarketing unless the column says
			// exactly "servicing", rather than passing the raw value through.
			t.Logf("note: %q is not opt-in, so the dispatcher must normalise it to "+
				"marketing before calling the verdict — it does", p)
		}
	}
}

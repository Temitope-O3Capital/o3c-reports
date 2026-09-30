package handlers

import "testing"

// The one rule that matters: a marketing opt-in cannot be created without saying where
// it came from. Everything else in the consent register is bookkeeping.
func TestConsentMarketingGrantNeedsBasisAndEvidence(t *testing.T) {
	if msg := consentValidate(1, "email", "marketing", "granted", "", "signed form 2026-09-01"); msg == "" {
		t.Error("marketing grant with no basis was accepted")
	}
	if msg := consentValidate(1, "email", "marketing", "granted", "signup_form", ""); msg == "" {
		t.Error("marketing grant with no evidence was accepted")
	}
	if msg := consentValidate(1, "email", "marketing", "granted", "signup_form", "form 12"); msg == "" {
		t.Error("marketing grant with a token evidence string was accepted")
	}
	if msg := consentValidate(1, "email", "marketing", "granted",
		"signup_form", "Onboarding form batch 2026-09, scanned to DMS/consent/2026-09"); msg != "" {
		t.Errorf("a properly evidenced marketing grant was refused: %s", msg)
	}
}

// Evidence that restates the decision is not evidence. A register full of "yes" cannot
// answer the only question ever asked of it.
func TestConsentEvidenceMustNotRestateTheAnswer(t *testing.T) {
	for _, e := range []string{
		"yes", "YES", "  Yes. ", "consented", "customer agreed", "Verbal", "n/a", "confirmed",
	} {
		if !consentEvidenceIsEmpty(e) {
			t.Errorf("%q should not count as evidence", e)
		}
	}
	for _, e := range []string{
		"Signed mandate, file ref CM-2291",
		"Call recording 2026-08-14 11:02, agent Doris",
		"Onboarding form, DMS/consent/2026-09",
	} {
		if consentEvidenceIsEmpty(e) {
			t.Errorf("%q is real evidence and was rejected", e)
		}
	}
}

// A withdrawal is always recordable. Making someone justify "stop" is how "stop" gets
// ignored, so it needs no basis and no evidence on any channel or purpose.
func TestConsentWithdrawalNeedsNoJustification(t *testing.T) {
	for _, purpose := range []string{"marketing", "servicing"} {
		for _, ch := range []string{"email", "sms", "whatsapp", "voice"} {
			if msg := consentValidate(1, ch, purpose, "withdrawn", "", ""); msg != "" {
				t.Errorf("withdrawal (%s/%s) was refused: %s", purpose, ch, msg)
			}
		}
	}
}

// Servicing is opt-out, so a servicing grant does not carry the evidence burden. That
// asymmetry is deliberate and is the reason 282 delinquent parties still receive
// arrears reminders.
func TestConsentServicingGrantIsNotBurdened(t *testing.T) {
	if msg := consentValidate(1, "email", "servicing", "granted", "", ""); msg != "" {
		t.Errorf("servicing grant was refused: %s", msg)
	}
}

func TestConsentRejectsUnknownValues(t *testing.T) {
	if consentValidate(1, "carrier_pigeon", "marketing", "withdrawn", "", "") == "" {
		t.Error("unknown channel accepted")
	}
	if consentValidate(1, "email", "advertising", "withdrawn", "", "") == "" {
		t.Error("unknown purpose accepted")
	}
	if consentValidate(1, "email", "marketing", "maybe", "", "") == "" {
		t.Error("unknown state accepted")
	}
	if consentValidate(0, "email", "marketing", "withdrawn", "", "") == "" {
		t.Error("a missing customer was accepted")
	}
	// 'call' is what AudienceSpec calls it; the table's CHECK says 'voice'. Recording
	// against the wrong spelling would fail closed and look like nobody consented.
	if consentValidate(1, "call", "marketing", "withdrawn", "", "") == "" {
		t.Error("'call' must be rejected here: the column stores 'voice'")
	}
}

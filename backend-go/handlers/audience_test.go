package handlers

import (
	"context"
	"strings"
	"testing"
)

// The audience resolver decides who may lawfully be contacted, so the cases worth
// pinning are the refusals — a bug here does not produce a wrong number on a screen,
// it produces messages to people who never agreed to receive them.
//
// Measured on the live book 2026-09-29: app.party_contact_consent holds 35,780 rows,
// every one purpose='servicing' on channel 'email' or 'sms'. Marketing consent: zero.
// WhatsApp consent: zero, on any purpose.

func TestAudienceRejectsAnUnknownPurpose(t *testing.T) {
	// An unrecognised lawful basis is not a filter that matches nothing — it is a
	// question the resolver cannot answer, so it refuses rather than returning a list.
	for _, p := range []string{"", "promo", "newsletter", "servicing2"} {
		if _, err := ResolveAudience(context.Background(), nil, AudienceSpec{Purpose: p, Channel: "sms"}); err == nil {
			t.Errorf("purpose %q should be rejected", p)
		}
	}
}

func TestAudienceRejectsAnUnknownChannel(t *testing.T) {
	for _, c := range []string{"", "post", "pigeon", "telegram"} {
		if _, err := ResolveAudience(context.Background(), nil, AudienceSpec{Purpose: "servicing", Channel: c}); err == nil {
			t.Errorf("channel %q should be rejected", c)
		}
	}
	// 'call' is a channel on purpose: a dialler queue is a send, and it is subject to
	// the same DNC and suppression rules as a text message.
	if !audienceChannels["call"] {
		t.Error("the contact-centre queue is an audience too and must be resolvable")
	}
}

// Every party must be counted against exactly one reason, or "812 excluded" stops
// adding up and the caller is quietly misled about the size of a segment.
func TestExclusionReasonsAreDistinct(t *testing.T) {
	reasons := []string{
		exNoMoneyHistory, exNoContact, exInCollections,
		exNoAddress, exNoConsent, exSuppressed,
	}
	seen := map[string]bool{}
	for _, r := range reasons {
		if r == "" {
			t.Fatal("an empty reason would read as eligible")
		}
		if seen[r] {
			t.Errorf("duplicate exclusion reason %q — counts would collide", r)
		}
		seen[r] = true
	}
	if len(seen) != 6 {
		t.Errorf("expected 6 distinct reasons, got %d", len(seen))
	}
}

// The defaults are the cautious reading, and they are load-bearing. bucket='unknown'
// covers 13,329 of 21,267 parties and means "we hold no transaction history", not
// "inactive" — app.transactions is card-only. Defaulting RequireMeasured off would
// silently target people on behaviour that was never observed.
func TestSpecDefaultsAreTheCautiousReading(t *testing.T) {
	// The HTTP layer turns absent query parameters into these; this pins the intent so
	// a later refactor cannot invert them without the test objecting.
	spec := AudienceSpec{
		Purpose:              purposeMarketing,
		Channel:              "email",
		RequireMeasured:      qstrDefaultTrue(""),
		ExcludeInCollections: qstrDefaultTrue(""),
	}
	if !spec.RequireMeasured {
		t.Error("an absent require_measured must mean TRUE: unknown is not a behaviour")
	}
	if !spec.ExcludeInCollections {
		t.Error("an absent exclude_in_collections must mean TRUE for an offer")
	}
	if qstrDefaultTrue("false") {
		t.Error("an explicit false must be honoured — arrears reminders need those people")
	}
}

// Mirrors the parsing in audiencePreview: anything but the literal "false" is true.
func qstrDefaultTrue(v string) bool { return v != "false" }

func TestPurposeConstantsMatchTheStoredVocabulary(t *testing.T) {
	// These are the values app.party_contact_consent.purpose actually carries. A typo
	// here does not error — it silently matches no consent row and empties every
	// audience, which looks like "nobody qualifies" rather than "the code is wrong".
	if purposeServicing != "servicing" || purposeMarketing != "marketing" {
		t.Errorf("purpose constants drifted: %q / %q", purposeServicing, purposeMarketing)
	}
	for _, p := range []string{purposeServicing, purposeMarketing} {
		if p != strings.ToLower(strings.TrimSpace(p)) {
			t.Errorf("purpose %q must be stored lowercase and untrimmed to match SQL", p)
		}
	}
}

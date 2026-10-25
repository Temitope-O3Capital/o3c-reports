package handlers

import "testing"

// Which address a mail leaves under is decided by its Kind, and the cost of getting it
// wrong lands in a customer's inbox rather than in a log. These are the Kind values
// actually passed by callers today, each pinned to the purpose it must resolve to.
func TestSenderPurposeForKind(t *testing.T) {
	cases := map[string]string{
		// Staff, not customers. This is the whole point of notifications@.
		"report":       senderPurposeInternal,
		"board_pack":   senderPurposeInternal,
		"notification": senderPurposeInternal,

		// Opted-in marketing, and nothing else, may use the promotions address.
		"campaign": senderPurposePromo,

		// The support desk, including the survey it sends after a ticket: to the
		// customer that is one conversation and should come from one address.
		"helpdesk": senderPurposeHelpdesk,
		"care":     senderPurposeHelpdesk,
		"csat":     senderPurposeHelpdesk,
		"survey":   senderPurposeHelpdesk,

		"statement":      senderPurposeTransactional,
		"cc_statement":   senderPurposeTransactional,
		"password_reset": senderPurposeTransactional,
		"auth":           senderPurposeTransactional,
		"loan":           senderPurposeTransactional,
		"card":           senderPurposeTransactional,
		"single":         senderPurposeTransactional,
		"transactional":  senderPurposeTransactional,
	}
	for kind, want := range cases {
		if got := senderPurposeForKind(kind); got != want {
			t.Errorf("kind %q: want purpose %q, got %q", kind, want, got)
		}
	}
}

// The sender is chosen BEFORE opt.Kind is defaulted to "transactional", so an empty
// Kind has to reach the same answer on its own. If this ever diverges, mail sent
// without a Kind silently changes which address it leaves under.
func TestSenderPurposeForEmptyKindMatchesTransactional(t *testing.T) {
	if got := senderPurposeForKind(""); got != senderPurposeTransactional {
		t.Errorf("an unset Kind must resolve to the transactional sender, got %q", got)
	}
	if senderPurposeForKind("") != senderPurposeForKind("transactional") {
		t.Error("an unset Kind and an explicit \"transactional\" must pick the same sender")
	}
}

// Nothing unrecognised may land on the promotions address. A new Kind added by someone
// else should fall to transactional, never to marketing: an unexpected statement from
// promo@ invites an unsubscribe that then suppresses the customer's real mail.
func TestUnknownKindNeverUsesThePromoSender(t *testing.T) {
	for _, kind := range []string{"invoice", "kyc_reminder", "arrears", "whatever_next", "PROMO", "Campaign"} {
		if got := senderPurposeForKind(kind); got == senderPurposePromo {
			t.Errorf("kind %q resolved to the promotions sender; only an explicit campaign may", kind)
		}
	}
}

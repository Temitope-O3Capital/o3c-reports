package handlers

import "testing"

// This workspace runs on a private network, so an https:// unsubscribe link cannot
// be opened by a customer no matter how it is signed. These tests pin the two pure
// decisions that keep the opt-out real anyway.

func TestPrivateHostsAreNotReachableByRecipients(t *testing.T) {
	unreachable := []string{
		"",
		"https://crm.o3cards.pri:8443", // the actual deployment
		"http://localhost:8000",
		"https://localhost",
		"http://127.0.0.1:8000",
		"https://10.0.0.5",
		"https://192.168.1.20:8443",
		"https://172.16.4.9",
		"https://o3c.local",
		"https://crm.internal",
		"https://box.lan",
		"https://intranet.corp",
		"https://crm", // bare hostname, no dot
	}
	for _, u := range unreachable {
		if hostIsReachableByRecipients(u) {
			t.Errorf("%q was treated as publicly reachable — an unsubscribe link there is dead", u)
		}
	}
}

func TestPublicHostsAreReachable(t *testing.T) {
	for _, u := range []string{
		"https://reports.o3cards.com",
		"https://reports.o3cards.com/",
		"https://replies.o3cards.com:8443",
		"https://8.8.8.8",
	} {
		if !hostIsReachableByRecipients(u) {
			t.Errorf("%q should be usable for a signed https unsubscribe link", u)
		}
	}
}

func TestMailtoIsRecognisedSoOneClickIsNotClaimed(t *testing.T) {
	// List-Unsubscribe-Post is RFC 8058 one-click and HTTPS-only. Advertising it
	// next to a mailto is malformed, and it used to be sent unconditionally.
	if !unsubscribeIsMailto("mailto:unsubscribe@replies.o3cards.com?subject=UNSUBSCRIBE%205703") {
		t.Error("a mailto target was not recognised as one")
	}
	if !unsubscribeIsMailto("MAILTO:x@y.com") {
		t.Error("scheme matching must be case-insensitive")
	}
	if unsubscribeIsMailto("https://reports.o3cards.com/api/mail/unsubscribe?token=abc") {
		t.Error("an https target must not be treated as a mailto")
	}
}

func TestAnEmailedOptOutIsRecognised(t *testing.T) {
	// What the mailto link and every client's own unsubscribe control pre-fill.
	for _, c := range []struct{ subject, body string }{
		{"UNSUBSCRIBE 5703", ""},
		{"unsubscribe", ""},
		{"Re: Customer Service Week", "Please unsubscribe me"},
		{"", "opt out"},
		{"", "Opt-Out please"},
		{"", "remove me from this list"},
		{"", "stop email"},
	} {
		if !mailLooksLikeUnsubscribe(c.subject, c.body) {
			t.Errorf("missed an opt-out: subject=%q body=%q", c.subject, c.body)
		}
	}
}

// The expensive mistake here is the false positive: silently unsubscribing someone
// who was asking a question, or who quoted our own footer back underneath their
// reply. That is why only the subject and the FIRST line of the body are read.
func TestOrdinaryRepliesAreNotTreatedAsOptOuts(t *testing.T) {
	for _, c := range []struct{ subject, body string }{
		{"Re: Customer Service Week", "Thanks for the note, my card is working now."},
		{"Question about my limit", "Can you raise it?"},
		// Our own footer, quoted below their actual message.
		{"Re: Statement", "When is my payment due?\n\n> You are receiving this email from O3 Capital. Unsubscribe"},
		{"Re: Statement", "All good\n\nOn Tue, O3 wrote:\n> click Unsubscribe to stop"},
		{"", ""},
	} {
		if mailLooksLikeUnsubscribe(c.subject, c.body) {
			t.Errorf("false opt-out: subject=%q body=%q", c.subject, c.body)
		}
	}
}

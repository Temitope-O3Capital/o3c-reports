package handlers

import "testing"

// A SURVEY LINK A CUSTOMER CANNOT OPEN IS WORSE THAN NO SURVEY.
//
// app_base_url is https://crm.o3cards.pri:8443 — an internal hostname on a private TLD.
// Staff follow it perfectly well; a customer's phone cannot resolve it at all. All 46
// CSAT emails ever sent carried that link, so the survey was not unanswered because
// customers did not care: it was unanswerable, and the send "succeeded" every time, so
// nothing anywhere reported a fault.
//
// hdCSATBaseIsPublic is the gate, and it is a pure function over the URL text on purpose.
// A DNS lookup would be the "proper" check and the wrong one — it would pass inside the
// office, fail in CI, and make customer email depend on the resolver of whichever host
// happened to send it.
//
// It errs towards NO: a base it cannot vouch for stops the send, because the cost of a
// false negative is a survey nobody receives, and the cost of a false positive is a
// customer receiving a broken link from their bank.
func TestCSATLinkBaseMustBeReachableByACustomer(t *testing.T) {
	cases := []struct {
		name string
		base string
		want bool
	}{
		// The real setting, which is the whole reason this function exists.
		{"the configured internal host", "https://crm.o3cards.pri:8443", false},

		{"a public host", "https://care.o3cards.com", true},
		{"a public host with a path", "https://o3cards.com/app", true},
		{"a public host on a port", "https://care.o3cards.com:8443", true},

		// http would put a one-tap survey token in the clear.
		{"plain http", "http://care.o3cards.com", false},

		{"localhost", "https://localhost:8443", false},
		{"loopback ip", "https://127.0.0.1", false},
		{"a bare machine name", "https://crm", false},

		// Private TLDs. .pri is in use; the others are the obvious next mistake.
		{"dot local", "https://crm.local", false},
		{"dot internal", "https://crm.internal", false},
		{"dot lan", "https://crm.lan", false},
		{"dot intranet", "https://crm.intranet", false},
		{"dot corp", "https://crm.corp", false},
		{"dot home", "https://crm.home", false},

		// RFC 1918, for a base configured as an address.
		{"a 10.x address", "https://10.0.0.8:8443", false},
		{"a 192.168 address", "https://192.168.1.20", false},
		{"a 172.16 address", "https://172.16.4.4", false},
		{"link-local", "https://169.254.1.1", false},

		{"empty", "", false},
		{"not a url", "crm.o3cards.pri", false},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := hdCSATBaseIsPublic(c.base); got != c.want {
				verb := "refuse"
				if c.want {
					verb = "accept"
				}
				t.Errorf("hdCSATBaseIsPublic(%q) = %v — it must %s this base", c.base, got, verb)
			}
		})
	}
}

// The window is the blast radius, so it is worth pinning as a decision rather than
// leaving it as a number somebody tidies upward. 7 days means switching the sender on
// cannot produce a bulk send: measured 2026-10-12, 353 resolved tickets carry a customer
// email and 0 of them closed in the last week.
func TestTheSurveyWindowStaysSmall(t *testing.T) {
	if csatSendWindowDays > 14 {
		t.Errorf("csatSendWindowDays is %d: widening this window turns the first run into a "+
			"bulk mailing to customers whose tickets closed weeks ago, and a satisfaction "+
			"question about a month-old ticket is not worth asking", csatSendWindowDays)
	}
	if csatSendWindowDays < 1 {
		t.Error("the window must cover at least a day, or nothing is ever asked")
	}
}

package handlers

import "testing"

// Every campaign SMS ends "Reply STOP to opt out." Until 2026-09-23 nothing in the
// backend read that reply — the word STOP appeared nowhere in the codebase — so a
// customer who sent it had a support ticket opened, was never added to dnc_list, and
// kept receiving messages. These tests pin both halves of the promise.

func TestOptOutKeywordHonoursThePromiseWeMake(t *testing.T) {
	// The standard set, in the shapes customers actually type them.
	for _, body := range []string{
		"STOP", "stop", "Stop", " stop ", "STOP.", "Stop!", "stop\n",
		"STOPALL", "UNSUBSCRIBE", "unsubscribe.", "CANCEL", "End", "quit",
		"OPTOUT", "opt out", "OPT-OUT", "Opt Out.",
	} {
		if !optOutKeyword(body) {
			t.Errorf("optOutKeyword(%q) = false — we told this customer STOP would work", body)
		}
	}
}

func TestOptOutKeywordDoesNotSwallowServiceRequests(t *testing.T) {
	// A missed opt-out is a regulatory breach; a service request mistaken for an
	// opt-out is a customer silently cut off who does not know it. Both are bad, so
	// the match is on the whole message and nothing else.
	for _, body := range []string{
		"please stop my card",
		"stop calling me about the loan",     // intent, but it is a conversation
		"when does my card end?",             // contains "end"
		"I want to cancel my transaction",    // contains "cancel"
		"Can you unsubscribe me from emails", // contains "unsubscribe"
		"quitting my job next month",
		"", " ", "...", "1234",
		"no", "yes", "ok", "thanks",
	} {
		if optOutKeyword(body) {
			t.Errorf("optOutKeyword(%q) = true — this would suppress a customer who "+
				"never asked to be suppressed", body)
		}
	}
}

// withSMSOptOut makes the promise; optOutKeyword has to answer it. If someone
// changes the wording of the promise, the keyword it names must still be honoured.
func TestThePromisedKeywordIsActuallyHonoured(t *testing.T) {
	promise := withSMSOptOut("Your statement is ready.")
	if !containsFold(promise, "STOP") {
		t.Fatalf("withSMSOptOut no longer names STOP: %q — update optOutKeywords to "+
			"match whatever it now promises", promise)
	}
	if !optOutKeyword("STOP") {
		t.Error("withSMSOptOut promises STOP but optOutKeyword does not honour it")
	}
}

func containsFold(hay, needle string) bool {
	for i := 0; i+len(needle) <= len(hay); i++ {
		match := true
		for j := 0; j < len(needle); j++ {
			a, b := hay[i+j], needle[j]
			if a >= 'a' && a <= 'z' {
				a -= 32
			}
			if b >= 'a' && b <= 'z' {
				b -= 32
			}
			if a != b {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}

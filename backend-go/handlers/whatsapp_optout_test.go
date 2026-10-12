package handlers

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// A STOP ON WHATSAPP MUST BE HONOURED, AND THE HANDLER MUST ACTUALLY BE CALLED.
//
// optOutKeyword and the full CTIA keyword set were already in this codebase and already
// wired — to SMS only. WhatsApp inbound ignored them, so a customer typing STOP got a
// support ticket opened and kept receiving messages. A Lagos court awarded NGN 1,000,000
// over exactly that in Olatokun v. Polaris Bank, rejecting "there was an unsubscribe
// mechanism" as a defence: an opt-out honoured on one channel and ignored on another is
// not a mechanism.
//
// WHY THE REACHABILITY HALF IS HERE. When I added waHandleOptOut I appended the function
// and the edit that called it silently did nothing — a regex anchor that did not account
// for this file's CRLF line endings. The build passed, the tests passed, and the opt-out
// was dead code. A handler nobody calls is the defect this whole module has been full of,
// and it is invisible to every test that only checks behaviour of things it can reach.
func TestWhatsAppHonoursStop(t *testing.T) {
	src, err := os.ReadFile("whatsapp.go")
	if err != nil {
		t.Fatalf("read whatsapp.go: %v", err)
	}
	text := string(src)

	if !strings.Contains(text, "func waHandleOptOut(") {
		t.Fatal("waHandleOptOut is gone — WhatsApp would stop honouring STOP")
	}

	// It must be CALLED from the inbound path, not merely defined.
	called := regexp.MustCompile(`if waHandleOptOut\(db, fromPhone, text\) \{`)
	if !called.MatchString(text) {
		t.Error("waHandleOptOut is defined but never called from the inbound loop — a STOP " +
			"would be filed as a support ticket and the customer would keep receiving messages")
	}

	// And it must run BEFORE the message becomes a ticket. Order is the whole point: a
	// suppression that fails to record is a regulatory exposure, a ticket that fails to
	// open is an inconvenience.
	iOptOut := strings.Index(text, "if waHandleOptOut(db, fromPhone, text)")
	iTicket := strings.Index(text, "go processWAMessage(db, fromPhone")
	if iOptOut >= 0 && iTicket >= 0 && iOptOut > iTicket {
		t.Error("the opt-out check runs AFTER the ticket is created — suppression must come first")
	}

	// It must suppress on a channel the sender actually consults. app.is_suppressed reads
	// app.contact_suppressions by channel, and campaignSendVerdict / ccNotSuppressedExpr
	// call it — so writing anywhere else would record the opt-out without honouring it.
	fn := text[strings.Index(text, "func waHandleOptOut("):]
	if end := strings.Index(fn, "\n}"); end > 0 {
		fn = fn[:end]
	}
	if !strings.Contains(fn, "contact_suppressions") {
		t.Error("waHandleOptOut does not write app.contact_suppressions — that is the table " +
			"app.is_suppressed reads, so the opt-out would be recorded but not enforced")
	}
	if !strings.Contains(fn, "'whatsapp'") {
		t.Error("the suppression must name the whatsapp channel, or it suppresses nothing")
	}
	// It must NOT quietly widen to every channel. A STOP sent on WhatsApp is certainly
	// about WhatsApp; silencing the customer's due-date reminders too is a decision
	// nobody made. (The reverse asymmetry is deliberate and already correct: an SMS STOP
	// writes dnc_list, which app.is_suppressed applies to whatsapp as well.)
	if strings.Contains(fn, "'all'") {
		t.Error("waHandleOptOut suppresses channel 'all' — a WhatsApp STOP should not also " +
			"silence servicing SMS the customer never asked to stop")
	}
}

// The keyword set is shared with SMS on purpose: one definition of "the customer said
// stop", so the two channels cannot drift into honouring different words.
func TestWhatsAppUsesTheSharedStopWords(t *testing.T) {
	for _, word := range []string{"STOP", "stop", "Stop!", "unsubscribe", "cancel", "quit", "optout"} {
		if !optOutKeyword(word) {
			t.Errorf("optOutKeyword(%q) = false — we tell customers STOP works", word)
		}
	}
	// And it must not fire on a message that merely contains the word, or a customer
	// asking us to stop a direct debit would be unsubscribed from everything.
	for _, phrase := range []string{"please stop my card", "when will you stop charging me"} {
		if optOutKeyword(phrase) {
			t.Errorf("optOutKeyword(%q) = true — that is a support request, not an opt-out", phrase)
		}
	}
}

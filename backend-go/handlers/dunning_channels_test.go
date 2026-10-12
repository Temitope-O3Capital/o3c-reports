package handlers

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// ARREARS REMINDERS MUST NOT GO OVER WHATSAPP.
//
// Meta's WhatsApp Business Policy names "debt collection" as a prohibited category,
// "irrespective of the global or local licenses, registrations, or other approvals your
// business may hold". The penalty is not a rejected message — it is the WhatsApp
// Business Account, which would take customer service, notifications and campaigns down
// with it, none of which are collections.
//
// WHY A TEST AND NOT JUST A COMMENT. The dunning channel list read
// {"email", "whatsapp", "sms"} and called sendWhatsApp unconditionally. It never sent,
// for the one reason that is about to stop being true: the WhatsApp credentials are
// empty, so sendWhatsApp returns "not_configured". Adding credentials for the WhatsApp
// messaging work — which is the whole point of that project — would have armed
// collections over WhatsApp with nobody deciding to. A comment cannot fail a build.
//
// This reads the source rather than calling the function because the channel list is a
// literal in the dispatch loop: there is no seam to inject, and the thing worth
// protecting is the literal itself. Same approach as sql_placeholders_test.go and
// mail_unsubscribe_test.go.
func TestDunningNeverSendsOverWhatsApp(t *testing.T) {
	src, err := os.ReadFile("collections_dunning.go")
	if err != nil {
		t.Fatalf("read collections_dunning.go: %v", err)
	}
	text := string(src)

	// 1. The dispatch loop's channel list must not name whatsapp.
	loop := regexp.MustCompile(`for _, ch := range \[\]string\{([^}]*)\}`)
	m := loop.FindStringSubmatch(text)
	if m == nil {
		t.Fatal("could not find the dunning channel loop — if it was restructured, this " +
			"test must be rewritten to match, NOT deleted: the rule it protects still holds")
	}
	if strings.Contains(strings.ToLower(m[1]), "whatsapp") {
		t.Errorf("the dunning channel list is {%s} — WhatsApp must not be a dunning channel. "+
			"Meta prohibits debt collection on the platform and the cost of being caught is "+
			"the whole WhatsApp Business Account, not this one message.", strings.TrimSpace(m[1]))
	}

	// 2. And nothing in this file may call the sender, whatever the loop says. The two
	//    halves matter separately: a future edit could add a send call behind a flag
	//    without touching the list.
	for _, call := range []string{"sendWhatsApp(", "sendWhatsAppTemplate(", "sendWhatsAppCampaign("} {
		if strings.Contains(text, call) {
			t.Errorf("collections_dunning.go calls %s — arrears messaging must not reach "+
				"WhatsApp by any route. If WhatsApp is ever wanted for arrears, that is a "+
				"conversation with Meta first, not a code change.", call)
		}
	}
}

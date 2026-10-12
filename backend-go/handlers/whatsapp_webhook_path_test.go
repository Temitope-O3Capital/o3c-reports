package handlers

import (
	"os"
	"strings"
	"testing"
)

// THE WEBHOOK URL THE SETUP SCREEN SHOWS MUST BE THE ONE THE SERVER SERVES.
//
// This exists because the first draft of the setup screen advertised
// "/api/whatsapp/webhook", and the server serves "/api/whatsapp/inbound/whatsapp".
// Nobody would have discovered that from the code: both halves were individually
// correct, the build passed, and the symptom would have arrived during an onboarding
// session as Meta refusing to verify a callback URL — with the obvious suspicion falling
// on the verify token or the public hostname rather than on a path typed twice.
//
// It is the same defect as every other one this module has had: one fact written in two
// places. They are now one constant, and this checks the third place the fact also
// lives — the route prefix in main.go, which no constant can reach.
func TestTheAdvertisedWebhookPathIsTheOneWeServe(t *testing.T) {
	// The two constants must agree by construction.
	if waWebhookPublicPath != "/api/whatsapp"+waInboundRoute {
		t.Errorf("waWebhookPublicPath is %q but the route mounts %q under /api/whatsapp",
			waWebhookPublicPath, waInboundRoute)
	}

	// And the mount prefix in main.go must still be /api/whatsapp. If someone renames
	// that route group, the advertised URL silently becomes wrong again.
	src, err := os.ReadFile("../main.go")
	if err != nil {
		t.Skipf("cannot read main.go: %v", err)
	}
	if !strings.Contains(string(src), `r.Route("/api/whatsapp", func(r chi.Router) {`) {
		t.Errorf("main.go no longer mounts the WhatsApp webhook at /api/whatsapp — "+
			"waWebhookPublicPath (%q) is what the setup screen tells people to paste into "+
			"Meta, so it must be updated with the route", waWebhookPublicPath)
	}

	// The public webhook must stay OUTSIDE the authenticated group: Meta sends no JWT,
	// and a webhook behind auth silently receives nothing. The comment above the mount
	// says "no JWT" — this checks the mount is where that claim is true.
	if !strings.Contains(string(src), "WhatsApp inbound webhook (Meta Cloud API — no JWT)") {
		t.Error("the marker comment on the public WhatsApp mount is gone — check the webhook " +
			"is still mounted outside the authenticated router, or Meta's POSTs will 401")
	}
}

// The admin surface must NOT be the public one. It reports which credentials exist and
// can call Meta with the account's own token; mounted beside the webhook it would be
// reachable without a session.
func TestWhatsAppAdminIsNotMountedPublicly(t *testing.T) {
	src, err := os.ReadFile("../main.go")
	if err != nil {
		t.Skipf("cannot read main.go: %v", err)
	}
	text := string(src)
	iPublic := strings.Index(text, `r.Route("/api/whatsapp", func(r chi.Router) {`)
	iAdmin := strings.Index(text, `r.Route("/api/whatsapp-admin", func(r chi.Router) {`)
	if iAdmin < 0 {
		t.Fatal("the WhatsApp admin routes are not mounted at all")
	}
	// The public webhook is mounted early, before the authenticated group; the admin
	// routes sit inside it. If the admin mount ever moves above the public one, it has
	// almost certainly left the authenticated group with it.
	if iAdmin < iPublic {
		t.Error("the WhatsApp admin routes are mounted before the public webhook group — " +
			"check they are still inside the authenticated router")
	}
}

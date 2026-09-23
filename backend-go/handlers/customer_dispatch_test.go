package handlers

import (
	"os"
	"strings"
	"testing"
)

// The failure mode of a misconfigured retention engine is messaging thousands of real
// customers, so the rail has to fail CLOSED. Only the exact string "live" may arm it.
func TestCustomerMessagingFailsClosed(t *testing.T) {
	prev, had := os.LookupEnv("CUSTOMER_MESSAGING_MODE")
	t.Cleanup(func() {
		if had {
			os.Setenv("CUSTOMER_MESSAGING_MODE", prev)
		} else {
			os.Unsetenv("CUSTOMER_MESSAGING_MODE")
		}
	})

	// Every one of these is somebody's plausible attempt to turn it on, and every
	// one of them must NOT send to a customer.
	for _, v := range []string{
		"", " ", "off", "OFF", "no", "false", "0",
		"true", "yes", "1", "on", "enabled", "enable",
		"liv", "lives", "live!", "livemode", "production", "prod",
	} {
		os.Setenv("CUSTOMER_MESSAGING_MODE", v)
		if got := customerSendMode(); got == modeLive {
			t.Errorf("CUSTOMER_MESSAGING_MODE=%q armed the live rail — only an exact "+
				"\"live\" may do that", v)
		}
	}

	// Unset is off, not preview and certainly not live.
	os.Unsetenv("CUSTOMER_MESSAGING_MODE")
	if got := customerSendMode(); got != modeOff {
		t.Errorf("unset CUSTOMER_MESSAGING_MODE = %q, want %q", got, modeOff)
	}

	// And the two that must work, including the whitespace and case a human types.
	for _, v := range []string{"live", "LIVE", " live ", "Live"} {
		os.Setenv("CUSTOMER_MESSAGING_MODE", v)
		if customerSendMode() != modeLive {
			t.Errorf("CUSTOMER_MESSAGING_MODE=%q should be live", v)
		}
	}
	for _, v := range []string{"staff_preview", "preview", "STAFF_PREVIEW"} {
		os.Setenv("CUSTOMER_MESSAGING_MODE", v)
		if customerSendMode() != modePreview {
			t.Errorf("CUSTOMER_MESSAGING_MODE=%q should be preview", v)
		}
	}
}

// One character outside GSM-7 forces the whole message to UCS-2, where a segment is
// 70 characters instead of 160 — so a stray naira sign or em-dash triples the bill
// across a run of thousands. The prose in this codebase is full of both.
func TestSMSCostDiscipline(t *testing.T) {
	plain := "O3 Capital: Hello Ada, your fixed deposit of NGN 5.0m matures in 2 weeks. " +
		"To roll it over or discuss your options, call us on 0201-330-5300. Reply STOP to opt out."
	if !isGSM7(plain) {
		t.Fatalf("the template itself is not GSM-7: %q", plain)
	}
	if got := smsSegments(plain); got > 2 {
		t.Errorf("the maturity template costs %d segments; keep it to 2", got)
	}

	// The two characters that actually bite.
	for _, bad := range []string{"₦250,000", "Hello — goodbye", "it’s ready", "a…b"} {
		if isGSM7(bad) {
			t.Errorf("isGSM7(%q) = true, but it contains a non-GSM-7 character", bad)
		}
		if fixed := customerSMSSafe(bad); !isGSM7(fixed) {
			t.Errorf("customerSMSSafe(%q) = %q, still not GSM-7", bad, fixed)
		}
	}

	// The naira sign must become spelled-out NGN, not be dropped.
	if got := customerSMSSafe("You owe ₦250,000 today"); !strings.Contains(got, "NGN 250,000") {
		t.Errorf("customerSMSSafe lost the currency: %q", got)
	}

	// Segment arithmetic at the boundaries, because this is what gets billed.
	for _, c := range []struct {
		n    int
		want int
	}{{0, 0}, {1, 1}, {160, 1}, {161, 2}, {306, 2}, {307, 3}} {
		body := strings.Repeat("a", c.n)
		if c.n == 0 {
			body = ""
		}
		if got := smsSegments(body); got != c.want {
			t.Errorf("smsSegments(%d GSM-7 chars) = %d, want %d", c.n, got, c.want)
		}
	}
	// UCS-2 halves the budget.
	if got := smsSegments("₦" + strings.Repeat("a", 69)); got != 1 {
		t.Errorf("smsSegments(70 UCS-2 chars) = %d, want 1", got)
	}
	if got := smsSegments("₦" + strings.Repeat("a", 70)); got != 2 {
		t.Errorf("smsSegments(71 UCS-2 chars) = %d, want 2", got)
	}
}

// Every customer SMS we send must carry the opt-out we now actually honour.
func TestJourneyTemplatesCarryTheOptOut(t *testing.T) {
	for _, body := range []string{
		"O3 Capital: Hello Ada, your fixed deposit of NGN 5.0m matures today. " +
			"To roll it over or discuss your options, call us on 0201-330-5300. Reply STOP to opt out.",
		"O3 Capital: Congratulations Ada, your loan is fully repaid. " +
			"Thank you for banking with us. If you need another facility, call 0201-330-5300. Reply STOP to opt out.",
	} {
		if !strings.Contains(strings.ToLower(body), "stop") {
			t.Errorf("template has no opt-out instruction: %q", body)
		}
		if !optOutKeyword("STOP") {
			t.Error("the template promises STOP but optOutKeyword does not honour it")
		}
		if !isGSM7(customerSMSSafe(body)) {
			t.Errorf("template is not GSM-7 after scrubbing: %q", body)
		}
	}
}

func TestFirstNameIsSafeOnJunk(t *testing.T) {
	for in, want := range map[string]string{
		"Ada Lovelace": "Ada", "Ada": "Ada", "": "there", " Ada": "",
	} {
		if got := firstName(in); got != want {
			t.Errorf("firstName(%q) = %q, want %q", in, got, want)
		}
	}
}

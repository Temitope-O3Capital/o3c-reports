package handlers

import (
	"strings"
	"testing"
)

// Reported: an agent clicked a number to dial and the system "refreshed and showed
// another number". The cause was not permissions and not the realtime trigger.
//
// Dialling writes no call row — zohoInitiateCall leaves that to the Zoho Desk sync,
// which backfills it a measured ~24 seconds later. The sync stamps last_called_at,
// and the ready bucket excludes anything called inside the cooldown, so roughly half
// a minute after the click — mid-call — the contact dropped out of the agent's queue
// and the rows below shifted up. Measured on live data: 18 contacts over three days
// had an un-written-up call by their own assigned agent and had already been dropped
// from that agent's ready list.
//
// The rule is now: a contact leaves on the WRITE-UP, not on the dial.

func TestReadyKeepsANumberTheViewerHasNotWrittenUp(t *testing.T) {
	expr := ccReadyExpr(ccCooldownDays, ccExhaustedAttempts, 14)
	for _, want := range []string{
		"hc.agent_id = 14",                // scoped to the viewer, not the whole floor
		"helpdesk_calls",                  // judged on the call row
		"NULLIF(TRIM(hc.notes),'')",       // "written up" = notes…
		"NULLIF(TRIM(hc.disposition),'')", // …or a disposition
		"INTERVAL '12 hours'",             // bounded to the shift
		"hc.merged_into_call_id IS NULL",  // ignore merged legs
		"hc.voided_at IS NULL",            // and voided ones
	} {
		if !strings.Contains(expr, want) {
			t.Errorf("ready expression is missing %q", want)
		}
	}
}

// Without an identified viewer the clause must be omitted entirely rather than
// rendered as "agent_id = 0", which matches nothing yet reads as deliberate.
func TestReadyOmitsTheClauseWithNoViewer(t *testing.T) {
	expr := ccReadyExpr(ccCooldownDays, ccExhaustedAttempts, 0)
	if strings.Contains(expr, "helpdesk_calls") {
		t.Fatal("the write-up clause was emitted with no viewer")
	}
	if strings.Contains(expr, "agent_id = 0") {
		t.Fatal("rendered agent_id = 0, which silently matches nothing")
	}
}

// norm_phone returns ” rather than NULL for an unusable number, so without the
// length guard one blank number matches every other blank number — the trap recorded
// in o3c-phone-normalisation. And it must be norm_phone(), not the inline regexp,
// or neither idx_helpdesk_calls_normphone nor idx_cc_contacts_normphone is used.
func TestReadyPhoneMatchIsGuardedAndIndexable(t *testing.T) {
	expr := ccReadyExpr(ccCooldownDays, ccExhaustedAttempts, 7)
	if !strings.Contains(expr, "length(norm_phone(call_center_contacts.phone)) = 10") {
		t.Error("missing the length guard: blank numbers would match each other")
	}
	if strings.Contains(expr, `regexp_replace`) {
		t.Error("used the inline regexp instead of norm_phone(), losing both indexes")
	}
}

// The cooldown and exhaustion thresholds must come from the constants, so the bucket
// and the is_cooling / is_exhausted badges on each row cannot drift apart.
func TestReadyCarriesTheConfiguredThresholds(t *testing.T) {
	expr := ccReadyExpr(3, 9, 0)
	if !strings.Contains(expr, "INTERVAL '3 days'") {
		t.Error("cooldown was not interpolated")
	}
	if !strings.Contains(expr, "attempts >= 9") {
		t.Error("exhausted-attempts threshold was not interpolated")
	}
}

// A due call-back outranks both the cooldown and the exhaustion rule: the customer
// named a time, and the queue must honour it even on a number that has swallowed
// every attempt without an answer.
func TestADueCallbackIsAlwaysReady(t *testing.T) {
	expr := ccReadyExpr(ccCooldownDays, ccExhaustedAttempts, 0)
	if !strings.HasPrefix(expr, "(callback_at IS NOT NULL AND callback_at <= NOW())") {
		t.Fatalf("a due call-back is no longer the first branch: %q", expr)
	}
}

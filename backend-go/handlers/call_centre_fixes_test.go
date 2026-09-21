package handlers

// Pins the behaviour established by the call-centre review of 17 Sep 2026. Each test
// here stands for a defect that reached production once; the assertion is the thing
// that must not silently revert.

import (
	"os"
	"strings"
	"testing"
)

// The DNC list suppressed nothing for months because six call sites compared phones
// three different ways. One expression now serves them all, and the length()=10 guard
// is the load-bearing half: app.norm_phone returns '' (never NULL) for anything it
// cannot parse, so a bare equality is TRUE when both sides are blank — which would
// suppress every contact with no phone on file.
func TestDNCExpressionNormalisesBothSidesAndGuardsBlank(t *testing.T) {
	expr := ccNotOnDNCExpr("cc.phone")
	if !strings.Contains(expr, "norm_phone(d.phone)") || !strings.Contains(expr, "norm_phone(cc.phone)") {
		t.Errorf("both sides must be normalised:\n%s", expr)
	}
	if !strings.Contains(expr, "length(norm_phone(d.phone)) = 10") {
		t.Errorf("a blank phone must not match a blank phone:\n%s", expr)
	}
	if !strings.Contains(expr, "NOT EXISTS") {
		t.Errorf("suppression must exclude, not merely flag:\n%s", expr)
	}
}

// The queue wrote outcome='completed' whenever a disposition was flagged Connected,
// which inflated the connect rate at the point of writing — no downstream reader could
// correct it.
func TestQueueCallOutcomeIsHonestAboutConnecting(t *testing.T) {
	cases := []struct {
		name string
		disp ccDisposition
		want string
	}{
		{"nobody picked up", ccDisposition{Code: "no_answer", Connected: false}, "no_answer"},
		{"answered then dropped", ccDisposition{Code: "call_dropped", Connected: true}, "no_answer"},
		{"a real conversation", ccDisposition{Code: "answered_interested", Connected: true}, "completed"},
		{"declined, but spoken to", ccDisposition{Code: "answered_not_interested", Connected: true}, "completed"},
	}
	for _, c := range cases {
		if got := ccCallOutcome(c.disp); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

// The inbound webhook decided the outcome from the SESSION length, so a caller who
// heard the greeting, got no answer and hung up at 40s was stored as a 40-second
// conversation. Talk time is NULL unless a conversation actually happened (migration
// 159), and never a value the 4h sanity constraint would reject.
func TestInboundOutcomeUsesTheDialLegNotTheSession(t *testing.T) {
	if out, talk := atDialOutcome("", 40); out != "missed" || talk != nil {
		t.Errorf("hang-up during the greeting: got %q/%v, want missed/nil", out, talk)
	}
	if out, talk := atDialOutcome("NoAnswer", 40); out != "missed" || talk != nil {
		t.Errorf("agent never picked up: got %q/%v, want missed/nil", out, talk)
	}
	if out, talk := atDialOutcome("Completed", 0); out != "completed" || talk != nil {
		t.Errorf("connected but no usable duration: got %q/%v, want completed/nil", out, talk)
	}
	out, talk := atDialOutcome("Completed", 45)
	if out != "completed" || talk == nil || *talk != 45 {
		t.Errorf("real conversation: got %q/%v, want completed/45", out, talk)
	}
	if out, talk := atDialOutcome("Completed", 99999); out != "completed" || talk != nil {
		t.Errorf("over the sanity cap must store unknown, not a rejected value: got %q/%v", out, talk)
	}
}

// Deliberate: this exemption stays. A manually logged queue call has no telephony
// duration and no recording, so with duration_sec now written as NULL it would trip
// the "completed but under 5 seconds with no recording" rule and a genuine four-minute
// conversation would be counted as never connected. The queue writes 'no_answer' for a
// call that did not connect, which the first branch catches regardless.
func TestManualQueueCallsStayExemptFromTheShortCallRule(t *testing.T) {
	expr := callUnansweredExpr("hc.")
	if !strings.Contains(expr, "source_system IS DISTINCT FROM 'call_center'") {
		t.Error("removing this exemption reclassifies every manually logged queue call as unanswered")
	}
	if !strings.Contains(expr, "'missed','no_answer','voicemail'") {
		t.Errorf("an explicit non-connect must still read as unanswered:\n%s", expr)
	}
}

// Recordings were kept forever: the prune worked on file mtime and any click re-pulled
// the audio from the provider. The horizon is one named constant precisely because the
// business has not yet confirmed the number.
func TestRecordingRetentionDefaultsToOneYear(t *testing.T) {
	if os.Getenv("RECORDING_RETENTION_DAYS") != "" {
		t.Skip("overridden in this environment")
	}
	if got := recordingRetentionDays(); got != 365 {
		t.Errorf("default retention: got %d days, want 365", got)
	}
}

// Migration 254 guards validity with length(...)=10 rather than IS NOT NULL. The first
// draft used IS NOT NULL, which is ALWAYS true for app.norm_phone — it would have
// linked every blank-phone contact to a blank-phone lead and collided '' rows on the
// unique index.
func TestMigration254GuardsBlankPhonesCorrectly(t *testing.T) {
	raw, err := os.ReadFile("../migrations/254_call_centre_review_fixes.sql")
	if err != nil {
		t.Fatal(err)
	}
	sql := string(raw)
	if !strings.Contains(sql, "length(app.norm_phone(") {
		t.Error("validity must be tested by length, since norm_phone returns '' not NULL")
	}
	if strings.Contains(sql, "app.norm_phone(phone) IS NOT NULL") ||
		strings.Contains(sql, "app.norm_phone(c.phone) IS NOT NULL") {
		t.Error("IS NOT NULL is always true here — blank would match blank")
	}
	for _, needed := range []string{
		"uq_dnc_list_norm_phone",                   // one canonical form, enforced
		"call_center_leads_status_chk",             // a typo can no longer hide a lead
		"call_center_dispositions_subject_chk",     // a disposition always names someone
		"DROP INDEX IF EXISTS app.idx_hd_calls_zoho_id", // duplicate index
	} {
		if !strings.Contains(sql, needed) {
			t.Errorf("migration 254 no longer contains %q", needed)
		}
	}
}

// The NDPR erasure worker keyed its customers UPDATE on cif_number, a column
// app.customers has never had. A failed statement writes none of its columns, and the
// error was logged as a warning — so every erasure request ever processed left the
// customer's name, phone, email and BVN in place while reporting success. Nothing
// asserted the column name, which is exactly why it survived. This is that assertion.
func TestErasureAnonymisesCustomersOnTheRealKey(t *testing.T) {
	raw, err := os.ReadFile("compliance.go")
	if err != nil {
		t.Fatal(err)
	}
	src := string(raw)
	i := strings.Index(src, "UPDATE customers")
	if i < 0 {
		t.Fatal("the erasure worker no longer updates customers at all")
	}
	// Wide enough to span the statement, its error branch and the log call that follows.
	stmt := src[i:min(i+900, len(src))]
	if !strings.Contains(stmt, "WHERE cif = $1") {
		t.Errorf("customers is keyed on `cif`; anything else silently erases nothing:\n%s", stmt)
	}
	if strings.Contains(stmt, "cif_number") {
		t.Errorf("app.customers has no cif_number column — this statement cannot run:\n%s", stmt)
	}
	// A failure here means a data-subject request completed without erasing anything, so
	// it must never read as routine again. Matched on the call itself, not on prose —
	// a bare "NOT anonymised" would also match the comment above it, and would then keep
	// passing if the logging were removed entirely.
	if !strings.Contains(stmt, `slog.Error("ndpr_erasure: customer record NOT anonymised`) {
		t.Errorf("a failed customer erasure must be logged at Error and say so plainly:\n%s", stmt)
	}
}

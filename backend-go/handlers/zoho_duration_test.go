package handlers

import "testing"

// The Voice API is not versioned in this integration and has returned durations
// both as a number of seconds and as a clock string. Every unreadable shape must
// come back as 0 ("unknown"), because 0 makes the caller fall back to the old
// time-only matching — whereas a wrongly-parsed number would confidently attach a
// recording to the wrong call and overwrite a good duration with a bad one.
func TestParseDurationValue(t *testing.T) {
	cases := []struct {
		in   any
		want int
		why  string
	}{
		{float64(312), 312, "JSON numbers decode as float64"},
		{312, 312, "plain int"},
		{int64(312), 312, "int64"},
		{"312", 312, "seconds as a string"},
		{"05:12", 312, "mm:ss"},
		{"01:05:12", 3912, "hh:mm:ss"},
		{" 05:12 ", 312, "surrounding whitespace"},

		// Unreadable or implausible → 0, never a guess.
		{"", 0, "empty"},
		{nil, 0, "nil"},
		{"abc", 0, "not a number"},
		{"05:ab", 0, "partly unparseable"},
		{"1:2:3:4", 0, "too many segments"},
		{float64(0), 0, "zero is not a duration"},
		{float64(-5), 0, "negative"},
		// Above the column's own 4-hour sanity cap.
		{float64(20000), 0, "beyond helpdesk_calls_duration_sane_chk"},
	}
	for _, c := range cases {
		if got := parseDurationValue(c.in); got != c.want {
			t.Errorf("parseDurationValue(%#v) = %d, want %d (%s)", c.in, got, c.want, c.why)
		}
	}
}

// The reader must tolerate the key the payload actually uses, and must not treat
// a missing duration as an error.
func TestZohoCallDuration(t *testing.T) {
	for _, key := range []string{"call_duration", "duration", "callduration", "billing_duration"} {
		if got := zohoCallDuration(map[string]any{key: float64(548)}); got != 548 {
			t.Errorf("key %q: got %d, want 548", key, got)
		}
	}
	if got := zohoCallDuration(map[string]any{"unrelated": "x"}); got != 0 {
		t.Errorf("absent duration should read 0, got %d", got)
	}
	if got := zohoCallDuration(map[string]any{"call_duration": nil}); got != 0 {
		t.Errorf("nil duration should read 0, got %d", got)
	}
	// The first readable key wins; an unreadable one must not stop the search.
	got := zohoCallDuration(map[string]any{"call_duration": "junk", "duration": float64(90)})
	if got != 90 {
		t.Errorf("fell over on an unreadable first key: got %d, want 90", got)
	}
}

package handlers

import (
	"testing"
	"time"
)

// Zoho's call timestamps are genuine UTC and are taken at face value.
//
// This test exists because of a mistake worth not repeating. On 2026-08-18 the
// Desk API returned startTime "2026-08-18T13:34:18.000Z" while this server's
// clock read 12:40 UTC — so the call appeared to be 54 minutes in the future, and
// 246 of that day's calls looked similarly impossible. The conclusion drawn was
// that Zoho sends local wall-clock labelled as UTC, and every timestamp was
// shifted back an hour.
//
// The premise was wrong. The SERVER clock was running ~55 minutes slow; the logs
// show it jumping back (13:54 → 12:58) and later forward again by 55 minutes.
// Zoho was correct throughout. The shift corrupted 111,355 rows before it was
// caught, and migration 168 reversed it.
//
// The lesson is in the method, not the timezone: an external timestamp can only
// be judged against a clock you have independently verified.
func TestZohoTimestampsAreTakenAsUTC(t *testing.T) {
	got := zohoParseTime("2026-08-18T13:34:18.000Z")
	if got.IsZero() {
		t.Fatal("failed to parse a well-formed Zoho timestamp")
	}
	if want := time.Date(2026, 8, 18, 13, 34, 18, 0, time.UTC); !got.Equal(want) {
		t.Errorf("startTime parsed to %v, want %v — Zoho sends real UTC and it must "+
			"not be re-interpreted", got.UTC(), want)
	}

	// Voice epoch millis are the same instant, so Desk and Voice agree and a
	// recording can pair with its call inside the ±180s window.
	v := zohoParseMillisTime("1787059853000")
	if want := time.UnixMilli(1787059853000); !v.Equal(want) {
		t.Errorf("Voice start_time parsed to %v, want %v", v.UTC(), want.UTC())
	}
	desk := zohoParseTime(time.UnixMilli(1787059853000).UTC().Format("2006-01-02T15:04:05.000Z"))
	if d := desk.Sub(v); d != 0 {
		t.Errorf("Desk and Voice disagree by %v for the same instant — recordings "+
			"would never attach", d)
	}
}

func TestZohoParseHandlesJunk(t *testing.T) {
	for _, bad := range []any{"", "not-a-time", nil, "0"} {
		if got := zohoParseTime(bad); !got.IsZero() {
			t.Errorf("zohoParseTime(%#v) = %v, want zero", bad, got)
		}
	}
	for _, bad := range []any{"", "abc", "0", "-5"} {
		if got := zohoParseMillisTime(bad); !got.IsZero() {
			t.Errorf("zohoParseMillisTime(%#v) = %v, want zero", bad, got)
		}
	}
}

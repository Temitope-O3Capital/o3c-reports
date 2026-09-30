package handlers

import "testing"

// Phone shapes taken from the live arrears book on 2026-09-30, where 260 of 558 numbers
// were the ten-digit form the old normaliser could not handle.
func TestNormalizeTermiiPhoneHandlesTheRealShapes(t *testing.T) {
	ok := map[string]string{
		// The 47% case: leading zero already stripped upstream.
		"8059342861":     "2348059342861",
		"9038139295":     "2349038139295",
		"7031234567":     "2347031234567",
		// Local 11-digit.
		"08058955363":    "2348058955363",
		"08012345678":    "2348012345678",
		"09038139295":    "2349038139295",
		// Already international, with and without decoration.
		"2348012345678":  "2348012345678",
		"+2348012345678": "2348012345678",
		"+234 805 895 5363": "2348058955363",
		"0805-895-5363":  "2348058955363",
		" 08058955363 ":  "2348058955363",
		"(0805) 895 5363": "2348058955363",
		// Country code with the local zero left on.
		"23408058955363": "2348058955363",
	}
	for in, want := range ok {
		if got := normalizeTermiiPhone(in); got != want {
			t.Errorf("normalizeTermiiPhone(%q) = %q, want %q", in, got, want)
		}
	}
}

// Refusing is the point: the old version returned anything 7 characters or longer, so
// these were sent to Termii and billed. Every one of them is in the live book.
func TestNormalizeTermiiPhoneRefusesJunk(t *testing.T) {
	for _, in := range []string{
		"7212399",    // 7 digits
		"80000",      // 5 digits
		"8000000",    // 7 digits
		"802523260",  // 9 digits, one short
		"815232791",  // 9 digits, one short
		"6298887439", // 10 digits but 6 is not a Nigerian mobile prefix
		"",
		"   ",
		"abcdefghij",
		"0",
	} {
		if got := normalizeTermiiPhone(in); got != "" {
			t.Errorf("normalizeTermiiPhone(%q) = %q, want it refused", in, got)
		}
	}
}

// A ten-digit number starting 0 is not a Nigerian mobile missing its zero, it is
// simply wrong, and prefixing 234 would invent a destination.
func TestNormalizeTermiiPhoneDoesNotInventNumbers(t *testing.T) {
	if got := normalizeTermiiPhone("0805895536"); got != "" {
		t.Errorf("a 10-digit number starting 0 should be refused, got %q", got)
	}
}

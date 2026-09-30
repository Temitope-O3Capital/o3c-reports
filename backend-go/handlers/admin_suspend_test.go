package handlers

import (
	"strings"
	"testing"
)

// A code shorter than requested is the failure that matters here. rand.Int can legitimately
// return 7, and "7" instead of "000007" is a code the user cannot type into a 6-box field and
// a bcrypt hash of the wrong string. One in ten codes loses at least one leading digit, so an
// unpadded implementation looks fine in casual testing and fails in production within the day.
func TestGenNumericCodeIsAlwaysFullLength(t *testing.T) {
	for _, digits := range []int{4, 6} {
		for i := 0; i < 2000; i++ {
			code, err := genNumericCode(digits)
			if err != nil {
				t.Fatalf("genNumericCode(%d): %v", digits, err)
			}
			if len(code) != digits {
				t.Fatalf("genNumericCode(%d) = %q, want %d characters", digits, code, digits)
			}
			if strings.Trim(code, "0123456789") != "" {
				t.Fatalf("genNumericCode(%d) = %q, want decimal digits only", digits, code)
			}
		}
	}
}

// The whole security argument for a 6-digit code rests on it being unguessable, so assert the
// generator actually varies. A stub returning a constant would satisfy every check above.
func TestGenNumericCodeVaries(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 500; i++ {
		code, err := genNumericCode(6)
		if err != nil {
			t.Fatalf("genNumericCode: %v", err)
		}
		seen[code] = true
	}
	// 500 draws from a million values: a collision or two is unremarkable, but anything
	// under 450 distinct means the source is not behaving like a uniform random one.
	if len(seen) < 450 {
		t.Fatalf("500 codes produced only %d distinct values — the source is not random enough", len(seen))
	}
}

// Both lengths must reach the top of their range, which is what catches an off-by-one in the
// upper bound (a loop that multiplies one time too few makes every 6-digit code a 5-digit one
// with a leading zero, and the length check above would still pass).
func TestGenNumericCodeUsesTheWholeRange(t *testing.T) {
	for _, tc := range []struct{ digits int }{{4}, {6}} {
		sawLeadingNonZero := false
		for i := 0; i < 2000 && !sawLeadingNonZero; i++ {
			code, err := genNumericCode(tc.digits)
			if err != nil {
				t.Fatalf("genNumericCode: %v", err)
			}
			if code[0] != '0' {
				sawLeadingNonZero = true
			}
		}
		if !sawLeadingNonZero {
			t.Fatalf("every %d-digit code started with 0 — the upper bound is one power of ten short", tc.digits)
		}
	}
}

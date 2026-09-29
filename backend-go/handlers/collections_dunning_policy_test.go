package handlers

import "testing"

// The arrears-reminder policy, pinned.
//
// These constants decide who receives a written demand for money, so they are worth
// more than a comment. Measured on the live book 2026-09-29: 909 delinquent facilities,
// 870 people, ₦2.19bn — and the selection, ordered by DPD descending with no floor,
// would have opened with a ₦5.00 balance 2,048 days past due.

func TestMaterialityFloorIsAThousandNaira(t *testing.T) {
	// 242 of 909 facilities sit under ₦1,000 and hold ₦14,942 between them. Chasing
	// them spends a relationship to recover a rounding error.
	if dunningDefaultMinKobo != 100_000 {
		t.Errorf("the floor is ₦1,000 = 100,000 kobo; got %d kobo (₦%.2f)",
			dunningDefaultMinKobo, float64(dunningDefaultMinKobo)/100)
	}
	// Kobo, not naira. Getting this wrong by 100x would either chase ₦5 debts again or
	// silence the book below ₦100,000.
	if dunningDefaultMinKobo/100 != 1000 {
		t.Errorf("expected ₦1,000, got ₦%d", dunningDefaultMinKobo/100)
	}
}

func TestFreshnessWindowMatchesTheCollectableBand(t *testing.T) {
	// 450 facilities are inside 90 days and hold ₦1.08bn — the band where a reminder
	// is the right instrument. It orders the queue; it does not exclude anyone.
	if dunningDefaultFreshDays != 90 {
		t.Errorf("freshness window should be 90 days; got %d", dunningDefaultFreshDays)
	}
}

// dunningIntSetting is the gate every one of these passes through. A typo in a config
// value must never widen who gets chased.
func TestABadSettingFallsBackToTheDefaultNotToNoLimit(t *testing.T) {
	cases := []struct {
		name, raw string
		def       int
		allowZero bool
		want      int
	}{
		{"empty uses default", "", 100, false, 100},
		{"garbage uses default", "many", 100, false, 100},
		{"negative uses default", "-5", 100, false, 100},
		{"zero is rejected where zero is meaningless", "0", 100, false, 100},
		{"zero is honoured where zero means off", "0", 0, true, 0},
		{"a real value wins", "25", 100, false, 25},
		{"whitespace is trimmed", "  7  ", 100, false, 7},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := dunningParseSetting(c.raw, c.def, c.allowZero); got != c.want {
				t.Errorf("%q with default %d → %d, want %d", c.raw, c.def, got, c.want)
			}
		})
	}
}

// The upper age bound defaults to OFF on purpose. Skipping a ₦5 balance forgoes ₦5;
// excluding everything past three years would withhold every reminder from 140
// facilities holding ₦392m of owed money. That is a decision about whether to pursue a
// debt, and it belongs to Collections rather than to a default in a source file.
func TestAgeBoundIsOffUntilCollectionsSetsIt(t *testing.T) {
	if got := dunningParseSetting("", 0, true); got != 0 {
		t.Errorf("unset max DPD must mean no bound; got %d", got)
	}
	if got := dunningParseSetting("1095", 0, true); got != 1095 {
		t.Errorf("Collections must be able to set a bound; got %d", got)
	}
}

package handlers

import "testing"

// Dollar-card volume must never reach a naira total: CCS posts USD cards in
// dollars, so adding it would count $1 as ₦1.
func TestMonthlyRowTotalExcludesUSD(t *testing.T) {
	m := monthlyRow{ATM: 1, POS: 2, WEB: 3, Bills: 4, Repayment: 5, Fees: 6, Other: 7, USD: 1_000_000}
	m.sumTotal()
	if m.Total != 28 {
		t.Fatalf("Total = %d, want 28 (USD must be excluded)", m.Total)
	}
}

func TestBucketValuesMatchBucketKeys(t *testing.T) {
	if got := len(monthlyRow{}.bucketValues()); got != len(iswBuckets) {
		t.Fatalf("bucketValues has %d entries, iswBuckets has %d", got, len(iswBuckets))
	}
}

func TestComputeTotals(t *testing.T) {
	months := []monthlyRow{
		{Month: "January", ATM: 100, POS: 300, Bills: 600, USD: 50},
		{Month: "February", ATM: 100, POS: 100, Other: 800, USD: 150},
	}
	for i := range months {
		months[i].sumTotal()
	}
	got := computeTotals(months)

	wantInt := map[string]int64{
		"atm": 200, "pos": 400, "bills": 600, "other": 800, "web": 0,
		"total": 2000, "atm_avg": 100, "other_avg": 400,
		"usd": 200, "usd_avg": 100,
	}
	for k, want := range wantInt {
		if v, _ := got[k].(int64); v != want {
			t.Errorf("%s = %v, want %d", k, got[k], want)
		}
	}
	wantPct := map[string]float64{"atm_pct": 10, "pos_pct": 20, "bills_pct": 30, "other_pct": 40, "fees_pct": 0}
	for k, want := range wantPct {
		if v, _ := got[k].(float64); v != want {
			t.Errorf("%s = %v, want %v", k, got[k], want)
		}
	}
}

// An empty period must still carry every key the report page reads.
func TestComputeTotalsEmptyHasEveryKey(t *testing.T) {
	got := computeTotals(nil)
	keys := []string{"total", "usd", "usd_avg"}
	for _, b := range iswBuckets {
		keys = append(keys, b, b+"_pct", b+"_avg")
	}
	for _, k := range keys {
		if _, ok := got[k]; !ok {
			t.Errorf("missing key %q", k)
		}
	}
}

// The static fallback carries the source report's residual column as Other, and
// its totals must still reconcile to that report's published monthly figures.
func TestStaticFallbackReconciles(t *testing.T) {
	want := map[string]int64{"January": 13_285_555_347, "May": 47_718_923_094}
	for _, m := range selectPeriod(baseMonths, "H1") {
		m.sumTotal()
		if w, ok := want[m.Month]; ok && m.Total != w {
			t.Errorf("%s total = %d, want %d", m.Month, m.Total, w)
		}
	}
}

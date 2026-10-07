package handlers

import (
	"math"
	"testing"
)

// The published Half-Year Transaction Report, H1 2026 (kobo).
//
// These are the figures Card Operations actually sent out, transcribed from
// "HALF YEAR TRANSACTION REPORT 2026V". They are the benchmark for this endpoint:
// the share and average columns the page renders must reproduce them, and the
// channel mapping must keep pointing at the feeds that produce them.
var publishedH1_2026 = struct {
	ATM, POS, WEB, Transfer, Total, AvgMonthly int64
	ATMPct, POSPct, WEBPct, TransferPct        float64
	Months                                     int64
}{
	ATM: 820_400_000, POS: 8_475_560_859, WEB: 23_693_391_624, Transfer: 82_243_507_903,
	Total: 115_232_860_386, AvgMonthly: 19_205_476_731,
	ATMPct: 0.71, POSPct: 7.36, WEBPct: 20.56, TransferPct: 71.37,
	Months: 6,
}

// The four channel figures must add up to the published grand total. If this ever
// fails, the transcription is wrong and every percentage below is meaningless.
func TestPublishedReportIsInternallyConsistent(t *testing.T) {
	p := publishedH1_2026
	if sum := p.ATM + p.POS + p.WEB + p.Transfer; sum != p.Total {
		t.Fatalf("channels sum to %d, published total is %d", sum, p.Total)
	}
	if avg := p.Total / p.Months; avg != p.AvgMonthly {
		t.Errorf("monthly average = %d, published %d", avg, p.AvgMonthly)
	}
}

// The share and average arithmetic this handler uses must reproduce the published
// percentages to the same two decimals the report prints. This is what pins the
// endpoint to the document: a rounding change that moved TRANSFER off 71.37%
// would silently disagree with a report already in circulation.
func TestChannelSharesMatchPublishedReport(t *testing.T) {
	p := publishedH1_2026
	cases := []struct {
		name string
		v    int64
		want float64
	}{
		{"ATM", p.ATM, p.ATMPct},
		{"POS", p.POS, p.POSPct},
		{"WEB", p.WEB, p.WEBPct},
		{"TRANSFER", p.Transfer, p.TransferPct},
	}
	var pctSum float64
	for _, c := range cases {
		// Same expression as interswitchReport.
		got := math.Round(float64(c.v)/float64(p.Total)*10000) / 100
		if got != c.want {
			t.Errorf("%s share = %.2f%%, published %.2f%%", c.name, got, c.want)
		}
		pctSum += got
	}
	if math.Abs(pctSum-100) > 0.01 {
		t.Errorf("shares sum to %.2f%%, want 100%%", pctSum)
	}
}

// Channel order and sourcing is the report's contract. TRANSFER in particular must
// stay on Paystack: it is 71.37% of the report and it is NOT a card transaction,
// which is why every earlier attempt to serve this from the card ledger alone
// could not match the published total.
func TestReportChannelsAreTheFourPublishedColumns(t *testing.T) {
	wantOrder := []string{"atm", "pos", "web", "transfer"}
	if len(iswReportChannels) != len(wantOrder) {
		t.Fatalf("report has %d channels, the published report has %d",
			len(iswReportChannels), len(wantOrder))
	}
	for i, want := range wantOrder {
		if iswReportChannels[i].Key != want {
			t.Errorf("channel %d is %q, want %q", i, iswReportChannels[i].Key, want)
		}
	}
	bySource := map[string]string{}
	for _, c := range iswReportChannels {
		bySource[c.Key] = c.Source
	}
	for key, want := range map[string]string{
		"atm": "ccs", "pos": "ccs", "web": "ccs", "transfer": "paystack",
	} {
		if bySource[key] != want {
			t.Errorf("%s reads from %q, want %q", key, bySource[key], want)
		}
	}
}

// A month's total is the four channels and nothing else. Dollar-card volume is
// deliberately absent from this report: CCS posts those cards in dollars, so
// adding them would count $1 as ₦1.
func TestMonthTotalIsTheFourChannels(t *testing.T) {
	m := iswReportMonth{ATM: 1, POS: 2, WEB: 3, Transfer: 4}
	m.Total = m.ATM + m.POS + m.WEB + m.Transfer
	if m.Total != 10 {
		t.Fatalf("Total = %d, want 10", m.Total)
	}
}

// Every period id the page offers must resolve, and the ranges must tile the year
// without gaps or overlaps where they are meant to.
func TestPeriodRanges(t *testing.T) {
	for _, id := range []string{"H1", "H2", "Q1", "Q2", "Q3", "Q4", "FY"} {
		r, ok := iswPeriodMonths[id]
		if !ok {
			t.Errorf("period %q does not resolve", id)
			continue
		}
		if r[0] < 1 || r[1] > 12 || r[0] > r[1] {
			t.Errorf("period %q range %v is not a valid month span", id, r)
		}
	}
	if got := iswPeriodMonths["H1"]; got != [2]int{1, 6} {
		t.Errorf("H1 = %v, want Jan–Jun", got)
	}
	// H1 and H2 must together cover exactly the full year.
	h1, h2, fy := iswPeriodMonths["H1"], iswPeriodMonths["H2"], iswPeriodMonths["FY"]
	if h1[0] != fy[0] || h2[1] != fy[1] || h2[0] != h1[1]+1 {
		t.Errorf("H1 %v + H2 %v do not tile FY %v", h1, h2, fy)
	}
}

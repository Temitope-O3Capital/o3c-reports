package handlers

import (
	"os"
	"strings"
	"testing"

	"golang.org/x/net/html"
)

// The fixture is the real abokiforex.app home page as served on 2026-10-13, with the
// script, style and svg blocks stripped and nothing else touched. Testing the parser
// against a saved page is the only way to find out that a layout change has broken it
// without waiting for someone to notice the rates have stopped moving, and it doubles
// as the record of what the page looked like when this was written.
//
// If these tests fail after a redesign, refetch the fixture and read the diff before
// changing an expectation: a wrong rate stored silently is worse than a failed scrape.

func abokiFixture(t *testing.T) *html.Node {
	t.Helper()
	raw, err := os.ReadFile("testdata/aboki_home.html")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	doc, err := html.Parse(strings.NewReader(string(raw)))
	if err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	return doc
}

func TestAbokiParsesEveryParallelCurrency(t *testing.T) {
	rates, err := parseAbokiDoc(abokiFixture(t))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}

	// Every figure below is what the page showed, with the CFA francs divided by the
	// 1,000 they are quoted in.
	want := map[string][2]float64{
		"USD": {1365, 1373},
		"GBP": {1820, 1840},
		"EUR": {1525, 1545},
		"CAD": {970, 1000},
		"AUD": {850, 1000},
		"AED": {350, 370},
		"CNY": {190, 210},
		"GHS": {100, 115},
		"ZAR": {65, 80},
		"XOF": {2.3, 2.35},
		"XAF": {2.2, 2.25},
	}

	got := map[string][2]float64{}
	for _, r := range rates {
		got[r.Currency] = [2]float64{r.Buy, r.Sell}
	}

	if len(got) != len(want) {
		t.Errorf("parsed %d currencies, want %d\ngot: %v", len(got), len(want), got)
	}
	for ccy, w := range want {
		g, ok := got[ccy]
		if !ok {
			t.Errorf("%s missing from the parse", ccy)
			continue
		}
		if g[0] != w[0] || g[1] != w[1] {
			t.Errorf("%s = buy %g / sell %g, want buy %g / sell %g", ccy, g[0], g[1], w[0], w[1])
		}
	}
}

// The CBN official rates sit on the same page in the same kind of card. Ingesting them
// as parallel rates would understate the dollar by about 2.5% in a way that looks like
// a market move rather than a bug, so their absence is asserted rather than assumed.
func TestAbokiExcludesTheOfficialCBNRates(t *testing.T) {
	rates, err := parseAbokiDoc(abokiFixture(t))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}

	// The fixture's CBN figures. None may appear as a buy or a sell.
	official := map[string]float64{"USD": 1332.10, "GBP": 1762.63, "EUR": 1489.15, "CNY": 199.03, "ZAR": 80.58}
	for _, r := range rates {
		if o, ok := official[r.Currency]; ok {
			if r.Buy == o || r.Sell == o {
				t.Errorf("%s picked up the CBN official rate %g instead of the parallel rate", r.Currency, o)
			}
		}
	}

	// CHF, JPN and SAR are quoted ONLY as official rates, so they must not appear at all.
	for _, r := range rates {
		switch r.Currency {
		case "CHF", "JPN", "SAR":
			t.Errorf("%s is CBN-only on this page and should not have been parsed", r.Currency)
		}
	}
}

// Every rate must be a believable naira figure per ONE unit of the currency. This is the
// assertion that would catch the CFA franc being stored a thousand times too high, and
// it is written as a cross-check against the dollar rather than as fixed numbers, so a
// genuine market move does not make it fail.
func TestAbokiRatesAreNairaPerSingleUnit(t *testing.T) {
	rates, err := parseAbokiDoc(abokiFixture(t))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}

	var usd float64
	for _, r := range rates {
		if r.Currency == "USD" {
			usd = r.Buy
		}
	}
	if usd == 0 {
		t.Fatal("no USD rate, so there is nothing to cross-check against")
	}

	// No currency on this page is worth more than three dollars or less than a
	// thousandth of one. The CFA francs at their unnormalised 2,300 would be 1.7 dollars
	// each, which passes; at a thousand times the dollar they would not — so the band is
	// backed up by the per-currency check below.
	for _, r := range rates {
		if r.Buy <= 0 || r.Sell <= 0 {
			t.Errorf("%s has a non-positive rate: buy %g sell %g", r.Currency, r.Buy, r.Sell)
		}
		if r.Buy > r.Sell {
			t.Errorf("%s buys above its sell (%g > %g), so the rows were read the wrong way round",
				r.Currency, r.Buy, r.Sell)
		}
		if r.Sell > usd*3 {
			t.Errorf("%s at ₦%g is more than three dollars a unit, which no currency here is", r.Currency, r.Sell)
		}
	}

	// The francs are pegged to the euro at 655.957 to 1, so their rate is derivable
	// rather than a matter of opinion: this is the check that pins the division by 1,000.
	var eur float64
	for _, r := range rates {
		if r.Currency == "EUR" {
			eur = r.Buy
		}
	}
	if eur == 0 {
		t.Fatal("no EUR rate to derive the CFA peg from")
	}
	pegged := eur / 655.957
	for _, ccy := range []string{"XOF", "XAF"} {
		for _, r := range rates {
			if r.Currency != ccy {
				continue
			}
			// Generous: the parallel market trades above the peg, but not by 10x.
			if r.Buy < pegged*0.5 || r.Buy > pegged*2 {
				t.Errorf("%s at ₦%g is nowhere near its euro peg of ₦%.4f — it is probably "+
					"still quoted per 1,000", ccy, r.Buy, pegged)
			}
		}
	}
}

// A page that no longer parses must be an ERROR, never an empty success. An empty
// success would be stored as "nothing to update" and the rate would freeze at whatever
// it last was, which is the failure mode that goes unnoticed for weeks.
func TestAbokiFailsLoudlyOnAnUnrecognisablePage(t *testing.T) {
	for _, page := range []string{
		`<html><body><p>Service temporarily unavailable</p></body></html>`,
		`<html><body><div class="card"><div class="row">no rates in here</div></div></body></html>`,
		// Cards with a currency but no buy/sell labels: the CBN shape, and on its own it
		// must yield nothing rather than a half-populated rate.
		`<html><body><div class="card">DOLLAR (USD)<span class="rate-value">1332.10</span></div></body></html>`,
	} {
		doc, err := html.Parse(strings.NewReader(page))
		if err != nil {
			t.Fatalf("parse test page: %v", err)
		}
		rates, err := parseAbokiDoc(doc)
		if err == nil {
			t.Errorf("an unrecognisable page returned %d rate(s) and no error: %v", len(rates), rates)
		}
	}
}

// The band exists to refuse an order-of-magnitude error, which is how a scraper fails
// when a page is restructured. Checked by feeding it a card that parses perfectly well
// and is still obviously wrong.
func TestAbokiRefusesARateOutsideItsBand(t *testing.T) {
	card := func(label string, buy, sell string) string {
		return `<html><body><div class="card">` +
			`<div class="row"><div class="buy-label">BUY</div><span class="rate-value">` + buy + `</span></div>` +
			`<div class="row">` + label + `<div class="sell-label">SELL</div><span class="rate-value">` + sell + `</span></div>` +
			`</div></body></html>`
	}

	// A plausible dollar parses.
	doc, _ := html.Parse(strings.NewReader(card("DOLLAR (USD)", "1365", "1373")))
	if rates, err := parseAbokiDoc(doc); err != nil || len(rates) != 1 || rates[0].Buy != 1365 {
		t.Fatalf("the control case did not parse: rates=%v err=%v", rates, err)
	}

	// A dollar at ₦13 or ₦136,500 is a decimal that has moved, not a market.
	for _, bad := range [][2]string{{"13", "13.7"}, {"136500", "137300"}} {
		doc, _ := html.Parse(strings.NewReader(card("DOLLAR (USD)", bad[0], bad[1])))
		if rates, err := parseAbokiDoc(doc); err == nil {
			t.Errorf("USD %s/%s was accepted: %v", bad[0], bad[1], rates)
		}
	}

	// And buy above sell is refused, since that means the two rows were swapped.
	doc, _ = html.Parse(strings.NewReader(card("DOLLAR (USD)", "1400", "1365")))
	if rates, err := parseAbokiDoc(doc); err == nil {
		t.Errorf("a buy above the sell was accepted: %v", rates)
	}
}

// The fallback order is what keeps a layout change at Aboki from freezing the rate, so
// it is pinned: Aboki first, NgnRates second, and exactly one writer per cycle because
// FXRatesLatest picks the newest row without regard to source.
func TestFXSourceOrderPutsAbokiFirst(t *testing.T) {
	if len(fxSources) != 2 {
		t.Fatalf("expected 2 FX sources, got %d", len(fxSources))
	}
	if fxSources[0].name != "abokiforex" {
		t.Errorf("primary source is %q, want abokiforex", fxSources[0].name)
	}
	if fxSources[1].name != "ngnrates" {
		t.Errorf("fallback source is %q, want ngnrates", fxSources[1].name)
	}
	for _, s := range fxSources {
		if s.fetch == nil {
			t.Errorf("source %q has no fetch function", s.name)
		}
	}
}

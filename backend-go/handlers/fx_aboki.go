package handlers

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"golang.org/x/net/html"
)

// Aboki Forex is the parallel-market rate source: https://abokiforex.app/
//
// WHY IT REPLACED NgnRates. NgnRates carries three currencies. Aboki carries eleven and
// updates hourly, and on the currencies both quote they agree closely — on the day of
// the switch NgnRates had USD 1365/1375 against Aboki's 1365/1373. So this is a wider
// feed rather than a different opinion.
//
// THE PAGE. An Astro build, server-rendered, no JSON payload to read: the rates are in
// the markup. Each parallel-market currency is a card of two rows:
//
//	<div class="card ...">
//	  <a href="/dollar-to-naira-black-market">...</a>
//	  <div class="row ...">
//	    <div class="col-4"><img alt="Dollar currency"></div>
//	    <div class="col-3 buy-label">BUY</div>
//	    <div class="col-5"><span class="naira-symbol">₦</span><span class="rate-value">1365</span></div>
//	  </div>
//	  <div class="row ...">
//	    <div class="col-4 text-start">DOLLAR (USD)</div>
//	    <div class="col-3 sell-label">SELL</div>
//	    <div class="col-5">...<span class="rate-value">1373</span></div>
//	  </div>
//	</div>
//
// Parsing keys off the class names buy-label, sell-label and rate-value, and reads the
// ISO code from the "(USD)" in the card's own text. It does NOT key off the href, which
// is what the abandoned parser in fx-scraper/ did: it looked for "/usd-to-naira" while
// the site uses "/dollar-to-naira-black-market", so it matched nothing and would have
// returned "no rates parsed" every run. That parser has never written a row.
//
// THE CBN CARDS ARE DELIBERATELY EXCLUDED. The same page carries a second set of cards
// for the official CBN rate — USD 1332.10 against the parallel 1365 — with a single mid
// figure and no BUY or SELL. Requiring both a buy-label and a sell-label is what keeps
// them out. Storing an official rate in a column every other row reads as parallel
// would mean a 2.5% error that looks like a market move, so the official rates need
// their own column before they can be ingested at all.

const abokiURL = "https://abokiforex.app/"

// abokiQuote is how Aboki quotes one currency, and what counts as a believable rate.
type abokiQuote struct {
	// perUnits is how many units of the foreign currency the figure on the card refers
	// to. One for everything except the CFA francs — see the comment on the table.
	perUnits float64
	// min and max bracket a plausible naira-per-unit rate. These are ORDER-OF-MAGNITUDE
	// guards, not forecasts: they exist to refuse a rate that is out by a factor of ten
	// or a thousand, which is the way a scraper fails when a page is restructured. Wide
	// on purpose, so a real market move never trips them and they never need revising.
	min, max float64
}

// The currencies Aboki quotes on the parallel market, with the unit each is quoted in.
//
// XOF AND XAF ARE QUOTED PER 1,000, and getting that wrong would be a thousand-fold
// error in every conversion that touched them. Aboki's own FAQ text on the XOF page
// states "2300 Naira per 1 XOF", and that is simply wrong — one CFA franc is not worth
// more than a pound. Three things say so:
//
//   - the CBN section of the same page quotes XOF at 2.27;
//   - both francs are pegged to the euro at 655.957 to 1, so with the euro at ₦1,525 a
//     franc is ₦2.32, and ₦2,325 per thousand sits exactly inside the 2300/2350 card;
//   - every other currency on the page cross-checks per-unit against USD to within a
//     percent or two, and these two are out by three orders of magnitude.
//
// So the card figure is divided by 1,000 to store naira-per-unit, which is what the buy
// and sell columns mean for every other currency. The min/max band is the safety net: if
// Aboki ever restates these per-unit, the normalised figure falls far outside the band
// and the currency is refused with a log line rather than silently stored at 1/1000th.
var abokiQuotes = map[string]abokiQuote{
	"USD": {perUnits: 1, min: 300, max: 10000},
	"GBP": {perUnits: 1, min: 400, max: 14000},
	"EUR": {perUnits: 1, min: 350, max: 12000},
	"CAD": {perUnits: 1, min: 200, max: 7000},
	"AUD": {perUnits: 1, min: 200, max: 7000},
	"AED": {perUnits: 1, min: 80, max: 2800},
	"CNY": {perUnits: 1, min: 40, max: 1500},
	"GHS": {perUnits: 1, min: 20, max: 900},
	"ZAR": {perUnits: 1, min: 15, max: 600},
	"XOF": {perUnits: 1000, min: 0.5, max: 20},
	"XAF": {perUnits: 1000, min: 0.5, max: 20},
}

// scrapeAboki fetches abokiforex.app and returns its parallel-market rates.
func scrapeAboki(ctx context.Context) ([]fxRate, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, abokiURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; O3CapitalFXBot/1.0)")
	req.Header.Set("Accept", "text/html,application/xhtml+xml")

	client := &http.Client{Timeout: 20 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch: %w", err)
	}
	defer resp.Body.Close() //nolint:errcheck
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("unexpected HTTP %d", resp.StatusCode)
	}

	doc, err := html.Parse(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("parse html: %w", err)
	}
	return parseAbokiDoc(doc)
}

// parseAbokiDoc is separated from the fetch so the parse can be tested against a saved
// copy of the page. A scraper whose parser cannot be tested without the network is a
// scraper nobody will notice has stopped working.
func parseAbokiDoc(doc *html.Node) ([]fxRate, error) {
	var out []fxRate
	seen := map[string]bool{}
	cards := 0

	forEachNode(doc, func(n *html.Node) {
		if !nodeHasClass(n, "card") {
			return
		}
		cards++

		currency := abokiCardCurrency(n)
		if currency == "" {
			return
		}
		q, known := abokiQuotes[currency]
		if !known || seen[currency] {
			return
		}

		buy, okBuy := abokiLabelledRate(n, "buy-label")
		sell, okSell := abokiLabelledRate(n, "sell-label")
		// Both halves or nothing. This is also what excludes the CBN official cards,
		// which carry a single mid rate and no buy or sell label at all.
		if !okBuy || !okSell {
			return
		}

		buy, sell = buy/q.perUnits, sell/q.perUnits

		if buy < q.min || buy > q.max || sell < q.min || sell > q.max {
			slog.Warn("aboki: rate outside the plausible band, skipping",
				"currency", currency, "buy", buy, "sell", sell, "min", q.min, "max", q.max)
			return
		}
		// A dealer sells for more than it buys. The other way round means the two figures
		// have been read from the wrong rows, which a layout change could easily cause.
		if buy > sell {
			slog.Warn("aboki: buy above sell, skipping",
				"currency", currency, "buy", buy, "sell", sell)
			return
		}

		seen[currency] = true
		out = append(out, fxRate{Currency: currency, Buy: buy, Sell: sell})
	})

	if len(out) == 0 {
		return nil, fmt.Errorf("no rates parsed from %d card(s) — page structure may have changed", cards)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Currency < out[j].Currency })
	return out, nil
}

// abokiCardCurrency reads the ISO code out of a card's own text, e.g. "DOLLAR (USD)".
// Returns "" unless exactly one known code is present, so a container that happens to
// wrap several cards is skipped rather than guessed at.
func abokiCardCurrency(card *html.Node) string {
	text := strings.ToUpper(nodeText(card))
	var found string
	for code := range abokiQuotes {
		if strings.Contains(text, "("+code+")") {
			if found != "" && found != code {
				return "" // more than one currency in here; this is a wrapper, not a card
			}
			found = code
		}
	}
	return found
}

// abokiLabelledRate finds the row carrying labelClass and returns the rate-value beside
// it. Scoped to the row so a card's BUY figure can never be read off its SELL row.
func abokiLabelledRate(card *html.Node, labelClass string) (float64, bool) {
	var rate float64
	var ok bool
	forEachNode(card, func(row *html.Node) {
		if ok || !nodeHasClass(row, "row") {
			return
		}
		if !nodeContainsClass(row, labelClass) {
			return
		}
		forEachNode(row, func(n *html.Node) {
			if ok || !nodeHasClass(n, "rate-value") {
				return
			}
			if v, err := parseAbokiRate(nodeText(n)); err == nil {
				rate, ok = v, true
			}
		})
	})
	return rate, ok
}

// parseAbokiRate turns "₦ 1,365" or "1365" into a number.
func parseAbokiRate(raw string) (float64, error) {
	s := strings.NewReplacer("₦", "", ",", "", " ", "", " ", "").Replace(raw)
	if s == "" {
		return 0, fmt.Errorf("empty rate")
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, fmt.Errorf("parse %q: %w", raw, err)
	}
	if v <= 0 {
		return 0, fmt.Errorf("non-positive rate %q", raw)
	}
	return v, nil
}

/* ── Small DOM helpers, so the parser above reads as the shape it is looking for ── */

func forEachNode(n *html.Node, fn func(*html.Node)) {
	if n.Type == html.ElementNode {
		fn(n)
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		forEachNode(c, fn)
	}
}

// nodeHasClass matches a whole class token, so "card" does not match "card-body" and
// "row" does not match "row-cols-2".
func nodeHasClass(n *html.Node, class string) bool {
	if n.Type != html.ElementNode {
		return false
	}
	for _, a := range n.Attr {
		if a.Key != "class" {
			continue
		}
		for _, tok := range strings.Fields(a.Val) {
			if tok == class {
				return true
			}
		}
	}
	return false
}

func nodeContainsClass(n *html.Node, class string) bool {
	found := false
	forEachNode(n, func(c *html.Node) {
		if !found && nodeHasClass(c, class) {
			found = true
		}
	})
	return found
}

func nodeText(n *html.Node) string {
	if n.Type == html.TextNode {
		return n.Data
	}
	var sb strings.Builder
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		sb.WriteString(nodeText(c))
	}
	return sb.String()
}

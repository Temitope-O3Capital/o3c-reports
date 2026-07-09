package scraper

// NgnRates.com black-market page parser.
//
// Page structure (as of 2026-07):
//   <table>
//     <thead><tr><th>Currency</th><th>Sell/Buy Rate</th>...</tr></thead>
//     <tbody>
//       <tr>
//         <td><a href="/market/exchange-rates/us-dollar-to-naira/black-market">USD</a></td>
//         <td>₦1,412.5/1,400</td>
//         ...
//       </tr>
//     </tbody>
//   </table>
//
// Rate cell format: "₦X,XXX.X/X,XXX" — first value is sell, second is buy.

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/PuerkitoBio/goquery"
)

const ngnRatesURL = "https://www.ngnrates.com/black-market"

type NgnRatesSource struct{}

func (NgnRatesSource) Name() string { return "ngnrates" }

func (NgnRatesSource) Fetch(ctx context.Context) ([]RateResult, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, ngnRatesURL, nil)
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
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("unexpected status %d", resp.StatusCode)
	}

	doc, err := goquery.NewDocumentFromReader(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("parse html: %w", err)
	}

	// Build a lookup set of currencies we care about.
	want := make(map[string]bool)
	for _, c := range Currencies {
		want[c] = true
	}

	var results []RateResult
	doc.Find("tbody tr").Each(func(_ int, row *goquery.Selection) {
		cells := row.Find("td")
		if cells.Length() < 2 {
			return
		}
		currency := strings.TrimSpace(cells.Eq(0).Text())
		if !want[currency] {
			return
		}
		rateText := strings.TrimSpace(cells.Eq(1).Text())
		sell, buy, err := parseNgnRateCell(rateText)
		if err != nil {
			slog.Warn("ngnrates: parse rate", "currency", currency, "raw", rateText, "err", err)
			return
		}
		results = append(results, RateResult{Currency: currency, Buy: buy, Sell: sell})
	})

	if len(results) == 0 {
		return nil, fmt.Errorf("no rates parsed — page structure may have changed")
	}
	return results, nil
}

// parseNgnRateCell parses "₦1,412.5/1,400" → sell=1412.5, buy=1400.
func parseNgnRateCell(raw string) (sell, buy float64, err error) {
	raw = strings.ReplaceAll(raw, "₦", "")
	raw = strings.ReplaceAll(raw, ",", "")
	raw = strings.TrimSpace(raw)

	parts := strings.SplitN(raw, "/", 2)
	if len(parts) != 2 {
		return 0, 0, fmt.Errorf("expected X/Y format, got %q", raw)
	}
	sell, err = strconv.ParseFloat(strings.TrimSpace(parts[0]), 64)
	if err != nil {
		return 0, 0, fmt.Errorf("sell parse: %w", err)
	}
	buy, err = strconv.ParseFloat(strings.TrimSpace(parts[1]), 64)
	if err != nil {
		return 0, 0, fmt.Errorf("buy parse: %w", err)
	}
	return sell, buy, nil
}

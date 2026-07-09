package scraper

// Aboki Forex parser.
//
// Page structure (as of 2026-07):
//   Each currency is a card with repeated structure:
//     <div>
//       <a href="/[currency]-to-naira-black-market"><img alt="[Currency] currency"></a>
//       <div><span>BUY</span><span>₦ 1425</span><span>USD</span></div>
//       <div><span>SELL</span><span>₦ 1435</span></div>
//     </div>
//
// Strategy: find all spans containing "BUY" or "SELL", then extract the
// currency code and rate from sibling/parent elements.

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

const abokiURL = "https://abokiforex.app/"

type AbokiForexSource struct{}

func (AbokiForexSource) Name() string { return "abokiforex" }

func (AbokiForexSource) Fetch(ctx context.Context) ([]RateResult, error) {
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
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("unexpected status %d", resp.StatusCode)
	}

	doc, err := goquery.NewDocumentFromReader(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("parse html: %w", err)
	}

	want := make(map[string]bool)
	for _, c := range Currencies {
		want[c] = true
	}

	// Build a map: currency → {buy, sell} by walking all links whose href
	// matches the /<currency>-to-naira-black-market pattern.
	type partial struct{ buy, sell float64 }
	found := make(map[string]*partial)

	doc.Find("a[href]").Each(func(_ int, a *goquery.Selection) {
		href, _ := a.Attr("href")
		href = strings.ToLower(strings.TrimSpace(href))

		var currency string
		for _, c := range Currencies {
			if strings.HasPrefix(href, "/"+strings.ToLower(c)+"-to-naira") {
				currency = c
				break
			}
		}
		if currency == "" || !want[currency] {
			return
		}

		// Walk up to the card container, then find BUY and SELL spans.
		card := a.Parent()
		if card.Length() == 0 {
			return
		}

		p := &partial{}
		card.Find("span").Each(func(_ int, span *goquery.Selection) {
			text := strings.TrimSpace(span.Text())
			upper := strings.ToUpper(text)
			if upper == "BUY" || upper == "SELL" {
				// Rate is in the next sibling span.
				rateSpan := span.Next()
				rate := parseAbokiRate(rateSpan.Text())
				if upper == "BUY" {
					p.buy = rate
				} else {
					p.sell = rate
				}
			}
		})

		if p.buy > 0 || p.sell > 0 {
			found[currency] = p
		}
	})

	if len(found) == 0 {
		return nil, fmt.Errorf("no rates parsed — page structure may have changed")
	}

	var results []RateResult
	for currency, p := range found {
		if p.buy == 0 && p.sell == 0 {
			slog.Warn("abokiforex: zero rates", "currency", currency)
			continue
		}
		results = append(results, RateResult{Currency: currency, Buy: p.buy, Sell: p.sell})
	}
	return results, nil
}

func parseAbokiRate(raw string) float64 {
	raw = strings.ReplaceAll(raw, "₦", "")
	raw = strings.ReplaceAll(raw, ",", "")
	raw = strings.TrimSpace(raw)
	v, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return 0
	}
	return v
}

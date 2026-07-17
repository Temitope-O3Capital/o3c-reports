package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"golang.org/x/net/html"

	"github.com/o3c/reports/core"
)

// FXRatesLatest returns the most recent rate per currency from fx_parallel_rates.
// GET /api/finance/fx-rates/latest?currency=USD (optional filter)
func FXRatesLatest(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		currency := r.URL.Query().Get("currency")

		var rows []map[string]any
		var err error

		if currency != "" {
			rows, err = db.PGQuery(ctx,
				`SELECT DISTINCT ON (currency) source, currency, buy, sell, scraped_at
				 FROM fx_parallel_rates
				 WHERE currency = $1
				 ORDER BY currency, scraped_at DESC`,
				currency,
			)
		} else {
			rows, err = db.PGQuery(ctx,
				`SELECT DISTINCT ON (currency) source, currency, buy, sell, scraped_at
				 FROM fx_parallel_rates
				 ORDER BY currency, scraped_at DESC`,
			)
		}
		if err != nil {
			respondErr(w, 500, "database error")
			return
		}

		staleThreshold := 3 * time.Hour
		now := time.Now()

		type rate struct {
			Currency string  `json:"currency"`
			Buy      float64 `json:"buy"`
			Sell     float64 `json:"sell"`
			Source   string  `json:"source"`
			AsOf     string  `json:"as_of"`
			IsStale  bool    `json:"is_stale"`
		}

		result := make([]rate, 0, len(rows))
		for _, row := range rows {
			scrapedAt, _ := row["scraped_at"].(time.Time)
			buy, _ := fxFloat(row["buy"])
			sell, _ := fxFloat(row["sell"])
			result = append(result, rate{
				Currency: str(row["currency"]),
				Buy:      buy,
				Sell:     sell,
				Source:   str(row["source"]),
				AsOf:     scrapedAt.UTC().Format(time.RFC3339),
				IsStale:  now.Sub(scrapedAt) > staleThreshold,
			})
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"rates": result}) //nolint:errcheck
	}
}

// FXRatesHistory returns historical rows for a currency within a date range.
// GET /api/finance/fx-rates/history?currency=USD&from=2026-06-01&to=2026-07-09
func FXRatesHistory(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		currency := r.URL.Query().Get("currency")
		if currency == "" {
			respondErr(w, 400, "currency param required")
			return
		}

		from := time.Now().AddDate(0, 0, -30) // default 30 days
		to := time.Now()

		if fromStr := r.URL.Query().Get("from"); fromStr != "" {
			if t, err := time.Parse("2006-01-02", fromStr); err == nil {
				from = t
			}
		}
		if toStr := r.URL.Query().Get("to"); toStr != "" {
			if t, err := time.Parse("2006-01-02", toStr); err == nil {
				to = t.Add(24*time.Hour - time.Second)
			}
		}

		rows, err := db.PGQuery(ctx,
			`SELECT source, currency, buy, sell, scraped_at
			 FROM fx_parallel_rates
			 WHERE currency = $1
			   AND scraped_at >= $2
			   AND scraped_at <= $3
			 ORDER BY scraped_at ASC`,
			currency, from, to,
		)
		if err != nil {
			respondErr(w, 500, "database error")
			return
		}

		type histRow struct {
			Source    string  `json:"source"`
			Currency  string  `json:"currency"`
			Buy       float64 `json:"buy"`
			Sell      float64 `json:"sell"`
			ScrapedAt string  `json:"scraped_at"`
		}
		result := make([]histRow, 0, len(rows))
		for _, row := range rows {
			scrapedAt, _ := row["scraped_at"].(time.Time)
			buy, _ := fxFloat(row["buy"])
			sell, _ := fxFloat(row["sell"])
			result = append(result, histRow{
				Source:    str(row["source"]),
				Currency:  str(row["currency"]),
				Buy:       buy,
				Sell:      sell,
				ScrapedAt: scrapedAt.UTC().Format(time.RFC3339),
			})
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"rows": result}) //nolint:errcheck
	}
}

// FXRatesRefresh scrapes NgnRates.com and inserts fresh rates into fx_parallel_rates.
// POST /api/finance/fx-rates/refresh  (admin / finance_head only)
func FXRatesRefresh(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		rates, err := scrapeNgnRates(ctx)
		if err != nil {
			respondErr(w, 502, "scrape failed: "+err.Error())
			return
		}

		inserted := 0
		for _, rate := range rates {
			_, err := db.PGExec(ctx,
				`INSERT INTO fx_parallel_rates (source, currency, buy, sell, scraped_at)
				 VALUES ($1, $2, $3, $4, NOW())`,
				"ngnrates", rate.Currency, rate.Buy, rate.Sell)
			if err == nil {
				inserted++
			}
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"inserted": inserted,
			"rates":    rates,
		})
	}
}

type fxRate struct {
	Currency string  `json:"currency"`
	Buy      float64 `json:"buy"`
	Sell     float64 `json:"sell"`
}

// scrapeNgnRates fetches and parses NgnRates.com black market table.
// Table rows: <tr><td>USD</td><td>₦1,412.5/1,400</td>...</tr>
// Cell format: sell/buy (first number is sell, second is buy).
func scrapeNgnRates(ctx context.Context) ([]fxRate, error) {
	want := map[string]bool{"USD": true, "EUR": true, "GBP": true}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://www.ngnrates.com/black-market", nil)
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
		return nil, fmt.Errorf("unexpected HTTP %d", resp.StatusCode)
	}

	doc, err := html.Parse(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("parse html: %w", err)
	}

	var results []fxRate
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode && n.Data == "tr" {
			cells := htmlCells(n)
			if len(cells) >= 2 {
				currency := strings.TrimSpace(htmlText(cells[0]))
				if want[currency] {
					rateText := strings.TrimSpace(htmlText(cells[1]))
					sell, buy, err := parseNgnRateCell(rateText)
					if err == nil && (buy > 0 || sell > 0) {
						results = append(results, fxRate{
							Currency: currency,
							Buy:      buy,
							Sell:     sell,
						})
					}
				}
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(doc)

	if len(results) == 0 {
		return nil, fmt.Errorf("no rates found — page structure may have changed")
	}
	return results, nil
}

// htmlCells returns all <td> children of a <tr> node.
func htmlCells(tr *html.Node) []*html.Node {
	var cells []*html.Node
	for c := tr.FirstChild; c != nil; c = c.NextSibling {
		if c.Type == html.ElementNode && c.Data == "td" {
			cells = append(cells, c)
		}
	}
	return cells
}

// htmlText extracts concatenated text content from a node tree.
func htmlText(n *html.Node) string {
	if n == nil {
		return ""
	}
	if n.Type == html.TextNode {
		return n.Data
	}
	var sb strings.Builder
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		sb.WriteString(htmlText(c))
	}
	return sb.String()
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
		return 0, 0, fmt.Errorf("sell: %w", err)
	}
	buy, err = strconv.ParseFloat(strings.TrimSpace(parts[1]), 64)
	if err != nil {
		return 0, 0, fmt.Errorf("buy: %w", err)
	}
	return sell, buy, nil
}

// StartFXRatesScraper runs an hourly background goroutine that scrapes NgnRates.com
// and inserts fresh parallel-market rates into fx_parallel_rates.
// Call as: go handlers.StartFXRatesScraper(db)
func StartFXRatesScraper(db *core.DB) {
	runFXScrape(db) // run once immediately on startup
	ticker := time.NewTicker(1 * time.Hour)
	defer ticker.Stop()
	for range ticker.C {
		runFXScrape(db)
	}
}

func runFXScrape(db *core.DB) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	rates, err := scrapeNgnRates(ctx)
	if err != nil {
		slog.Error("FX rate scrape failed", "err", err)
		return
	}

	inserted := 0
	for _, rate := range rates {
		_, err := db.PGExec(ctx,
			`INSERT INTO fx_parallel_rates (source, currency, buy, sell, scraped_at) VALUES ($1, $2, $3, $4, NOW())`,
			"ngnrates", rate.Currency, rate.Buy, rate.Sell)
		if err != nil {
			slog.Error("FX rate insert failed", "currency", rate.Currency, "err", err)
		} else {
			inserted++
		}
	}
	slog.Info("FX rates scraped", "inserted", inserted)
}

// fxFloat converts pgx numeric types to float64 for FX rate rows.
func fxFloat(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case float32:
		return float64(x), true
	case int64:
		return float64(x), true
	case int32:
		return float64(x), true
	case string:
		var f float64
		if _, err := fmt.Sscanf(x, "%f", &f); err == nil {
			return f, true
		}
	}
	return 0, false
}

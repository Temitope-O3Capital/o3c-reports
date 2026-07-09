package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

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

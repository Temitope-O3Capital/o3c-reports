package api

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/o3c/fx-api/internal/store"
)

type rateResponse struct {
	Currency string  `json:"currency"`
	Buy      float64 `json:"buy"`
	Sell     float64 `json:"sell"`
	Source   string  `json:"source"`
	AsOf     string  `json:"as_of"`
	IsStale  bool    `json:"is_stale"`
	// Disclaimer is included on every response per spec §5.
	Disclaimer string `json:"disclaimer,omitempty"`
}

const disclaimer = "Indicative parallel-market rates sourced from community-aggregated BDC quotes. Not a licensed FX feed. Not suitable for settlement or customer-facing rate quotes without compliance review."

func handleLatest(db *pgxpool.Pool, staleHours float64) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		currency := r.URL.Query().Get("currency")
		rows, err := store.Latest(r.Context(), db, currency)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "database error")
			return
		}
		if len(rows) == 0 {
			writeErr(w, http.StatusNotFound, "no rates available")
			return
		}

		staleThreshold := time.Duration(staleHours * float64(time.Hour))
		now := time.Now()

		if currency != "" && len(rows) == 1 {
			// Single currency — return object not array.
			row := rows[0]
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(rateResponse{ //nolint:errcheck
				Currency:   row.Currency,
				Buy:        row.Buy,
				Sell:       row.Sell,
				Source:     row.Source,
				AsOf:       row.ScrapedAt.UTC().Format(time.RFC3339),
				IsStale:    now.Sub(row.ScrapedAt) > staleThreshold,
				Disclaimer: disclaimer,
			})
			return
		}

		// All currencies — return array.
		resp := make([]rateResponse, 0, len(rows))
		for _, row := range rows {
			resp = append(resp, rateResponse{
				Currency: row.Currency,
				Buy:      row.Buy,
				Sell:     row.Sell,
				Source:   row.Source,
				AsOf:     row.ScrapedAt.UTC().Format(time.RFC3339),
				IsStale:  now.Sub(row.ScrapedAt) > staleThreshold,
			})
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"rates":      resp,
			"disclaimer": disclaimer,
		})
	}
}

func handleHistory(db *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		currency := r.URL.Query().Get("currency")
		if currency == "" {
			writeErr(w, http.StatusBadRequest, "currency param required")
			return
		}
		fromStr := r.URL.Query().Get("from")
		toStr := r.URL.Query().Get("to")

		from := time.Now().AddDate(0, 0, -7) // default: last 7 days
		to := time.Now()

		if fromStr != "" {
			if t, err := time.Parse("2006-01-02", fromStr); err == nil {
				from = t
			}
		}
		if toStr != "" {
			if t, err := time.Parse("2006-01-02", toStr); err == nil {
				to = t.Add(24*time.Hour - time.Second) // inclusive end of day
			}
		}

		rows, err := store.History(r.Context(), db, currency, from, to)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "database error")
			return
		}

		type histRow struct {
			Currency  string  `json:"currency"`
			Buy       float64 `json:"buy"`
			Sell      float64 `json:"sell"`
			Source    string  `json:"source"`
			ScrapedAt string  `json:"scraped_at"`
		}
		resp := make([]histRow, 0, len(rows))
		for _, row := range rows {
			resp = append(resp, histRow{
				Currency:  row.Currency,
				Buy:       row.Buy,
				Sell:      row.Sell,
				Source:    row.Source,
				ScrapedAt: row.ScrapedAt.UTC().Format(time.RFC3339),
			})
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"currency":   currency,
			"from":       from.Format("2006-01-02"),
			"to":         to.Format("2006-01-02"),
			"rows":       resp,
			"disclaimer": disclaimer,
		})
	}
}

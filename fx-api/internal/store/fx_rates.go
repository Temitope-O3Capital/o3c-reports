package store

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type RateRow struct {
	ID        int64
	Source    string
	Currency  string
	Buy       float64
	Sell      float64
	ScrapedAt time.Time
}

// Latest returns the most recent row per currency. If currency is non-empty,
// only that currency is returned.
func Latest(ctx context.Context, db *pgxpool.Pool, currency string) ([]RateRow, error) {
	var rows []RateRow
	var err error

	if currency != "" {
		rows, err = queryRows(ctx, db,
			`SELECT DISTINCT ON (currency) id, source, currency, buy, sell, scraped_at
			 FROM fx_parallel_rates
			 WHERE currency = $1
			 ORDER BY currency, scraped_at DESC`,
			currency,
		)
	} else {
		rows, err = queryRows(ctx, db,
			`SELECT DISTINCT ON (currency) id, source, currency, buy, sell, scraped_at
			 FROM fx_parallel_rates
			 ORDER BY currency, scraped_at DESC`,
		)
	}
	return rows, err
}

// History returns rows for a currency within a date range, oldest first.
func History(ctx context.Context, db *pgxpool.Pool, currency string, from, to time.Time) ([]RateRow, error) {
	return queryRows(ctx, db,
		`SELECT id, source, currency, buy, sell, scraped_at
		 FROM fx_parallel_rates
		 WHERE currency = $1
		   AND scraped_at >= $2
		   AND scraped_at <= $3
		 ORDER BY scraped_at ASC`,
		currency, from, to,
	)
}

// ValidAPIKey returns true if the key exists and is not revoked.
func ValidAPIKey(ctx context.Context, db *pgxpool.Pool, key string) (bool, error) {
	var count int
	err := db.QueryRow(ctx,
		`SELECT COUNT(*) FROM fx_api_clients WHERE api_key = $1 AND revoked_at IS NULL`,
		key,
	).Scan(&count)
	if err != nil {
		return false, fmt.Errorf("api key check: %w", err)
	}
	return count > 0, nil
}

func queryRows(ctx context.Context, db *pgxpool.Pool, sql string, args ...any) ([]RateRow, error) {
	rows, err := db.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []RateRow
	for rows.Next() {
		var r RateRow
		if err := rows.Scan(&r.ID, &r.Source, &r.Currency, &r.Buy, &r.Sell, &r.ScrapedAt); err != nil {
			return nil, fmt.Errorf("scan: %w", err)
		}
		result = append(result, r)
	}
	return result, rows.Err()
}

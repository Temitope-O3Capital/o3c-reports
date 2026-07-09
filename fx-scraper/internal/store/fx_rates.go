package store

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type RateRow struct {
	Currency  string
	Buy       float64
	Sell      float64
	ScrapedAt time.Time
	Source    string
}

// Insert appends a new rate row. Append-only — never updates existing rows.
func Insert(ctx context.Context, db *pgxpool.Pool, source, currency string, buy, sell float64) error {
	_, err := db.Exec(ctx,
		`INSERT INTO fx_parallel_rates (source, currency, buy, sell, scraped_at)
		 VALUES ($1, $2, $3, $4, now())`,
		source, currency, buy, sell,
	)
	return err
}

// LastGoodRate returns the most recent row for a given currency, for use in alert emails.
func LastGoodRate(ctx context.Context, db *pgxpool.Pool, currency string) (*RateRow, error) {
	rows, err := db.Query(ctx,
		`SELECT source, currency, buy, sell, scraped_at
		 FROM fx_parallel_rates
		 WHERE currency = $1
		 ORDER BY scraped_at DESC
		 LIMIT 1`,
		currency,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, nil
	}
	var r RateRow
	if err := rows.Scan(&r.Source, &r.Currency, &r.Buy, &r.Sell, &r.ScrapedAt); err != nil {
		return nil, fmt.Errorf("scan: %w", err)
	}
	return &r, nil
}

package main

import (
	"context"
	"time"

	"github.com/o3c/reports/core"
)

// pgLimitCounter persists rate-limit counters in PostgreSQL so they survive pod restarts.
// Implements github.com/go-chi/httprate.LimitCounter.
type pgLimitCounter struct {
	db *core.DB
}

func newPGLimitCounter(db *core.DB) *pgLimitCounter {
	c := &pgLimitCounter{db: db}
	go c.cleanup()
	return c
}

func (c *pgLimitCounter) Config(_ int, _ time.Duration) {}

func (c *pgLimitCounter) Increment(key string, currentWindow time.Time) error {
	return c.IncrementBy(key, currentWindow, 1)
}

func (c *pgLimitCounter) IncrementBy(key string, currentWindow time.Time, amount int) error {
	_, err := c.db.PGExec(context.Background(),
		`INSERT INTO rate_limit_counters(key, window_start, count) VALUES($1, $2, $3)
		 ON CONFLICT(key, window_start) DO UPDATE SET count = rate_limit_counters.count + EXCLUDED.count`,
		key, currentWindow.UTC(), amount)
	return err
}

func (c *pgLimitCounter) Get(key string, currentWindow, previousWindow time.Time) (int, int, error) {
	rows, err := c.db.PGQuery(context.Background(),
		`SELECT window_start, count FROM rate_limit_counters WHERE key = $1 AND window_start IN ($2, $3)`,
		key, currentWindow.UTC(), previousWindow.UTC())
	if err != nil {
		return 0, 0, err
	}
	curr, prev := 0, 0
	for _, row := range rows {
		w, _ := row["window_start"].(time.Time)
		n := pgInt(row["count"])
		if w.UTC().Equal(currentWindow.UTC()) {
			curr = n
		} else {
			prev = n
		}
	}
	return curr, prev, nil
}

// cleanup removes windows older than 2 minutes every 5 minutes.
func (c *pgLimitCounter) cleanup() {
	t := time.NewTicker(5 * time.Minute)
	defer t.Stop()
	for range t.C {
		c.db.PGExec(context.Background(), //nolint:errcheck
			`DELETE FROM rate_limit_counters WHERE window_start < NOW() - INTERVAL '2 minutes'`)
	}
}

func pgInt(v any) int {
	switch x := v.(type) {
	case int64:
		return int(x)
	case int32:
		return int(x)
	case int:
		return x
	case float64:
		return int(x)
	}
	return 0
}

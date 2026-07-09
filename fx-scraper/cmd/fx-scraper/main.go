package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/o3c/fx-scraper/internal/alert"
	"github.com/o3c/fx-scraper/internal/config"
	"github.com/o3c/fx-scraper/internal/scraper"
	"github.com/o3c/fx-scraper/internal/store"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})))

	cfg, err := config.Load()
	if err != nil {
		slog.Error("config", "err", err)
		os.Exit(1)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	db, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		slog.Error("db connect", "err", err)
		os.Exit(1)
	}
	defer db.Close()

	mailer := &alert.Client{
		APIKey:    cfg.SendGridAPIKey,
		FromEmail: cfg.AlertEmailFrom,
		ToEmails:  cfg.AlertEmailTo,
	}

	sources := []scraper.Source{
		scraper.NgnRatesSource{},
		scraper.AbokiForexSource{},
	}

	successCount := 0

	for _, src := range sources {
		slog.Info("scraping", "source", src.Name())
		results, err := src.Fetch(ctx)
		if err != nil {
			slog.Error("fetch failed", "source", src.Name(), "err", err)
			fireAlert(ctx, db, mailer, src.Name(), "network", err.Error())
			continue
		}

		sourceSuccess := 0
		for _, r := range results {
			if err := validate(r, cfg); err != nil {
				slog.Warn("validation failed", "source", src.Name(), "currency", r.Currency, "err", err)
				fireAlertWithLastGood(ctx, db, mailer, src.Name(), "validation", err.Error(), r.Currency)
				continue
			}
			if err := store.Insert(ctx, db, src.Name(), r.Currency, r.Buy, r.Sell); err != nil {
				slog.Error("insert failed", "source", src.Name(), "currency", r.Currency, "err", err)
				continue
			}
			slog.Info("inserted", "source", src.Name(), "currency", r.Currency, "buy", r.Buy, "sell", r.Sell)
			sourceSuccess++
		}
		if sourceSuccess > 0 {
			successCount++
		}
	}

	if successCount == 0 {
		slog.Error("all sources failed — no rates inserted")
		os.Exit(1)
	}
	slog.Info("done", "sources_succeeded", successCount)
}

func validate(r scraper.RateResult, cfg *config.Config) error {
	if r.Buy <= 0 || r.Sell <= 0 {
		return fmt.Errorf("zero or negative rate: buy=%.2f sell=%.2f", r.Buy, r.Sell)
	}
	// Apply sanity bounds only to USD/NGN; other currencies scale proportionally.
	if r.Currency == "USD" {
		if r.Buy < cfg.MinUSDNGN || r.Buy > cfg.MaxUSDNGN {
			return fmt.Errorf("USD buy %.2f outside bounds [%.0f, %.0f]", r.Buy, cfg.MinUSDNGN, cfg.MaxUSDNGN)
		}
		if r.Sell < cfg.MinUSDNGN || r.Sell > cfg.MaxUSDNGN {
			return fmt.Errorf("USD sell %.2f outside bounds [%.0f, %.0f]", r.Sell, cfg.MinUSDNGN, cfg.MaxUSDNGN)
		}
	}
	return nil
}

func fireAlert(ctx context.Context, db *pgxpool.Pool, mailer *alert.Client, source, failType, detail string) {
	if err := mailer.Send(alert.FailureAlert{
		Source:      source,
		FailureType: failType,
		Detail:      detail,
		OccurredAt:  time.Now(),
	}); err != nil {
		slog.Warn("alert send failed", "err", err)
	}
}

func fireAlertWithLastGood(ctx context.Context, db *pgxpool.Pool, mailer *alert.Client, source, failType, detail, currency string) {
	a := alert.FailureAlert{
		Source:      source,
		FailureType: failType,
		Detail:      detail,
		OccurredAt:  time.Now(),
	}
	if last, err := store.LastGoodRate(ctx, db, currency); err == nil && last != nil {
		a.LastGoodRate = &alert.LastRate{
			Currency:  last.Currency,
			Buy:       last.Buy,
			Sell:      last.Sell,
			ScrapedAt: last.ScrapedAt,
			Source:    last.Source,
		}
	}
	if err := mailer.Send(a); err != nil {
		slog.Warn("alert send failed", "err", err)
	}
}

package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/joho/godotenv"
)

type Config struct {
	DatabaseURL    string
	SendGridAPIKey string
	AlertEmailFrom string
	AlertEmailTo   []string
	MinUSDNGN      float64
	MaxUSDNGN      float64
}

func Load() (*Config, error) {
	_ = godotenv.Load()

	c := &Config{
		DatabaseURL:    os.Getenv("DATABASE_URL"),
		SendGridAPIKey: os.Getenv("SENDGRID_API_KEY"),
		AlertEmailFrom: os.Getenv("ALERT_EMAIL_FROM"),
		MinUSDNGN:      parseFloat(os.Getenv("FX_RATE_MIN_USD_NGN"), 800),
		MaxUSDNGN:      parseFloat(os.Getenv("FX_RATE_MAX_USD_NGN"), 3000),
	}

	if c.DatabaseURL == "" {
		return nil, fmt.Errorf("DATABASE_URL is required")
	}
	if raw := os.Getenv("ALERT_EMAIL_TO"); raw != "" {
		for _, e := range strings.Split(raw, ",") {
			if t := strings.TrimSpace(e); t != "" {
				c.AlertEmailTo = append(c.AlertEmailTo, t)
			}
		}
	}
	return c, nil
}

func parseFloat(s string, def float64) float64 {
	if s == "" {
		return def
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return def
	}
	return v
}

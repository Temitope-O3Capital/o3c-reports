package config

import (
	"fmt"
	"os"
	"strconv"

	"github.com/joho/godotenv"
)

type Config struct {
	DatabaseURL         string
	Port                string
	StaleThresholdHours float64
}

func Load() (*Config, error) {
	_ = godotenv.Load()
	c := &Config{
		DatabaseURL:         os.Getenv("DATABASE_URL"),
		Port:                coalesce(os.Getenv("PORT"), "8080"),
		StaleThresholdHours: parseFloat(os.Getenv("FX_STALE_THRESHOLD_HOURS"), 3),
	}
	if c.DatabaseURL == "" {
		return nil, fmt.Errorf("DATABASE_URL is required")
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

func coalesce(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

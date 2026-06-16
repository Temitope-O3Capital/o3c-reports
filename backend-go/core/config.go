package core

import (
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"strings"

	"github.com/joho/godotenv"
)

type Config struct {
	SecretKey      string
	PGURL          string
	MSSQLConnStr   string // empty = MSSQL disabled
	AllowedOrigins []string
	Port           string
}

func LoadConfig() (*Config, error) {
	_ = godotenv.Load()

	c := &Config{
		SecretKey: os.Getenv("SECRET_KEY"),
		PGURL:     os.Getenv("DATABASE_URL"),
		Port:      coalesce(os.Getenv("PORT"), "8000"),
	}

	if c.SecretKey == "" || c.SecretKey == "change-this-in-production" {
		return nil, fmt.Errorf("SECRET_KEY must be a secure random value — generate with: openssl rand -hex 32")
	}
	if c.PGURL == "" {
		return nil, fmt.Errorf("DATABASE_URL (Supabase PostgreSQL URL) is required")
	}

	srv := os.Getenv("MSSQL_SERVER")
	db := os.Getenv("MSSQL_DB")
	if srv != "" && db != "" {
		if os.Getenv("MSSQL_TRUSTED") == "yes" {
			c.MSSQLConnStr = fmt.Sprintf("sqlserver://%s?database=%s&trusted_connection=yes", srv, db)
		} else {
			u := url.QueryEscape(os.Getenv("MSSQL_USER"))
			p := url.QueryEscape(os.Getenv("MSSQL_PASSWORD"))
			c.MSSQLConnStr = fmt.Sprintf("sqlserver://%s:%s@%s?database=%s", u, p, srv, db)
		}
		slog.Info("MSSQL configured", "server", srv, "database", db)
	} else {
		slog.Info("MSSQL not configured — Supabase-only mode")
	}

	origins := coalesce(os.Getenv("ALLOWED_ORIGINS"),
		"https://o3capital.pages.dev,http://localhost:3000,http://localhost:3001")
	for _, o := range strings.Split(origins, ",") {
		if t := strings.TrimSpace(o); t != "" {
			c.AllowedOrigins = append(c.AllowedOrigins, t)
		}
	}
	return c, nil
}

func coalesce(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

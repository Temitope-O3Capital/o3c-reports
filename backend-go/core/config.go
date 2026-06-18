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
	SecretKey        string
	EncryptionKey    string
	PGURL            string
	MSSQLConnStr     string // empty = MSSQL disabled
	AllowedOrigins   []string
	Port             string
	ResetAdminSecret string // from RESET_ADMIN_SECRET env var
	EnableResetAdmin bool   // from ENABLE_RESET_ADMIN env var
}

func LoadConfig() (*Config, error) {
	_ = godotenv.Load()

	c := &Config{
		SecretKey:        os.Getenv("SECRET_KEY"),
		EncryptionKey:    os.Getenv("ENCRYPTION_KEY"),
		PGURL:            os.Getenv("DATABASE_URL"),
		Port:             coalesce(os.Getenv("PORT"), "8000"),
		ResetAdminSecret: os.Getenv("RESET_ADMIN_SECRET"),
		EnableResetAdmin: os.Getenv("ENABLE_RESET_ADMIN") == "true",
	}

	if c.SecretKey == "" || c.SecretKey == "change-this-in-production" {
		return nil, fmt.Errorf("SECRET_KEY must be a secure random value — generate with: openssl rand -hex 32")
	}
	if c.EncryptionKey == "" {
		return nil, fmt.Errorf("ENCRYPTION_KEY is required but not set")
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

	rawOrigins := os.Getenv("ALLOWED_ORIGINS")
	if rawOrigins == "" {
		slog.Warn("ALLOWED_ORIGINS is not set — no CORS origins will be allowed; set this in production")
	} else {
		for _, o := range strings.Split(rawOrigins, ",") {
			if t := strings.TrimSpace(o); t != "" {
				c.AllowedOrigins = append(c.AllowedOrigins, t)
			}
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

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
	DirectPGURL      string // non-pooler URL for LISTEN/NOTIFY; falls back to PGURL
	MSSQLConnStr     string // empty = MSSQL disabled
	AllowedOrigins   []string
	Port             string
	ResetAdminSecret string // from RESET_ADMIN_SECRET env var
	EnableResetAdmin bool   // from ENABLE_RESET_ADMIN env var
	TermiiAPIKey     string // empty = SMS disabled
	TermiiSenderID   string
}

func LoadConfig() (*Config, error) {
	_ = godotenv.Load()

	directPG := os.Getenv("DIRECT_DATABASE_URL")
	if directPG == "" {
		directPG = os.Getenv("DATABASE_URL") // fallback to pooler URL
	}

	c := &Config{
		SecretKey:        os.Getenv("SECRET_KEY"),
		EncryptionKey:    os.Getenv("ENCRYPTION_KEY"),
		PGURL:            os.Getenv("DATABASE_URL"),
		DirectPGURL:      directPG,
		Port:             coalesce(os.Getenv("PORT"), "8000"),
		ResetAdminSecret: os.Getenv("RESET_ADMIN_SECRET"),
		EnableResetAdmin: os.Getenv("ENABLE_RESET_ADMIN") == "true",
		TermiiAPIKey:     os.Getenv("TERMII_API_KEY"),
		TermiiSenderID:   coalesce(os.Getenv("TERMII_SENDER_ID"), "O3CCARDS"),
	}

	weakKeys := []string{"change-this-in-production", "change-this-to-a-random-64-char-string"}
	secretWeak := c.SecretKey == ""
	for _, w := range weakKeys {
		if c.SecretKey == w || strings.HasPrefix(c.SecretKey, "change-this") {
			secretWeak = true
		}
	}
	if secretWeak {
		return nil, fmt.Errorf("SECRET_KEY must be a secure random value — generate with: openssl rand -hex 32")
	}
	if c.EncryptionKey == "" {
		return nil, fmt.Errorf("ENCRYPTION_KEY is required but not set")
	}
	if len([]byte(c.EncryptionKey)) != 32 {
		return nil, fmt.Errorf("ENCRYPTION_KEY must be exactly 32 bytes, got %d", len([]byte(c.EncryptionKey)))
	}
	weakEncKeys := []string{"change-this-to-exactly-32-bytes-"}
	for _, w := range weakEncKeys {
		if c.EncryptionKey == w || strings.HasPrefix(c.EncryptionKey, "change-this") {
			return nil, fmt.Errorf("ENCRYPTION_KEY must be changed from the default — generate 32 random bytes")
		}
	}
	if c.PGURL == "" {
		return nil, fmt.Errorf("DATABASE_URL (Supabase PostgreSQL URL) is required")
	}

	// In Railway (production), BOOTSTRAP_SECRET must be explicitly set so the
	// first-user endpoint cannot be exploited against a fresh database.
	if os.Getenv("RAILWAY_ENVIRONMENT") != "" && os.Getenv("BOOTSTRAP_SECRET") == "" {
		return nil, fmt.Errorf("BOOTSTRAP_SECRET must be set in production (RAILWAY_ENVIRONMENT is set); generate with: openssl rand -hex 32")
	}

	srv := os.Getenv("MSSQL_SERVER")
	db := os.Getenv("MSSQL_DB")
	// Accept MSSQL_DATABASE as an alias: the deployed Railway environment set that
	// name, which this code never read, so MSSQL stayed silently disabled there.
	if db == "" {
		db = os.Getenv("MSSQL_DATABASE")
	}
	if srv != "" && db != "" {
		// Older SQL Server (Production_ED is 2014 / v12) negotiates TLS 1.0, which
		// Go 1.22+ rejects by default ("server selected unsupported protocol
		// version 301"). tlsmin lets the operator opt back down; default to 1.0 for
		// these legacy on-prem servers, overridable via MSSQL_TLS_MIN.
		tlsMin := os.Getenv("MSSQL_TLS_MIN")
		if tlsMin == "" {
			tlsMin = "1.0"
		}
		if os.Getenv("MSSQL_TRUSTED") == "yes" {
			c.MSSQLConnStr = fmt.Sprintf(
				"sqlserver://%s?database=%s&trusted_connection=yes&tlsmin=%s", srv, db, tlsMin)
		} else {
			u := url.QueryEscape(os.Getenv("MSSQL_USER"))
			p := url.QueryEscape(os.Getenv("MSSQL_PASSWORD"))
			c.MSSQLConnStr = fmt.Sprintf(
				"sqlserver://%s:%s@%s?database=%s&tlsmin=%s", u, p, srv, db, tlsMin)
		}
		slog.Info("MSSQL configured", "server", srv, "database", db, "tlsmin", tlsMin)
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

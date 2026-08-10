package core

import (
	"fmt"
	"log/slog"
	"os"
	"strings"

	"github.com/joho/godotenv"
)

type Config struct {
	SecretKey        string
	EncryptionKey    string
	PGURL            string
	DirectPGURL      string // non-pooler URL for LISTEN/NOTIFY; falls back to PGURL
	AllowedOrigins   []string
	Port             string
	ResetAdminSecret string // from RESET_ADMIN_SECRET env var
	EnableResetAdmin bool   // from ENABLE_RESET_ADMIN env var
	ZohoImportSecret string // from ZOHO_IMPORT_SECRET env var (separate from ResetAdminSecret)
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
		ZohoImportSecret: os.Getenv("ZOHO_IMPORT_SECRET"),
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

	// MSSQL/Sage support was removed once the card system's data was ported into
	// Postgres (feed.* — see docs/DATA_FEED_INGESTION.md). Postgres is the sole datastore.

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

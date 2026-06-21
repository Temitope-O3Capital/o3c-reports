package main

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"log/slog"
	"sort"
	"strings"

	"github.com/o3c/reports/core"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

func runMigrations(db *core.DB) error {
	ctx := context.Background()

	// Ensure tracking table exists
	if _, err := db.PGExec(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			filename   TEXT PRIMARY KEY,
			applied_at TIMESTAMPTZ DEFAULT NOW()
		)`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}

	// Load already-applied filenames
	rows, err := db.PGQuery(ctx, `SELECT filename FROM schema_migrations`)
	if err != nil {
		return fmt.Errorf("query schema_migrations: %w", err)
	}
	applied := map[string]bool{}
	for _, r := range rows {
		if f, ok := r["filename"].(string); ok {
			applied[f] = true
		}
	}

	// Collect migration files in sorted order
	entries, err := fs.ReadDir(migrationFiles, "migrations")
	if err != nil {
		return fmt.Errorf("read migrations dir: %w", err)
	}
	files := []string{}
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".sql") {
			files = append(files, e.Name())
		}
	}
	sort.Strings(files)

	for _, name := range files {
		if applied[name] {
			continue
		}
		data, err := migrationFiles.ReadFile("migrations/" + name)
		if err != nil {
			return fmt.Errorf("read %s: %w", name, err)
		}
		slog.Info("running migration", "file", name)
		if _, err := db.PGExec(ctx, string(data)); err != nil {
			return fmt.Errorf("apply %s: %w", name, err)
		}
		if _, err := db.PGExec(ctx,
			`INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`, name); err != nil {
			return fmt.Errorf("record %s: %w", name, err)
		}
	}
	return nil
}

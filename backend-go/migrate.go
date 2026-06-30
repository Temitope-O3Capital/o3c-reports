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

// firstNewMigration is the first migration file added by the auto-migration system.
// All earlier files were applied to production via other means before this system existed.
// On first startup against an existing DB we seed everything below this as already-applied
// so we don't attempt to replay history.
const firstNewMigration = "018_task_comments.sql"

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

	// Bootstrap: if schema_migrations is empty and core tables exist, this is an
	// existing DB that predates the auto-migration system. Seed all migrations
	// before firstNewMigration as already-applied so we don't replay old history.
	var migrCount int
	db.PG.QueryRowContext(ctx, `SELECT COUNT(*) FROM schema_migrations`).Scan(&migrCount)
	if migrCount == 0 {
		var coreExists bool
		db.PG.QueryRowContext(ctx, `SELECT EXISTS (
			SELECT FROM information_schema.tables WHERE table_name = 'o3c_users'
		)`).Scan(&coreExists)
		if coreExists {
			slog.Info("existing DB detected — seeding pre-automation migrations as applied")
			for _, name := range files {
				if name >= firstNewMigration {
					break
				}
				db.PG.ExecContext(ctx,
					`INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`, name)
			}
		}
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

	// Run unapplied migrations; warn and skip on error (don't crash the server)
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
			return fmt.Errorf("migration %s failed: %w", name, err)
		}
		if _, err := db.PGExec(ctx,
			`INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`, name); err != nil {
			slog.Warn("could not record migration", "file", name, "err", err)
		}
	}
	return nil
}

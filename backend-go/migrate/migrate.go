// Package migrate applies the SQL migrations.
//
// The logic lives here rather than in package main so that tests can run the
// EXACT same runner against a throwaway database. It used to be a function in
// main, which meant nothing could exercise it: a migration that fails only
// aborts startup, and startup is the one thing a unit test never does. The
// //go:embed stays in main (embed cannot reach up out of its own directory), so
// the server passes the embedded files and a test passes os.DirFS.
package migrate

import (
	"context"
	"fmt"
	"io/fs"
	"log/slog"
	"path"
	"sort"
	"strings"

	"github.com/o3c/workspace/core"
)

// FirstNewMigration is the first migration file added by the auto-migration
// system. Everything before it reached production by other means, so on first
// startup against an existing database they are seeded as already-applied rather
// than replayed.
const FirstNewMigration = "018_task_comments.sql"

// LockID is a fixed PostgreSQL advisory lock key that stops two pods migrating
// at once ('O3C_MIGR' in hex).
const LockID = 0x4F33435F4D494752

// Apply runs every *.sql under dir in fsys that schema_migrations does not
// already list, in filename order, each in its own statement batch.
//
// A migration that fails returns an error and stops the run: the caller aborts
// startup rather than serving against a half-migrated schema.
func Apply(ctx context.Context, db *core.DB, fsys fs.FS, dir string) error {
	// Session-level advisory lock, released when this connection closes.
	if _, err := db.PGExec(ctx, `SELECT pg_advisory_lock($1)`, LockID); err != nil {
		return fmt.Errorf("acquire migration lock: %w", err)
	}
	defer db.PGExec(ctx, `SELECT pg_advisory_unlock($1)`, LockID) //nolint:errcheck

	if _, err := db.PGExec(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			filename   TEXT PRIMARY KEY,
			applied_at TIMESTAMPTZ DEFAULT NOW()
		)`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}

	files, err := List(fsys, dir)
	if err != nil {
		return err
	}

	// Bootstrap: an empty schema_migrations alongside existing core tables means
	// a database that predates this system. Seed the pre-automation files as
	// applied so history is not replayed.
	var migrCount int
	db.PG.QueryRowContext(ctx, `SELECT COUNT(*) FROM schema_migrations`).Scan(&migrCount) //nolint:errcheck
	if migrCount == 0 {
		var coreExists bool
		db.PG.QueryRowContext(ctx, `SELECT EXISTS (
			SELECT FROM information_schema.tables WHERE table_name = 'o3c_users'
		)`).Scan(&coreExists) //nolint:errcheck
		if coreExists {
			slog.Info("existing DB detected — seeding pre-automation migrations as applied")
			for _, name := range files {
				if name >= FirstNewMigration {
					break
				}
				db.PG.ExecContext(ctx,
					`INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`, name) //nolint:errcheck
			}
		}
	}

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

	for _, name := range files {
		if applied[name] {
			continue
		}
		data, err := fs.ReadFile(fsys, path.Join(dir, name))
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

// List returns the migration filenames under dir, sorted. Exported so a test can
// assert that every file on disk was applied.
func List(fsys fs.FS, dir string) ([]string, error) {
	entries, err := fs.ReadDir(fsys, dir)
	if err != nil {
		return nil, fmt.Errorf("read migrations dir: %w", err)
	}
	files := []string{}
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".sql") {
			files = append(files, e.Name())
		}
	}
	sort.Strings(files)
	return files, nil
}

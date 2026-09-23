package main

import (
	"bytes"
	"context"
	"embed"
	"fmt"
	"io/fs"
	"log/slog"
	"sort"
	"strings"

	"github.com/o3c/workspace/core"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

// firstNewMigration is the first migration file added by the auto-migration system.
// All earlier files were applied to production via other means before this system existed.
// On first startup against an existing DB we seed everything below this as already-applied
// so we don't attempt to replay history.
const firstNewMigration = "018_task_comments.sql"

// migrationLockID is a fixed PostgreSQL advisory lock key that prevents concurrent
// migration runs when multiple pods start simultaneously (D6).
const migrationLockID = 0x4F33435F4D494752 // 'O3C_MIGR' in hex

func runMigrations(db *core.DB) error {
	ctx := context.Background()

	// D6: Acquire a session-level advisory lock before touching schema_migrations.
	// The lock is automatically released when this connection closes.
	if _, err := db.PGExec(ctx, `SELECT pg_advisory_lock($1)`, migrationLockID); err != nil {
		return fmt.Errorf("acquire migration lock: %w", err)
	}
	defer db.PGExec(ctx, `SELECT pg_advisory_unlock($1)`, migrationLockID) //nolint:errcheck

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

	// Run unapplied migrations. A failure stops the boot by default: serving handlers
	// against a half-applied schema is worse than not serving at all. A migration that
	// only moves data can opt out with @nonblocking (see below).
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
			if migrationIsNonBlocking(data) {
				// Deliberately not recorded as applied, so it runs again on the next
				// boot and heals itself once the file is corrected.
				slog.Error("migration failed; continuing because it is marked @nonblocking",
					"file", name, "err", err)
				continue
			}
			return fmt.Errorf("migration %s failed: %w", name, err)
		}
		if _, err := db.PGExec(ctx,
			`INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`, name); err != nil {
			slog.Warn("could not record migration", "file", name, "err", err)
		}
	}
	return nil
}

// migrationIsNonBlocking reports whether a migration opts out of halting startup.
//
// Schema changes must keep the default: if a column fails to appear, every handler
// that expects it breaks at runtime, and a server that refuses to start is the
// louder and safer failure. A pure data backfill is a different animal. It alters
// no structure, so the application runs correctly without it, and taking the whole
// workspace down over one is a poor trade.
//
// 281_backfill_duplicate_call_records.sql proved the point on 2026-09-23: it named a
// column that does not exist, and the workspace was unreachable for nine minutes
// while the keep-alive task restarted it into the same failure twelve times.
//
// Mark such a migration by putting @nonblocking in a comment near the top:
//
//	-- 284 — Collapse duplicate X. @nonblocking: data only, safe to retry.
//
// Only use it for work that is idempotent and structure-free.
func migrationIsNonBlocking(sql []byte) bool {
	head := sql
	if len(head) > 4000 {
		head = head[:4000]
	}
	return bytes.Contains(head, []byte("@nonblocking"))
}

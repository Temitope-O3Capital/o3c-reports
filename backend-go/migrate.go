package main

import (
	"bytes"
	"context"
	"embed"

	"github.com/o3c/workspace/core"
	"github.com/o3c/workspace/migrate"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

// runMigrations applies the embedded migrations at startup.
//
// The runner itself lives in package migrate so the integration tests can apply
// the same code to a throwaway database — see handlers/integration_test.go. The
// embed has to stay here, because //go:embed cannot reach outside its own
// directory and the SQL lives under backend-go/migrations.
func runMigrations(db *core.DB) error {
	return migrate.Apply(context.Background(), db, migrationFiles, "migrations")
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

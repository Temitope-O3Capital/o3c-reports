package main

import (
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

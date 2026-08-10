package core

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	_ "github.com/jackc/pgx/v5/stdlib"
)

// isTableMissing reports whether err is PostgreSQL's "relation does not exist"
// (SQLSTATE 42P01).
//
// It matches on the SQLSTATE code alone, deliberately. The old test also accepted any
// error whose text contained "does not exist", which swallowed `column "x" does not
// exist` (42703) and `type ... does not exist` — so a typo in a column name surfaced as
// an empty table rather than a failure. Callers use this to distinguish "not built yet"
// from "broken", and that distinction only holds if it means exactly one thing.
func isTableMissing(err error) bool {
	if err == nil {
		return false
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code == "42P01"
	}
	// Fallback for drivers that flatten the error: match the code, never the prose.
	return strings.Contains(err.Error(), "SQLSTATE 42P01")
}

// Row is a single result row as a string-keyed map.
type Row = map[string]any

const pgTimeout = 15 * time.Second

// DB holds the PostgreSQL connection. MSSQL/Sage support was removed once the card
// system's data was ported into Postgres (feed.* — see docs/DATA_FEED_INGESTION.md);
// Postgres is now the sole datastore.
type DB struct {
	PG          *sql.DB
	PGURL       string // stored for regular pool URL
	DirectPGURL string // non-pooler URL for LISTEN/NOTIFY (bypasses PgBouncer)
	log         *slog.Logger
}

// ListenConn opens a fresh, dedicated pgx connection for LISTEN/NOTIFY.
// Uses DirectPGURL (a non-pooler URL) because PgBouncer transaction mode
// does not support LISTEN. Callers must close the returned connection.
func (d *DB) ListenConn(ctx context.Context) (*pgx.Conn, error) {
	return pgx.Connect(ctx, d.DirectPGURL)
}

// Open connects to PostgreSQL (the sole datastore).
func Open(cfg *Config) (*DB, error) {
	pg, err := sql.Open("pgx", cfg.PGURL)
	if err != nil {
		return nil, fmt.Errorf("postgres: %w", err)
	}
	pg.SetMaxOpenConns(25)
	pg.SetMaxIdleConns(5)
	pg.SetConnMaxLifetime(5 * time.Minute)
	pg.SetConnMaxIdleTime(5 * time.Minute)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := pg.PingContext(ctx); err != nil {
		return nil, fmt.Errorf("postgres unreachable: %w", err)
	}
	slog.Info("PostgreSQL connected")

	return &DB{PG: pg, PGURL: cfg.PGURL, DirectPGURL: cfg.DirectPGURL, log: slog.Default()}, nil
}

// DualQuery runs a query and reports which source answered it.
//
// The name is historical: this once tried MSSQL/Sage first and fell back to Postgres.
// That path is gone — Postgres is the sole datastore (see docs/DATA_FEED_INGESTION.md)
// — and the dead MSSQL argument has been removed from every call site rather than left
// in place discarded, which made a severed connection read as live code.
//
// A missing table yields an empty result rather than an error, so a module whose schema
// is still being built shows a clean empty state. Any other failure is returned.
func (d *DB) DualQuery(ctx context.Context, pgQ string, args ...any) ([]Row, string, error) {
	pgCtx, cancel := context.WithTimeout(ctx, pgTimeout)
	defer cancel()
	rows, err := queryRows(pgCtx, d.PG, pgQ, args)
	if err != nil {
		if isTableMissing(err) {
			d.logger().Warn("DualQuery: relation does not exist — returning empty result",
				"err", err, "query", truncQuery(pgQ))
			return []Row{}, "pg_empty", nil
		}
		return nil, "", err
	}
	return rows, "pg", nil
}

// DualScalar returns the first column named col from the first result row.
func (d *DB) DualScalar(ctx context.Context, col, pgQ string, args ...any) (any, string, error) {
	rows, src, err := d.DualQuery(ctx, pgQ, args...)
	if err != nil || len(rows) == 0 {
		return nil, src, err
	}
	return rows[0][col], src, nil
}

// logger returns the DB's logger, falling back to the default.
//
// Open() always sets one, but tests construct a DB directly as &core.DB{PG: pg} — the
// established convention in this repo — which leaves the field nil. Calling a method on
// a nil *slog.Logger panics, so every log site goes through here rather than touching
// d.log and turning a missing table in a test into a crash.
func (d *DB) logger() *slog.Logger {
	if d.log == nil {
		return slog.Default()
	}
	return d.log
}

// truncQuery shortens a query for log output so a failing 40-line report SQL does not
// dominate the log line. Whitespace is collapsed so multi-line SQL stays on one line.
func truncQuery(q string) string {
	q = strings.Join(strings.Fields(q), " ")
	if len(q) > 160 {
		return q[:160] + "…"
	}
	return q
}

// PGQuery runs a query directly against PostgreSQL (for PG-only data like CRM, loans).
// Returns empty rows (not an error) when the table doesn't exist yet — allows pages
// to show a clean empty state while the schema is being built out.
func (d *DB) PGQuery(ctx context.Context, q string, args ...any) ([]Row, error) {
	pgCtx, cancel := context.WithTimeout(ctx, pgTimeout)
	defer cancel()
	rows, err := queryRows(pgCtx, d.PG, q, args)
	if isTableMissing(err) {
		d.logger().Warn("PGQuery: table not found — returning empty result", "err", err)
		return []Row{}, nil
	}
	return rows, err
}

// PGExec executes a statement against PostgreSQL (INSERT/UPDATE/DELETE).
func (d *DB) PGExec(ctx context.Context, q string, args ...any) (sql.Result, error) {
	pgCtx, cancel := context.WithTimeout(ctx, pgTimeout)
	defer cancel()
	return d.PG.ExecContext(pgCtx, q, args...)
}

func queryRows(ctx context.Context, db *sql.DB, query string, args []any) ([]Row, error) {
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	cols, err := rows.Columns()
	if err != nil {
		return nil, err
	}

	var result []Row
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		row := make(Row, len(cols))
		for i, col := range cols {
			row[col] = normalizeVal(vals[i])
		}
		result = append(result, row)
	}
	return result, rows.Err()
}

// normalizeVal converts driver-specific types to JSON-safe Go values.
func normalizeVal(v any) any {
	switch t := v.(type) {
	case []byte:
		// Return as string only — do NOT try to parse as float.
		// Byte slices can be UUIDs, JSON, or BYTEA; coercing to float64
		// would silently truncate UUIDs that happen to look numeric.
		return string(t)
	case int32:
		return int64(t)
	default:
		return v
	}
}

// HealthReport describes the connection status of the datastore.
type HealthReport struct {
	MSSQL  string `json:"mssql"` // always "removed" — retained for API compatibility
	PG     string `json:"pg"`
	Active string `json:"active_source"`
}

func (d *DB) Health(ctx context.Context) HealthReport {
	r := HealthReport{MSSQL: "removed", PG: "offline", Active: "postgres"}

	pgCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := d.PG.PingContext(pgCtx); err == nil {
		r.PG = "online"
	}
	return r
}

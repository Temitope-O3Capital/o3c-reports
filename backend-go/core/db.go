package core

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	_ "github.com/jackc/pgx/v5/stdlib"
	_ "github.com/microsoft/go-mssqldb"
)

// isTableMissing returns true when the error is a PostgreSQL "relation does not exist"
// (SQLSTATE 42P01). Used to return empty results for tables that haven't been created yet.
func isTableMissing(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "does not exist") ||
		strings.Contains(msg, "42P01") ||
		strings.Contains(msg, "undefined table")
}

// Row is a single result row as a string-keyed map.
type Row = map[string]any

const (
	mssqlTimeout = 30 * time.Second
	pgTimeout    = 15 * time.Second
	cbThreshold  = 3               // failures before circuit opens
	cbResetAfter = 60 * time.Second // time before circuit attempts reset
)

// circuitBreaker prevents hammering a broken MSSQL connection.
type circuitBreaker struct {
	mu         sync.Mutex
	failures   int
	lastFailed time.Time
}

func (cb *circuitBreaker) isOpen() bool {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	if cb.failures < cbThreshold {
		return false
	}
	if time.Since(cb.lastFailed) > cbResetAfter {
		cb.failures = 0
		return false
	}
	return true
}

func (cb *circuitBreaker) recordSuccess() {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	cb.failures = 0
}

func (cb *circuitBreaker) recordFailure() {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	cb.failures++
	cb.lastFailed = time.Now()
}

// DB holds both database connections and the MSSQL circuit breaker.
type DB struct {
	MS          *sql.DB // nil if MSSQL not configured
	PG          *sql.DB
	PGURL       string // stored for regular pool URL
	DirectPGURL string // non-pooler URL for LISTEN/NOTIFY (bypasses PgBouncer)
	cb          circuitBreaker
	log         *slog.Logger
}

// ListenConn opens a fresh, dedicated pgx connection for LISTEN/NOTIFY.
// Uses DirectPGURL (a non-pooler URL) because PgBouncer transaction mode
// does not support LISTEN. Callers must close the returned connection.
func (d *DB) ListenConn(ctx context.Context) (*pgx.Conn, error) {
	return pgx.Connect(ctx, d.DirectPGURL)
}

// Open connects to PG (required) and optionally MSSQL.
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

	d := &DB{PG: pg, PGURL: cfg.PGURL, DirectPGURL: cfg.DirectPGURL, log: slog.Default()}

	if cfg.MSSQLConnStr != "" {
		ms, err := sql.Open("sqlserver", cfg.MSSQLConnStr)
		if err != nil {
			slog.Warn("MSSQL open failed — continuing without live data", "err", err)
		} else {
			ms.SetMaxOpenConns(10)
			ms.SetMaxIdleConns(3)
			ms.SetConnMaxLifetime(5 * time.Minute)
			msCtx, c2 := context.WithTimeout(context.Background(), 8*time.Second)
			defer c2()
			if err := ms.PingContext(msCtx); err != nil {
				slog.Warn("MSSQL unreachable at startup — will retry on requests", "err", err)
				d.cb.recordFailure()
			} else {
				slog.Info("MSSQL connected")
			}
			d.MS = ms
		}
	}
	return d, nil
}

// DualQuery tries MSSQL first, falls back to PostgreSQL.
// Both queries receive the same args — just the placeholder syntax differs
// (@p1 for MSSQL, $1 for PG). Build args in the same order as the placeholders.
func (d *DB) DualQuery(ctx context.Context, msQ, pgQ string, args ...any) ([]Row, string, error) {
	if d.MS != nil && !d.cb.isOpen() {
		msCtx, cancel := context.WithTimeout(ctx, mssqlTimeout)
		defer cancel()
		rows, err := queryRows(msCtx, d.MS, msQ, args)
		if err == nil {
			d.cb.recordSuccess()
			return rows, "mssql_live", nil
		}
		d.cb.recordFailure()
		d.log.Warn("MSSQL query failed — falling back to Supabase", "err", err)
	}

	pgCtx, cancel := context.WithTimeout(ctx, pgTimeout)
	defer cancel()
	rows, err := queryRows(pgCtx, d.PG, pgQ, args)
	if err != nil {
		if isTableMissing(err) {
			d.log.Warn("DualQuery: PG table not found — returning empty result", "err", err)
			return []Row{}, "supabase_empty", nil
		}
		return nil, "", err
	}
	return rows, "supabase_snapshot", nil
}

// DualScalar returns the first column named col from the first result row.
func (d *DB) DualScalar(ctx context.Context, col, msQ, pgQ string, args ...any) (any, string, error) {
	rows, src, err := d.DualQuery(ctx, msQ, pgQ, args...)
	if err != nil || len(rows) == 0 {
		return nil, src, err
	}
	return rows[0][col], src, nil
}

// PGQuery runs a query directly against PostgreSQL (for PG-only data like CRM, loans).
// Returns empty rows (not an error) when the table doesn't exist yet — allows pages
// to show a clean empty state while the schema is being built out.
func (d *DB) PGQuery(ctx context.Context, q string, args ...any) ([]Row, error) {
	pgCtx, cancel := context.WithTimeout(ctx, pgTimeout)
	defer cancel()
	rows, err := queryRows(pgCtx, d.PG, q, args)
	if isTableMissing(err) {
		d.log.Warn("PGQuery: table not found — returning empty result", "err", err)
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

// HealthReport describes the connection status of each database.
type HealthReport struct {
	MSSQL  string `json:"mssql"`
	PG     string `json:"pg"`
	Active string `json:"active_source"`
}

func (d *DB) Health(ctx context.Context) HealthReport {
	r := HealthReport{MSSQL: "not_configured", PG: "offline", Active: "supabase_snapshot"}

	pgCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := d.PG.PingContext(pgCtx); err == nil {
		r.PG = "online"
	}

	if d.MS != nil {
		msCtx, cancel2 := context.WithTimeout(ctx, 5*time.Second)
		defer cancel2()
		if err := d.MS.PingContext(msCtx); err == nil {
			r.MSSQL = "online"
			r.Active = "mssql_live"
		} else {
			r.MSSQL = "offline"
		}
	}
	return r
}

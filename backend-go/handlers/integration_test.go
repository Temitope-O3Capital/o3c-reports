package handlers

// Integration tests: build a real schema in PostgreSQL and call the handlers.
//
// Why these exist. Every other test in this package is pure — query building,
// formatting, classification — which leaves the things that actually break
// untested: whether a column comes back as the Go type the handler assumes,
// whether the JSON keys are the ones the page reads, and whether the SQL behind a
// feature runs at all. Two real defects prompted this: the settlement upload
// lookup, which shipped reading only one of the two ledgers, and a view rebuilt
// with CREATE OR REPLACE, which cannot reorder columns and would have aborted
// startup.
//
// WHY THE SCHEMA IS BUILT THE WAY IT IS. The migration chain cannot build this
// database from empty, and it is worth being precise about that rather than
// pretending otherwise:
//
//   - ~110 migrations reference app.accounts, app.customers, app.transactions and
//     similar. No migration creates them; the one-time MSSQL import did.
//   - Production runs with search_path "app, core, public" (set on the o3_app
//     role), so 253 unqualified CREATE TABLEs land in app there — and in public on
//     a fresh database, where every app.-qualified reference then fails.
//   - Some migrations cannot replay against today's shape at all. 125 builds an
//     index on core.transaction, which is now a VIEW with no indexes.
//
// So this harness reproduces production's search_path, loads a small baseline
// fixture, and then applies the migrations that CAN apply, collecting the ones
// that cannot. A legacy migration failing is reported, not fatal — it is a
// documented property of the repository. What IS fatal is an object the tested
// features need being absent afterwards, which is what TestSchemaObjectsExist
// asserts.
//
// SAFETY: this runs only against a database whose name ends in "_test". CI uses
// o3c_test and throws the container away. A developer's .env points at
// production, so these skip there rather than touching it. Verified both ways.

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/o3c/workspace/core"
	"github.com/o3c/workspace/migrate"
)

var (
	itOnce      sync.Once
	itDB        *core.DB
	itErr       error
	itSkip      string
	itUnapplied []string // legacy migrations that could not replay
)

func integrationDB(t *testing.T) *core.DB {
	t.Helper()
	itOnce.Do(setupIntegrationDB)
	if itSkip != "" {
		t.Skip(itSkip)
	}
	if itErr != nil {
		t.Fatalf("test database setup failed: %v", itErr)
	}
	return itDB
}

func setupIntegrationDB() {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		itSkip = "DATABASE_URL is not set"
		return
	}
	// The guard: anything not clearly a test database is refused, because the
	// next thing this does is build a schema in it.
	if !isTestDatabaseURL(url) {
		itSkip = "DATABASE_URL does not name a *_test database — refusing to touch it"
		return
	}

	ctx := context.Background()
	db, err := core.Open(&core.Config{PGURL: url, DirectPGURL: url})
	if err != nil {
		itErr = err
		return
	}

	// Match production: unqualified CREATE TABLE must land in app, not public.
	// Set on the database so every pooled connection inherits it, then reopen —
	// existing connections keep the old setting.
	var dbName string
	if err := db.PG.QueryRowContext(ctx, `SELECT current_database()`).Scan(&dbName); err != nil {
		itErr = fmt.Errorf("current_database: %w", err)
		return
	}
	for _, stmt := range []string{
		`CREATE SCHEMA IF NOT EXISTS app`,
		`CREATE SCHEMA IF NOT EXISTS core`,
		fmt.Sprintf(`ALTER DATABASE %q SET search_path = app, core, public`, dbName),
	} {
		if _, err := db.PGExec(ctx, stmt); err != nil {
			itErr = fmt.Errorf("%s: %w", stmt, err)
			return
		}
	}
	db.PG.Close()
	if db, err = core.Open(&core.Config{PGURL: url, DirectPGURL: url}); err != nil {
		itErr = fmt.Errorf("reopen after search_path: %w", err)
		return
	}

	// The baseline the migrations assume but never create.
	fixture, err := os.ReadFile("testdata/baseline_schema.sql")
	if err != nil {
		itErr = fmt.Errorf("read baseline fixture: %w", err)
		return
	}
	if _, err := db.PGExec(ctx, string(fixture)); err != nil {
		itErr = fmt.Errorf("load baseline fixture: %w", err)
		return
	}

	// Apply what applies. os.DirFS("..") + "migrations" is what main passes from
	// its embed, so this is the same SQL the server runs.
	files, err := migrate.List(os.DirFS(".."), "migrations")
	if err != nil {
		itErr = err
		return
	}
	for _, name := range files {
		data, rerr := os.ReadFile("../migrations/" + name)
		if rerr != nil {
			itErr = rerr
			return
		}
		if _, eerr := db.PGExec(ctx, string(data)); eerr != nil {
			itUnapplied = append(itUnapplied, name)
		}
	}
	itDB = db
}

// isTestDatabaseURL reports whether the URL's database name ends in _test.
func isTestDatabaseURL(url string) bool {
	if i := strings.IndexAny(url, "?"); i >= 0 {
		url = url[:i]
	}
	name := url
	if i := strings.LastIndex(url, "/"); i >= 0 {
		name = url[i+1:]
	}
	return strings.HasSuffix(name, "_test")
}

// ── The schema the features need ─────────────────────────────────────────────

// Which legacy migrations could not replay. Informational: the chain's
// unreplayability is a known property (see the file comment), and this prints the
// list so it can be tracked rather than forgotten.
func TestLegacyMigrationsThatCannotReplay(t *testing.T) {
	integrationDB(t)
	if len(itUnapplied) == 0 {
		t.Log("every migration applied from the baseline fixture")
		return
	}
	t.Logf("%d migration(s) could not replay onto the fixture: %s",
		len(itUnapplied), strings.Join(itUnapplied, ", "))
}

// This is the hard assertion: whatever the legacy chain did or did not do, the
// objects the tested features depend on must exist.
func TestSchemaObjectsExist(t *testing.T) {
	db := integrationDB(t)
	ctx := context.Background()

	for _, c := range []struct{ what, query string }{
		{"app.upload_audit_log (245)", `SELECT to_regclass('app.upload_audit_log') IS NOT NULL`},
		{"app.merchant_alias (244)", `SELECT to_regclass('app.merchant_alias') IS NOT NULL`},
		{"app.merchant_alias_rejected (258)", `SELECT to_regclass('app.merchant_alias_rejected') IS NOT NULL`},
		{"app.pipeline_source (238)", `SELECT to_regclass('app.pipeline_source') IS NOT NULL`},
		{"app.v_pipeline_freshness (238/257/259)", `SELECT to_regclass('app.v_pipeline_freshness') IS NOT NULL`},
		{"pipeline_source.notify_roles (256)", `SELECT EXISTS (SELECT 1 FROM information_schema.columns
			WHERE table_schema='app' AND table_name='pipeline_source' AND column_name='notify_roles')`},
		{"pipeline_source.business_days_only (259)", `SELECT EXISTS (SELECT 1 FROM information_schema.columns
			WHERE table_schema='app' AND table_name='pipeline_source' AND column_name='business_days_only')`},
		{"v_pipeline_freshness.effective_data_age (259)", `SELECT EXISTS (SELECT 1 FROM information_schema.columns
			WHERE table_schema='app' AND table_name='v_pipeline_freshness' AND column_name='effective_data_age')`},
		{"app.resolve_currency (243)", `SELECT to_regprocedure('app.resolve_currency(text,text,text)') IS NOT NULL`},
		{"app.clean_merchant (244)", `SELECT to_regprocedure('app.clean_merchant(text)') IS NOT NULL`},
		{"app.refresh_merchant_aliases (244/258)", `SELECT to_regprocedure('app.refresh_merchant_aliases()') IS NOT NULL`},
	} {
		var ok bool
		if err := db.PG.QueryRowContext(ctx, c.query).Scan(&ok); err != nil {
			t.Errorf("%s: query failed: %v", c.what, err)
			continue
		}
		if !ok {
			t.Errorf("%s: missing after migrations", c.what)
		}
	}
}

// ── Data Freshness ───────────────────────────────────────────────────────────

// The monitor and the page share one projection, over columns three migrations
// added. This proves the query runs and that values arrive as the types the page
// assumes — a bool that came back as a string would render wrong, not error.
func TestPipelineHealthEndpoint(t *testing.T) {
	db := integrationDB(t)

	rec := httptest.NewRecorder()
	pipelineHealth(db)(rec, httptest.NewRequest(http.MethodGet, "/api/admin/pipeline", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, body: %s", rec.Code, rec.Body.String())
	}
	var env struct {
		Data struct {
			Sources []map[string]any `json:"sources"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("decode: %v — body: %s", err, rec.Body.String())
	}
	if len(env.Data.Sources) == 0 {
		t.Fatal("no sources returned; migration 238 seeds them")
	}
	row := env.Data.Sources[0]
	for _, k := range []string{
		"source_key", "label", "state", "run_state",
		"data_age_sec", "effective_data_age_sec", "business_days_only",
		"notify_roles", "recipient_count", "warn_after_sec", "stale_after_sec",
	} {
		if _, present := row[k]; !present {
			t.Errorf("key %q missing from the projection the page reads", k)
		}
	}
	for _, s := range env.Data.Sources {
		if v, present := s["business_days_only"]; present && v != nil {
			if _, isBool := v.(bool); !isBool {
				t.Errorf("business_days_only for %v arrived as %T, want bool", s["source_key"], v)
			}
			break
		}
	}
	// Exactly one source is weekend-aware: the call centre (migration 259).
	var weekendAware []any
	for _, s := range env.Data.Sources {
		if b, _ := s["business_days_only"].(bool); b {
			weekendAware = append(weekendAware, s["source_key"])
		}
	}
	if len(weekendAware) != 1 || weekendAware[0] != "zoho_calls" {
		t.Errorf("weekend-aware sources = %v, want [zoho_calls]", weekendAware)
	}
}

func TestPipelineAlertsEndpoint(t *testing.T) {
	db := integrationDB(t)
	rec := httptest.NewRecorder()
	pipelineAlerts(db)(rec, httptest.NewRequest(http.MethodGet, "/api/admin/pipeline/alerts", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, body: %s", rec.Code, rec.Body.String())
	}
}

// ── Uploads ──────────────────────────────────────────────────────────────────

// The bug this exists for: the panel read only upload_audit_log, but Interswitch
// settlement records runs in interswitch_imports, so its row would have said
// "never uploaded" for ever — including right after an upload.
func TestUploadsOverdueFindsBothLedgers(t *testing.T) {
	db := integrationDB(t)
	ctx := context.Background()

	if _, err := db.PGExec(ctx, `
		INSERT INTO app.interswitch_imports (started_at, status, files_n, legs_n, inserted_n, skipped_n)
		VALUES (now() - interval '2 hours', 'ok', 1, 10, 10, 0)`); err != nil {
		t.Fatalf("seed interswitch_imports: %v", err)
	}
	t.Cleanup(func() { db.PGExec(ctx, `DELETE FROM app.interswitch_imports`) }) //nolint:errcheck

	rec := httptest.NewRecorder()
	uploadsOverdue(db)(rec, httptest.NewRequest(http.MethodGet, "/api/uploads/pending", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, body: %s", rec.Code, rec.Body.String())
	}
	rows := decodeRows(t, rec)
	var found bool
	for _, r := range rows {
		if r["source_key"] == "interswitch_settlement" {
			found = true
			if r["last_upload_at"] == nil {
				t.Error("settlement's last upload is nil despite a run in interswitch_imports — the bug is back")
			}
		}
	}
	if !found {
		t.Error("interswitch_settlement missing from the overdue panel")
	}
}

func TestUploadLedgerRoundTrip(t *testing.T) {
	db := integrationDB(t)
	ctx := context.Background()

	req := httptest.NewRequest(http.MethodPost, "/api/uploads", nil)
	recordUpload(ctx, db, req, "card_cycle", []string{"cycle_2026_09.csv"}, "2026-09-14",
		map[string]any{"rows_upserted": 42}, 42, 0, nil)
	t.Cleanup(func() { db.PGExec(ctx, `DELETE FROM app.upload_audit_log`) }) //nolint:errcheck

	rec := httptest.NewRecorder()
	uploadAuditLog(db)(rec, httptest.NewRequest(http.MethodGet, "/api/uploads/audit?limit=50", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, body: %s", rec.Code, rec.Body.String())
	}
	var seen bool
	for _, r := range decodeRows(t, rec) {
		if r["report_type"] == "card_cycle" {
			seen = true
			if r["status"] != "success" {
				t.Errorf("status = %v, want success", r["status"])
			}
		}
	}
	if !seen {
		t.Error("the recorded upload did not come back from the audit endpoint")
	}
}

// ── Merchant aliases ─────────────────────────────────────────────────────────

func TestMerchantAliasLifecycle(t *testing.T) {
	db := integrationDB(t)
	ctx := context.Background()
	t.Cleanup(func() {
		db.PGExec(ctx, `DELETE FROM app.merchant_alias WHERE clean_name LIKE 'ZZTEST%'`)          //nolint:errcheck
		db.PGExec(ctx, `DELETE FROM app.merchant_alias_rejected WHERE clean_name LIKE 'ZZTEST%'`) //nolint:errcheck
	})

	rec := httptest.NewRecorder()
	merchantAliasUpsert(db)(rec, jsonReq(`{"clean_name":"ZZTEST SHOP LIMITE","canonical":"ZZTEST SHOP LTD"}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("upsert status %d: %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	merchantAliasList(db)(rec, httptest.NewRequest(http.MethodGet, "/api/admin/merchant-aliases?status=all", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("list status %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "ZZTEST SHOP") {
		t.Error("the mapping just written is not in the list")
	}

	rec = httptest.NewRecorder()
	merchantAliasReject(db)(rec, jsonReq(`{"clean_name":"ZZTEST SHOP LIMITE"}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("reject status %d: %s", rec.Code, rec.Body.String())
	}
	var aliasRows, tombstones int
	db.PG.QueryRowContext(ctx, `SELECT count(*) FROM app.merchant_alias WHERE clean_name = 'ZZTEST SHOP LIMITE'`).Scan(&aliasRows)           //nolint:errcheck
	db.PG.QueryRowContext(ctx, `SELECT count(*) FROM app.merchant_alias_rejected WHERE clean_name = 'ZZTEST SHOP LIMITE'`).Scan(&tombstones) //nolint:errcheck
	if aliasRows != 0 {
		t.Error("the alias survived rejection")
	}
	if tombstones != 1 {
		t.Error("no tombstone recorded, so the daily job will propose this merge again")
	}
}

func TestMerchantAliasRejectsBadInput(t *testing.T) {
	db := integrationDB(t)
	ctx := context.Background()
	t.Cleanup(func() {
		db.PGExec(ctx, `DELETE FROM app.merchant_alias WHERE clean_name LIKE 'ZZCYCLE%'`) //nolint:errcheck
	})

	for _, c := range []struct {
		name, body string
		wantCode   int
	}{
		{"same name both sides", `{"clean_name":"ZZSAME LTD","canonical":"ZZSAME LTD"}`, http.StatusBadRequest},
		{"no letters", `{"clean_name":"0000","canonical":"1111"}`, http.StatusBadRequest},
		{"missing field", `{"clean_name":"ZZONLY"}`, http.StatusBadRequest},
	} {
		rec := httptest.NewRecorder()
		merchantAliasUpsert(db)(rec, jsonReq(c.body))
		if rec.Code != c.wantCode {
			t.Errorf("%s: status %d, want %d (body: %s)", c.name, rec.Code, c.wantCode, strings.TrimSpace(rec.Body.String()))
		}
	}

	rec := httptest.NewRecorder()
	merchantAliasUpsert(db)(rec, jsonReq(`{"clean_name":"ZZCYCLE ONE LTD","canonical":"ZZCYCLE TWO LTD"}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("first mapping failed: %s", rec.Body.String())
	}
	rec = httptest.NewRecorder()
	merchantAliasUpsert(db)(rec, jsonReq(`{"clean_name":"ZZCYCLE TWO LTD","canonical":"ZZCYCLE ONE LTD"}`))
	if rec.Code != http.StatusConflict {
		t.Errorf("reverse mapping status %d, want 409 — a cycle makes the canonical name order-dependent", rec.Code)
	}
}

func TestRefreshSkipsRejectedMerges(t *testing.T) {
	db := integrationDB(t)
	ctx := context.Background()
	t.Cleanup(func() {
		db.PGExec(ctx, `DELETE FROM app.merchant_alias_rejected WHERE clean_name LIKE 'ZZREJ%'`) //nolint:errcheck
	})
	if _, err := db.PGExec(ctx, `
		INSERT INTO app.merchant_alias_rejected (clean_name, canonical)
		VALUES ('ZZREJ SHORT NAME HERE', 'ZZREJ SHORT NAME HERE LTD')`); err != nil {
		t.Fatalf("seed tombstone: %v", err)
	}
	var added sql.NullInt64
	if err := db.PG.QueryRowContext(ctx, `SELECT app.refresh_merchant_aliases()`).Scan(&added); err != nil {
		t.Fatalf("refresh failed: %v", err)
	}
	var back int
	db.PG.QueryRowContext(ctx,
		`SELECT count(*) FROM app.merchant_alias WHERE clean_name = 'ZZREJ SHORT NAME HERE'`).Scan(&back) //nolint:errcheck
	if back != 0 {
		t.Error("the refresh re-proposed a rejected merge")
	}
}

// ── helpers ──────────────────────────────────────────────────────────────────

func jsonReq(body string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	return r
}

// decodeRows accepts a bare array or the { data: [...] } envelope, since the
// handlers use both jsonRows and respond.
func decodeRows(t *testing.T, rec *httptest.ResponseRecorder) []map[string]any {
	t.Helper()
	var asArray []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &asArray); err == nil {
		return asArray
	}
	var env struct {
		Data []map[string]any `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("decode: %v — body: %s", err, rec.Body.String())
	}
	return env.Data
}

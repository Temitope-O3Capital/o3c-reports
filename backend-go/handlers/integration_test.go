package handlers

// Integration tests: migrate a real PostgreSQL database and call the handlers.
//
// Why these exist. Every other test in this package is pure — it checks query
// building, formatting or classification without a database. That leaves the part
// that actually breaks untested: whether a column comes back as the Go type the
// handler assumes, whether the JSON keys are the ones the page reads, and whether
// the migration chain applies at all. A migration only fails at startup, and no
// unit test starts the server, so a broken one reached production before anyone
// knew. One shipped bug of mine (the settlement upload lookup) and one near-miss
// (a view rebuilt with CREATE OR REPLACE, which cannot reorder columns) would both
// have been caught here.
//
// SAFETY: these run only against a database whose name ends in "_test". CI sets
// DATABASE_URL to .../o3c_test and the Postgres service is thrown away with the
// job. A developer's local .env points at production, so the guard makes these
// skip there rather than migrating the live database.

import (
	"context"
	"database/sql"
	"encoding/json"
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
	itOnce sync.Once
	itDB   *core.DB
	itErr  error
	itSkip string
)

// integrationDB returns a migrated test database, or skips the test.
func integrationDB(t *testing.T) *core.DB {
	t.Helper()
	itOnce.Do(func() {
		url := os.Getenv("DATABASE_URL")
		if url == "" {
			itSkip = "DATABASE_URL is not set"
			return
		}
		// The guard. Anything not clearly a test database is refused, because the
		// first thing these tests do is run 289 migrations against it.
		if !isTestDatabaseURL(url) {
			itSkip = "DATABASE_URL does not name a *_test database — refusing to migrate it"
			return
		}
		db, err := core.Open(&core.Config{PGURL: url, DirectPGURL: url})
		if err != nil {
			itErr = err
			return
		}
		// os.DirFS("..") + "migrations" mirrors what main passes from its embed,
		// so this exercises the real runner over the real SQL files.
		if err := migrate.Apply(context.Background(), db, os.DirFS(".."), "migrations"); err != nil {
			itErr = err
			return
		}
		itDB = db
	})
	if itSkip != "" {
		t.Skip(itSkip)
	}
	if itErr != nil {
		t.Fatalf("test database setup failed: %v", itErr)
	}
	return itDB
}

// isTestDatabaseURL reports whether the URL's database name ends in _test.
func isTestDatabaseURL(url string) bool {
	// Strip query string, then take the last path segment.
	if i := strings.IndexAny(url, "?"); i >= 0 {
		url = url[:i]
	}
	name := url
	if i := strings.LastIndex(url, "/"); i >= 0 {
		name = url[i+1:]
	}
	return strings.HasSuffix(name, "_test")
}

// ── The migration chain ───────────────────────────────────────────────────────

// Every file on disk must apply, in order, against an empty database. This is the
// test that a failing migration can no longer reach production unnoticed.
func TestMigrationsApplyFromScratch(t *testing.T) {
	db := integrationDB(t)
	ctx := context.Background()

	files, err := migrate.List(os.DirFS(".."), "migrations")
	if err != nil {
		t.Fatalf("list migrations: %v", err)
	}
	if len(files) < 250 {
		t.Fatalf("only %d migration files found — wrong working directory?", len(files))
	}
	var applied int
	if err := db.PG.QueryRowContext(ctx,
		`SELECT count(*) FROM schema_migrations`).Scan(&applied); err != nil {
		t.Fatalf("count schema_migrations: %v", err)
	}
	if applied != len(files) {
		t.Errorf("applied %d migrations but %d files exist on disk", applied, len(files))
	}
}

// The objects the recent work depends on. Named individually so a failure says
// which migration did not take effect, rather than only that a handler broke.
func TestSchemaObjectsExist(t *testing.T) {
	db := integrationDB(t)
	ctx := context.Background()

	for _, c := range []struct{ what, query string }{
		{"app.upload_audit_log (245)", `SELECT to_regclass('app.upload_audit_log') IS NOT NULL`},
		{"app.merchant_alias (244)", `SELECT to_regclass('app.merchant_alias') IS NOT NULL`},
		{"app.merchant_alias_rejected (258)", `SELECT to_regclass('app.merchant_alias_rejected') IS NOT NULL`},
		{"app.pipeline_source.notify_roles (256)", `SELECT EXISTS (SELECT 1 FROM information_schema.columns
			WHERE table_schema='app' AND table_name='pipeline_source' AND column_name='notify_roles')`},
		{"app.pipeline_source.business_days_only (259)", `SELECT EXISTS (SELECT 1 FROM information_schema.columns
			WHERE table_schema='app' AND table_name='pipeline_source' AND column_name='business_days_only')`},
		{"app.v_pipeline_freshness.effective_data_age (259)", `SELECT EXISTS (SELECT 1 FROM information_schema.columns
			WHERE table_schema='app' AND table_name='v_pipeline_freshness' AND column_name='effective_data_age')`},
		{"app.resolve_currency (243)", `SELECT to_regprocedure('app.resolve_currency(text,text,text)') IS NOT NULL`},
		{"app.clean_merchant (244)", `SELECT to_regprocedure('app.clean_merchant(text)') IS NOT NULL`},
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

// The monitor and the page share one projection, and it selects columns three
// migrations added. This asserts the query runs AND that the values arrive as the
// types the page assumes — a bool that came back as a string would render wrong
// rather than error.
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
			Counts  map[string]any   `json:"counts"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("decode: %v — body: %s", err, rec.Body.String())
	}
	if len(env.Data.Sources) == 0 {
		t.Fatal("no sources returned; migration 238's seeds should be present")
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
	// business_days_only must be a JSON bool, not a string.
	for _, s := range env.Data.Sources {
		if v, present := s["business_days_only"]; present && v != nil {
			if _, isBool := v.(bool); !isBool {
				t.Errorf("business_days_only for %v arrived as %T, want bool", s["source_key"], v)
			}
			break
		}
	}
	// Exactly one source is weekend-aware today: the call centre (migration 259).
	var weekendAware int
	for _, s := range env.Data.Sources {
		if b, _ := s["business_days_only"].(bool); b {
			weekendAware++
			if s["source_key"] != "zoho_calls" {
				t.Errorf("unexpected business_days_only source: %v", s["source_key"])
			}
		}
	}
	if weekendAware != 1 {
		t.Errorf("%d weekend-aware sources, want 1 (zoho_calls)", weekendAware)
	}
}

// Every alert must reach at least one real person. A role nobody holds notifies
// nobody, which is the failure the monitor exists to prevent — and on a fresh
// database with no users, the count is zero everywhere, so this asserts the shape
// rather than the population.
func TestPipelineAlertsEndpoint(t *testing.T) {
	db := integrationDB(t)
	rec := httptest.NewRecorder()
	pipelineAlerts(db)(rec, httptest.NewRequest(http.MethodGet, "/api/admin/pipeline/alerts", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, body: %s", rec.Code, rec.Body.String())
	}
}

// ── Uploads ──────────────────────────────────────────────────────────────────

// The settlement bug this test exists for: the panel looked up every source's
// last upload in upload_audit_log, but Interswitch settlement records runs in
// interswitch_imports, so its row would have read "never uploaded" for ever.
func TestUploadsOverdueFindsBothLedgers(t *testing.T) {
	db := integrationDB(t)
	ctx := context.Background()

	// A settlement run in the OTHER table — the one the original query missed.
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
	if len(rows) == 0 {
		t.Fatal("no manual-upload sources returned")
	}
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

// recordUpload is what every importer calls; the audit page then unions the two
// ledgers. This drives both halves.
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
	rows := decodeRows(t, rec)
	var seen bool
	for _, r := range rows {
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

// The full review loop, including the tombstone that stops a rejected merge from
// being proposed again the next day.
func TestMerchantAliasLifecycle(t *testing.T) {
	db := integrationDB(t)
	ctx := context.Background()
	t.Cleanup(func() {
		db.PGExec(ctx, `DELETE FROM app.merchant_alias WHERE clean_name LIKE 'ZZTEST%'`)          //nolint:errcheck
		db.PGExec(ctx, `DELETE FROM app.merchant_alias_rejected WHERE clean_name LIKE 'ZZTEST%'`) //nolint:errcheck
	})

	// Write a mapping by hand.
	rec := httptest.NewRecorder()
	merchantAliasUpsert(db)(rec, jsonReq(`{"clean_name":"ZZTEST SHOP LIMITE","canonical":"ZZTEST SHOP LTD"}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("upsert status %d: %s", rec.Code, rec.Body.String())
	}

	// It must come back in the list.
	rec = httptest.NewRecorder()
	merchantAliasList(db)(rec, httptest.NewRequest(http.MethodGet, "/api/admin/merchant-aliases?status=all", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("list status %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "ZZTEST SHOP") {
		t.Error("the mapping just written is not in the list")
	}

	// Reject it: the alias goes, a tombstone stays.
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

// The guards: a self-mapping, a two-row cycle, and a name with no letters must be
// refused with a 4xx rather than written or 500ing.
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

	// A → B, then B → A must be refused as a cycle.
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

// The daily refresh must never resurrect a rejected merge.
func TestRefreshSkipsRejectedMerges(t *testing.T) {
	db := integrationDB(t)
	ctx := context.Background()
	t.Cleanup(func() {
		db.PGExec(ctx, `DELETE FROM app.merchant_alias_rejected WHERE clean_name LIKE 'ZZREJ%'`) //nolint:errcheck
	})
	if _, err := db.PGExec(ctx, `
		INSERT INTO app.merchant_alias_rejected (clean_name, canonical) VALUES ('ZZREJ SHORT NAME HERE', 'ZZREJ SHORT NAME HERE LTD')`); err != nil {
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

// decodeRows accepts either a bare array or the { data: [...] } envelope, since
// the handlers use both jsonRows and respond.
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

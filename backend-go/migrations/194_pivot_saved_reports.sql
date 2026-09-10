-- 194_pivot_saved_reports.sql
--
-- Persistence + delivery for the drag-and-drop Report Builder (the pivot engine
-- in reports_pivot.go). A "saved report" is just the builder's configuration —
-- dataset key, rows/columns/values/aggregates, declared filters, a date window
-- and chart view prefs — stored as JSON. Running it re-executes the pivot live,
-- so a saved report is always current; nothing is snapshotted.
--
-- This is deliberately separate from bi_report_definitions: that model runs a
-- fixed per-module query and cannot express an arbitrary pivot, so the two share
-- no run path. Keeping them apart avoids putting two incompatible row shapes in
-- one table.
--
-- Idempotent: safe to run repeatedly.

CREATE TABLE IF NOT EXISTS pivot_reports (
  id          bigserial PRIMARY KEY,
  name        text        NOT NULL,
  description text        NOT NULL DEFAULT '',
  dataset     text        NOT NULL,                 -- export registry dataset key
  config      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  is_public   boolean     NOT NULL DEFAULT FALSE,   -- visible to every reports user, run-only
  created_by  bigint,
  created_at  timestamptz NOT NULL DEFAULT NOW(),
  updated_at  timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pivot_reports_creator ON pivot_reports (created_by);
CREATE INDEX IF NOT EXISTS idx_pivot_reports_public  ON pivot_reports (is_public) WHERE is_public;

CREATE TABLE IF NOT EXISTS pivot_report_schedules (
  id           bigserial PRIMARY KEY,
  report_id    bigint      NOT NULL REFERENCES pivot_reports (id) ON DELETE CASCADE,
  frequency    text        NOT NULL DEFAULT 'daily',  -- daily | weekly | monthly
  hour         int         NOT NULL DEFAULT 7,        -- 0-23, Africa/Lagos local
  day_of_week  int         NOT NULL DEFAULT 1,        -- 0=Sun..6=Sat (weekly)
  day_of_month int         NOT NULL DEFAULT 1,        -- 1-28 (monthly)
  recipients   jsonb       NOT NULL DEFAULT '[]'::jsonb,  -- array of email strings
  format       text        NOT NULL DEFAULT 'xlsx',   -- xlsx | csv
  is_active    boolean     NOT NULL DEFAULT TRUE,
  last_run_at  timestamptz,
  next_run_at  timestamptz,
  last_status  text,
  created_by   bigint,
  created_at   timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pivot_sched_due
  ON pivot_report_schedules (is_active, next_run_at)
  WHERE is_active;

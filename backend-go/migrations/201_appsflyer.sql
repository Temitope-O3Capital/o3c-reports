-- AppsFlyer acquisition mirror: local snapshot of the mobile-app attribution feed.
--
-- "Blink by O3" is measured by AppsFlyer (the MMP) on both iOS and Android. Until
-- now the workspace held NO acquisition data at all — installs, media source,
-- campaigns, ad spend and the signup→KYC→onboarding funnel lived only in the
-- AppsFlyer dashboard. This mirror pulls the Aggregate Pull API's
-- partners_by_date_report on a schedule (backend-go/appsflyersync) and upserts it
-- here, so the workspace has local history to trend, break down and report on.
--
-- AppsFlyer remains the system of record; these tables are only ever written by the
-- sync worker and refreshed by upsert (never truncated), so a day's row survives
-- even after it ages out of the re-pull window. The feed is READ-ONLY.
--
-- Money note: AppsFlyer reports Blink in USD (cost + revenue). Revenue events are
-- not wired into the app SDK today, so total_revenue_usd is ~0; real revenue lives
-- in our own transaction/income data. Cost is populated once paid campaigns run.
-- Columns are stored in the currency AppsFlyer returns (USD) — no silent FX. All
-- install/session/event figures are plain counts, currency-independent.

-- ── Daily fact: one row per (app, date, media source, campaign, agency) ──────────
CREATE TABLE IF NOT EXISTS appsflyer_daily (
    id                 BIGSERIAL PRIMARY KEY,
    app_id             TEXT NOT NULL,                 -- id6768255303 (iOS) | com.o3cards.blink (Android)
    platform           TEXT NOT NULL,                 -- ios | android
    activity_date      DATE NOT NULL,                 -- report "Date" (AppsFlyer app timezone = UTC)
    media_source       TEXT NOT NULL DEFAULT '',      -- pid; 'Organic', 'googleadwords_int', …
    campaign           TEXT NOT NULL DEFAULT '',      -- c; 'None' when not campaign-attributed
    agency             TEXT NOT NULL DEFAULT '',      -- af_prt (Agency/PMD); 'None' when direct
    impressions        BIGINT NOT NULL DEFAULT 0,
    clicks             BIGINT NOT NULL DEFAULT 0,
    installs           BIGINT NOT NULL DEFAULT 0,
    sessions           BIGINT NOT NULL DEFAULT 0,
    loyal_users        BIGINT NOT NULL DEFAULT 0,     -- users past the "loyal" threshold (>=3 sessions)
    total_cost_usd     NUMERIC(18,4) NOT NULL DEFAULT 0,  -- ad spend, USD
    total_revenue_usd  NUMERIC(18,4) NOT NULL DEFAULT 0,  -- in-app revenue reported to AppsFlyer, USD (~0 today)
    raw                JSONB,                         -- the full CSV row, keyed by header
    synced_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Natural key: the report is unique per app × date × source × campaign × agency.
    -- Key columns are NOT NULL (defaulted '') so upserts never trip NULL-distinctness.
    CONSTRAINT appsflyer_daily_natkey UNIQUE (app_id, activity_date, media_source, campaign, agency)
);
CREATE INDEX IF NOT EXISTS idx_af_daily_date     ON appsflyer_daily (activity_date DESC);
CREATE INDEX IF NOT EXISTS idx_af_daily_platform ON appsflyer_daily (platform, activity_date DESC);
CREATE INDEX IF NOT EXISTS idx_af_daily_source   ON appsflyer_daily (media_source, activity_date DESC);

-- ── Tall funnel events: the per-app event columns, unpivoted ─────────────────────
-- The Aggregate Pull report carries a variable set of in-app events (differing
-- between iOS and Android), each as three columns: (Unique users, Event counter,
-- Sales in USD). Storing them tall keeps the schema stable no matter which events
-- the app defines, and lets the acquisition funnel be built with a plain GROUP BY.
-- Denormalised (carries the same dimension key) so the funnel needs no join.
CREATE TABLE IF NOT EXISTS appsflyer_events (
    id             BIGSERIAL PRIMARY KEY,
    app_id         TEXT NOT NULL,
    platform       TEXT NOT NULL,
    activity_date  DATE NOT NULL,
    media_source   TEXT NOT NULL DEFAULT '',
    campaign       TEXT NOT NULL DEFAULT '',
    agency         TEXT NOT NULL DEFAULT '',
    event_name     TEXT NOT NULL,                 -- first_open, registration_start, kyc_result, …
    unique_users   BIGINT NOT NULL DEFAULT 0,
    event_count    BIGINT NOT NULL DEFAULT 0,
    sales_usd      NUMERIC(18,4) NOT NULL DEFAULT 0,
    synced_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT appsflyer_events_natkey UNIQUE (app_id, activity_date, media_source, campaign, agency, event_name)
);
CREATE INDEX IF NOT EXISTS idx_af_events_date  ON appsflyer_events (activity_date DESC);
CREATE INDEX IF NOT EXISTS idx_af_events_name  ON appsflyer_events (event_name, activity_date DESC);
CREATE INDEX IF NOT EXISTS idx_af_events_plat  ON appsflyer_events (platform, event_name, activity_date DESC);

-- ── Sync audit: one row per run (mirrors paystack_sync_runs) ─────────────────────
CREATE TABLE IF NOT EXISTS appsflyer_sync_runs (
    id            BIGSERIAL PRIMARY KEY,
    kind          TEXT NOT NULL,                  -- scheduled | manual | backfill
    status        TEXT NOT NULL DEFAULT 'running',-- running | ok | error
    started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at   TIMESTAMPTZ,
    from_date     DATE,
    to_date       DATE,
    apps_n        INTEGER NOT NULL DEFAULT 0,     -- apps pulled this run
    daily_rows    INTEGER NOT NULL DEFAULT 0,     -- appsflyer_daily rows upserted
    event_rows    INTEGER NOT NULL DEFAULT 0,     -- appsflyer_events rows upserted
    error         TEXT,
    triggered_by  BIGINT
);
CREATE INDEX IF NOT EXISTS idx_af_runs_started ON appsflyer_sync_runs (started_at DESC);

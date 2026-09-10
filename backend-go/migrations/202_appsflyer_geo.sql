-- AppsFlyer geo mirror: country-level acquisition for "Blink by O3".
--
-- The primary appsflyer_daily feed (partners_by_date_report) has no geography. This
-- adds a parallel country breakdown from the geo_by_date_report, kept in its own
-- table so the working daily/events pipeline is untouched. Country is the finest
-- geography the AppsFlyer aggregate API exposes (no state/region in this feed).
--
-- Written ONLY by the sync worker, refreshed by upsert. Money is USD, like the rest
-- of the AppsFlyer mirror. Events are intentionally NOT unpivoted here (the funnel
-- lives in appsflyer_events); this table carries the standard install/engagement KPIs.

CREATE TABLE IF NOT EXISTS appsflyer_geo (
    id                 BIGSERIAL PRIMARY KEY,
    app_id             TEXT NOT NULL,
    platform           TEXT NOT NULL,                 -- ios | android
    activity_date      DATE NOT NULL,
    country            TEXT NOT NULL DEFAULT '',      -- ISO-3166 alpha-2 (NG, US, GB…)
    media_source       TEXT NOT NULL DEFAULT '',
    campaign           TEXT NOT NULL DEFAULT '',
    agency             TEXT NOT NULL DEFAULT '',
    impressions        BIGINT NOT NULL DEFAULT 0,
    clicks             BIGINT NOT NULL DEFAULT 0,
    installs           BIGINT NOT NULL DEFAULT 0,
    sessions           BIGINT NOT NULL DEFAULT 0,
    loyal_users        BIGINT NOT NULL DEFAULT 0,
    total_cost_usd     NUMERIC(18,4) NOT NULL DEFAULT 0,
    total_revenue_usd  NUMERIC(18,4) NOT NULL DEFAULT 0,
    synced_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT appsflyer_geo_natkey UNIQUE (app_id, activity_date, country, media_source, campaign, agency)
);
CREATE INDEX IF NOT EXISTS idx_af_geo_country ON appsflyer_geo (country, activity_date DESC);
CREATE INDEX IF NOT EXISTS idx_af_geo_date    ON appsflyer_geo (activity_date DESC);

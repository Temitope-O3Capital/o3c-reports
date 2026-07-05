-- Migration 060: P12-01 — NDPR data retention audit table
-- Tracks which purge/archive jobs ran and what was actioned.

CREATE TABLE IF NOT EXISTS retention_purge_log (
    id            BIGSERIAL PRIMARY KEY,
    run_date      DATE NOT NULL,
    table_name    TEXT NOT NULL,
    records_purged INT NOT NULL DEFAULT 0,
    records_archived INT NOT NULL DEFAULT 0,
    notes         TEXT,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_retention_purge_date ON retention_purge_log(run_date DESC);

-- Migration 108: BI report builder tables
-- report_configs   — saved report configurations
-- report_export_log — audit trail of every report run / export
-- report_schedules  — scheduled delivery configs

CREATE TABLE IF NOT EXISTS report_configs (
    id          BIGSERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    report_type TEXT NOT NULL,
    filters     JSONB NOT NULL DEFAULT '{}',
    created_by  BIGINT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS report_export_log (
    id          BIGSERIAL PRIMARY KEY,
    report_type TEXT NOT NULL,
    filters     JSONB NOT NULL DEFAULT '{}',
    row_count   INT NOT NULL DEFAULT 0,
    created_by  BIGINT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS report_schedules (
    id               BIGSERIAL PRIMARY KEY,
    report_config_id BIGINT REFERENCES report_configs(id),
    cron_expr        TEXT NOT NULL,
    recipients       TEXT[] NOT NULL DEFAULT '{}',
    is_active        BOOLEAN NOT NULL DEFAULT TRUE,
    created_by       BIGINT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

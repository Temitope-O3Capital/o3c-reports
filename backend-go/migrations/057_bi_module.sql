-- Migration 057: BI Module — report definitions, scheduled reports, run history

CREATE TABLE IF NOT EXISTS bi_report_definitions (
    id            BIGSERIAL PRIMARY KEY,
    name          TEXT      NOT NULL,
    description   TEXT,
    module        TEXT      NOT NULL,
    dimensions    JSONB     NOT NULL DEFAULT '[]',
    metrics       JSONB     NOT NULL DEFAULT '[]',
    filters       JSONB     NOT NULL DEFAULT '{}',
    date_range    TEXT      NOT NULL DEFAULT 'last_30_days',
    created_by    BIGINT    REFERENCES o3c_users(id),
    is_public     BOOLEAN   NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bi_scheduled_reports (
    id              BIGSERIAL PRIMARY KEY,
    report_id       BIGINT    NOT NULL REFERENCES bi_report_definitions(id) ON DELETE CASCADE,
    cron_expr       TEXT      NOT NULL,
    recipients      JSONB     NOT NULL DEFAULT '[]',
    format          TEXT      NOT NULL DEFAULT 'csv',
    is_active       BOOLEAN   NOT NULL DEFAULT TRUE,
    last_run_at     TIMESTAMPTZ,
    next_run_at     TIMESTAMPTZ,
    created_by      BIGINT    REFERENCES o3c_users(id),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bi_report_runs (
    id              BIGSERIAL PRIMARY KEY,
    report_id       BIGINT    NOT NULL REFERENCES bi_report_definitions(id) ON DELETE CASCADE,
    schedule_id     BIGINT    REFERENCES bi_scheduled_reports(id) ON DELETE SET NULL,
    status          TEXT      NOT NULL DEFAULT 'pending',
    row_count       INT,
    error_message   TEXT,
    run_by          BIGINT    REFERENCES o3c_users(id),
    started_at      TIMESTAMPTZ DEFAULT NOW(),
    finished_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_bi_report_module    ON bi_report_definitions(module);
CREATE INDEX IF NOT EXISTS idx_bi_runs_report      ON bi_report_runs(report_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_bi_sched_report     ON bi_scheduled_reports(report_id);
CREATE INDEX IF NOT EXISTS idx_bi_sched_next_run   ON bi_scheduled_reports(next_run_at) WHERE is_active = TRUE;

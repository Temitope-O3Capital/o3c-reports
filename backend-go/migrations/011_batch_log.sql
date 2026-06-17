-- Batch job execution log

CREATE TABLE IF NOT EXISTS batch_log (
    id          BIGSERIAL PRIMARY KEY,
    started_at  TIMESTAMPTZ NOT NULL,
    finished_at TIMESTAMPTZ,
    status      TEXT NOT NULL DEFAULT 'running', -- running, success, partial, failed
    steps       JSONB NOT NULL DEFAULT '[]',
    error_msg   TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_batch_log_started ON batch_log(started_at DESC);

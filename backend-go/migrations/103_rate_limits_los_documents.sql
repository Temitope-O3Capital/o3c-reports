-- 103: persistent rate-limit counters (S12) + LOS document uploads

-- Persistent IP-keyed rate-limit windows. The backend implements
-- httprate.LimitCounter against this table so limits survive pod restarts.
CREATE TABLE IF NOT EXISTS rate_limit_counters (
    key     TEXT        NOT NULL,
    window  TIMESTAMPTZ NOT NULL,
    count   INT         NOT NULL DEFAULT 0,
    PRIMARY KEY (key, window)
);
CREATE INDEX IF NOT EXISTS idx_rlc_window ON rate_limit_counters(window);

-- LOS application documents uploaded to R2 / local fallback
CREATE TABLE IF NOT EXISTS los_documents (
    id              BIGSERIAL    PRIMARY KEY,
    application_id  BIGINT       NOT NULL REFERENCES loan_applications(id) ON DELETE CASCADE,
    doc_type        TEXT         NOT NULL,
    file_name       TEXT         NOT NULL,
    file_url        TEXT         NOT NULL,
    storage_key     TEXT         NOT NULL,
    file_size_bytes INT          NOT NULL DEFAULT 0,
    uploaded_by     BIGINT       REFERENCES o3c_users(id),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_los_docs_application ON los_documents(application_id);

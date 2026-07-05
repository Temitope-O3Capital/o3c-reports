-- Migration 058: Phase 12 — Regulatory compliance tables

CREATE TABLE IF NOT EXISTS data_subject_requests (
    id             BIGSERIAL PRIMARY KEY,
    subject_cif    TEXT,
    subject_name   TEXT,
    subject_email  TEXT,
    request_type   TEXT NOT NULL CHECK (request_type IN ('access','erasure','rectification','portability','objection')),
    status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','resolved','rejected')),
    notes          TEXT,
    assigned_to    BIGINT REFERENCES o3c_users(id),
    resolved_at    TIMESTAMPTZ,
    created_at     TIMESTAMPTZ DEFAULT NOW(),
    updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dsar_status     ON data_subject_requests(status);
CREATE INDEX IF NOT EXISTS idx_dsar_cif        ON data_subject_requests(subject_cif);
CREATE INDEX IF NOT EXISTS idx_dsar_created_at ON data_subject_requests(created_at DESC);

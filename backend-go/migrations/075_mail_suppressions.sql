-- Idempotent: ensureMailSchema already creates this table at runtime.
-- This migration adds it to the tracked schema so Railway deploys stay consistent.
CREATE TABLE IF NOT EXISTS mail_suppressions (
    email      TEXT PRIMARY KEY,
    reason     TEXT NOT NULL DEFAULT 'suppressed',
    source     TEXT NOT NULL DEFAULT 'manual',
    is_active  BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mail_suppressions_active ON mail_suppressions(is_active, updated_at DESC);

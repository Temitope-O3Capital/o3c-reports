-- Double-entry GL journal for all financial operations.
-- Each row represents a balanced debit/credit pair (amount_kobo must be > 0).
CREATE TABLE IF NOT EXISTS gl_journal_entries (
    id             BIGSERIAL PRIMARY KEY,
    entry_date     DATE        NOT NULL,
    description    TEXT        NOT NULL,
    reference      TEXT        NOT NULL,
    debit_account  TEXT        NOT NULL,
    credit_account TEXT        NOT NULL,
    amount_kobo    BIGINT      NOT NULL CHECK (amount_kobo > 0),
    source_type    TEXT        NOT NULL,
    source_id      BIGINT      NOT NULL,
    posted_by      BIGINT      REFERENCES o3c_users(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gl_entries_source    ON gl_journal_entries (source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_gl_entries_date      ON gl_journal_entries (entry_date DESC);
CREATE INDEX IF NOT EXISTS idx_gl_entries_reference ON gl_journal_entries (reference);

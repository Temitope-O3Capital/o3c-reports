-- Migration 028: contact-list metadata used by campaign imports

ALTER TABLE contact_lists ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';

CREATE INDEX IF NOT EXISTS idx_contact_lists_source
    ON contact_lists(source);

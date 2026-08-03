-- Marketing enhancements: WhatsApp templates + saved/reusable contact segments.

-- 1) WhatsApp body on message templates (email + sms already exist; campaigns
--    already support whatsapp via migration 105, templates did not).
ALTER TABLE message_templates ADD COLUMN IF NOT EXISTS whatsapp_body TEXT;

-- 2) Saved contact segments — a reusable, refreshable audience definition.
--    Previously "segments" was a one-shot list generator with no persisted
--    definition. This table stores the filter criteria so a segment can be
--    re-run/refreshed into a contact list on demand.
CREATE TABLE IF NOT EXISTS contact_segments (
    id                BIGSERIAL PRIMARY KEY,
    name              TEXT NOT NULL,
    description       TEXT,
    criteria          JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_count        INTEGER,                         -- last preview/materialize match count
    last_list_id      BIGINT REFERENCES contact_lists(id) ON DELETE SET NULL,
    last_refreshed_at TIMESTAMPTZ,
    created_by        BIGINT REFERENCES o3c_users(id),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contact_segments_created_by ON contact_segments(created_by);

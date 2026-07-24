-- 095_helpdesk_calls_consolidate — M20
-- helpdesk_calls was created in migration 025 and extended in migration 026.
-- This migration is a consolidating safety net: it re-applies all ADD COLUMN IF NOT
-- EXISTS statements so that a fresh schema (or a restore from an intermediate backup
-- that contains 025 but not 026) will have the complete column set after running
-- the migration chain to head.

ALTER TABLE helpdesk_calls ADD COLUMN IF NOT EXISTS zoho_call_id   TEXT;
ALTER TABLE helpdesk_calls ADD COLUMN IF NOT EXISTS zoho_voice_id  TEXT;
ALTER TABLE helpdesk_calls ADD COLUMN IF NOT EXISTS call_to        TEXT;
ALTER TABLE helpdesk_calls ADD COLUMN IF NOT EXISTS recording_url  TEXT;
ALTER TABLE helpdesk_calls ADD COLUMN IF NOT EXISTS transcript     TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_hd_calls_zoho_call
    ON helpdesk_calls(zoho_call_id) WHERE zoho_call_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_hd_calls_zoho_voice
    ON helpdesk_calls(zoho_voice_id) WHERE zoho_voice_id IS NOT NULL;

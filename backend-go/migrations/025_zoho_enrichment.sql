-- Migration 025: Zoho data enrichment columns

-- Ticket enrichment
ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS description         TEXT;
ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS zoho_department_name TEXT;
ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS zoho_thread_count    INT;
ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS zoho_first_resp_min  NUMERIC(10,2);
ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS zoho_resolve_hours   NUMERIC(10,2);
ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS csat_comment         TEXT;

-- Message thread dedup
ALTER TABLE helpdesk_messages ADD COLUMN IF NOT EXISTS zoho_thread_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_hd_messages_zoho_thread
    ON helpdesk_messages(zoho_thread_id) WHERE zoho_thread_id IS NOT NULL;

-- helpdesk_messages: relax direction constraint to allow 'note' value used by Zoho
ALTER TABLE helpdesk_messages DROP CONSTRAINT IF EXISTS helpdesk_messages_direction_check;
ALTER TABLE helpdesk_messages ADD CONSTRAINT helpdesk_messages_direction_check
    CHECK (direction IN ('inbound','outbound','note'));

-- Call enrichment (Zoho Voice)
ALTER TABLE helpdesk_calls ADD COLUMN IF NOT EXISTS recording_url  TEXT;
ALTER TABLE helpdesk_calls ADD COLUMN IF NOT EXISTS transcript     TEXT;
ALTER TABLE helpdesk_calls ADD COLUMN IF NOT EXISTS call_to        TEXT;
ALTER TABLE helpdesk_calls ADD COLUMN IF NOT EXISTS zoho_voice_id  TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_hd_calls_zoho_voice
    ON helpdesk_calls(zoho_voice_id) WHERE zoho_voice_id IS NOT NULL;

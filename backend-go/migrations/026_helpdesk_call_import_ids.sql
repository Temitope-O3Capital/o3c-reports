-- Migration 026: Helpdesk call import dedup columns

CREATE TABLE IF NOT EXISTS helpdesk_calls (
  id             BIGSERIAL PRIMARY KEY,
  agent_id       BIGINT REFERENCES o3c_users(id),
  agent_name     TEXT NOT NULL DEFAULT '',
  customer_name  TEXT NOT NULL DEFAULT '',
  customer_cif   TEXT NOT NULL DEFAULT '',
  customer_email TEXT NOT NULL DEFAULT '',
  customer_phone TEXT NOT NULL DEFAULT '',
  direction      TEXT NOT NULL DEFAULT 'inbound',
  duration_sec   INT,
  outcome        TEXT NOT NULL DEFAULT 'resolved',
  notes          TEXT,
  ticket_id      BIGINT REFERENCES helpdesk_tickets(id) ON DELETE SET NULL,
  ticket_ref     TEXT,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE helpdesk_calls ADD COLUMN IF NOT EXISTS zoho_call_id TEXT;
ALTER TABLE helpdesk_calls ADD COLUMN IF NOT EXISTS zoho_voice_id TEXT;
ALTER TABLE helpdesk_calls ADD COLUMN IF NOT EXISTS call_to TEXT;
ALTER TABLE helpdesk_calls ADD COLUMN IF NOT EXISTS recording_url TEXT;
ALTER TABLE helpdesk_calls ADD COLUMN IF NOT EXISTS transcript TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_hd_calls_zoho_id
    ON helpdesk_calls(zoho_call_id) WHERE zoho_call_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_hd_calls_zoho_voice
    ON helpdesk_calls(zoho_voice_id) WHERE zoho_voice_id IS NOT NULL;

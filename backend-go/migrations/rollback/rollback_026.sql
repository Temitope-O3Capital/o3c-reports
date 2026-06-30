-- Rollback for 026_helpdesk_call_import_ids
ALTER TABLE helpdesk_calls DROP COLUMN IF EXISTS zoho_call_id;
ALTER TABLE helpdesk_calls DROP COLUMN IF EXISTS zoho_voice_id;
ALTER TABLE helpdesk_calls DROP COLUMN IF EXISTS call_to;
ALTER TABLE helpdesk_calls DROP COLUMN IF EXISTS recording_url;
DROP TABLE IF EXISTS helpdesk_calls;

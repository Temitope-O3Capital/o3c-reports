-- Rollback for 023_mail_inbound_replies
DROP INDEX IF EXISTS idx_inbound_mail_message;
ALTER TABLE inbound_mail DROP COLUMN IF EXISTS message_id;
ALTER TABLE inbound_mail DROP COLUMN IF EXISTS in_reply_to;
ALTER TABLE inbound_mail DROP COLUMN IF EXISTS raw_headers;

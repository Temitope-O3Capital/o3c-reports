-- 023_mail_inbound_replies.sql
-- Link inbound parsed replies back to outbound messages.

ALTER TABLE inbound_mail
  ADD COLUMN IF NOT EXISTS mail_message_id BIGINT REFERENCES mail_messages(id) ON DELETE SET NULL;

ALTER TABLE inbound_mail ADD COLUMN IF NOT EXISTS message_id TEXT;
ALTER TABLE inbound_mail ADD COLUMN IF NOT EXISTS in_reply_to TEXT;
ALTER TABLE inbound_mail ADD COLUMN IF NOT EXISTS raw_headers TEXT;

CREATE INDEX IF NOT EXISTS idx_inbound_mail_message
  ON inbound_mail(mail_message_id, received_at DESC)
  WHERE mail_message_id IS NOT NULL;

INSERT INTO settings (key, value)
VALUES ('mail_inbound_domain', '')
ON CONFLICT (key) DO NOTHING;

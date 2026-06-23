-- 022_termii_sms_credentials.sql
-- Seed SMS webhook secret credential for existing installations.

INSERT INTO api_credentials (key_name, description, category, is_secret)
VALUES ('SMS_WEBHOOK_SECRET', 'SMS provider webhook verification secret', 'messaging', TRUE)
ON CONFLICT (key_name) DO NOTHING;

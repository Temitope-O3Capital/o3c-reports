-- Migration 020: Email config credentials + is_secret flag on api_credentials
-- Idempotent — safe to run multiple times

-- Add is_secret flag so the UI knows whether to mask the input field
ALTER TABLE api_credentials ADD COLUMN IF NOT EXISTS is_secret BOOLEAN NOT NULL DEFAULT TRUE;

-- All existing keys are secrets (API keys, tokens)
UPDATE api_credentials SET is_secret = TRUE;

-- Add email configuration credentials (not secrets — visible in the UI)
INSERT INTO api_credentials (key_name, description, category, is_secret) VALUES
('EMAIL_FROM_ADDRESS', 'Sender email address for all outgoing notifications and campaigns (e.g. care@o3cards.com)', 'messaging', FALSE),
('EMAIL_FROM_NAME',    'Sender display name shown in email clients (e.g. Care)',                                   'messaging', FALSE),
('EMAIL_LOGO_URL',     'Absolute URL of the logo image included in email headers (e.g. https://o3cards.com/logo.png)', 'messaging', FALSE)
ON CONFLICT (key_name) DO UPDATE
    SET description = EXCLUDED.description,
        is_secret   = EXCLUDED.is_secret;

-- Seed default values (will be overwritten when admin saves via UI)
UPDATE api_credentials
SET encrypted_value = 'care@o3cards.com', is_active = TRUE, updated_at = NOW()
WHERE key_name = 'EMAIL_FROM_ADDRESS' AND (encrypted_value IS NULL OR encrypted_value = '');

UPDATE api_credentials
SET encrypted_value = 'Care', is_active = TRUE, updated_at = NOW()
WHERE key_name = 'EMAIL_FROM_NAME' AND (encrypted_value IS NULL OR encrypted_value = '');

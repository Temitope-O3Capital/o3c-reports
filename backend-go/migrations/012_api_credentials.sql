-- 012_api_credentials
CREATE TABLE IF NOT EXISTS api_credentials (
    key_name        TEXT PRIMARY KEY,
    encrypted_value TEXT NOT NULL DEFAULT '',
    description     TEXT,
    category        TEXT DEFAULT 'general',  -- 'messaging', 'payments', 'telephony', 'general'
    is_active       BOOLEAN DEFAULT true,
    last_tested_at  TIMESTAMPTZ,
    test_status     TEXT,  -- 'ok' | 'failed' | null
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_by      BIGINT REFERENCES o3c_users(id)
);

-- Seed with key names (no values — admin must enter them via the platform settings UI)
INSERT INTO api_credentials (key_name, description, category) VALUES
    ('SENDGRID_API_KEY',      'SendGrid email API key',                    'messaging'),
    ('TERMII_API_KEY',        'Termii SMS API key',                        'messaging'),
    ('TERMII_SENDER_ID',      'Termii SMS sender ID',                      'messaging'),
    ('SMS_WEBHOOK_SECRET',    'SMS provider webhook verification secret',   'messaging'),
    ('PAYSTACK_SECRET_KEY',   'Paystack payment gateway secret key',       'payments'),
    ('PAYSTACK_PUBLIC_KEY',   'Paystack payment gateway public key',       'payments'),
    ('INTERSWITCH_CLIENT_ID', 'Interswitch client ID',                     'payments'),
    ('INTERSWITCH_SECRET',    'Interswitch client secret',                 'payments'),
    ('ZOHO_CLIENT_ID',        'Zoho Voice/Call Center client ID',          'telephony'),
    ('ZOHO_CLIENT_SECRET',    'Zoho Voice/Call Center client secret',      'telephony'),
    ('ZOHO_REFRESH_TOKEN',    'Zoho OAuth refresh token',                  'telephony')
ON CONFLICT (key_name) DO NOTHING;

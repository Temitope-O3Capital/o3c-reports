-- Migration 021: Email sender identities
-- Idempotent — safe to run multiple times

CREATE TABLE IF NOT EXISTS email_senders (
    id         BIGSERIAL PRIMARY KEY,
    address    TEXT NOT NULL,
    name       TEXT NOT NULL,
    label      TEXT NOT NULL,
    purpose    TEXT NOT NULL DEFAULT 'general', -- 'promo','internal','helpdesk','transactional','general'
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    is_active  BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_senders_default_purpose
    ON email_senders (purpose) WHERE is_default = TRUE AND is_active = TRUE;

-- Seed defaults from what is already configured
INSERT INTO email_senders (address, name, label, purpose, is_default) VALUES
('care@o3cards.com',          'O3 Capital',         'Customer Support',   'helpdesk',      TRUE),
('care@o3cards.com',          'O3 Capital',         'Transactional',      'transactional', TRUE),
('notifications@o3cards.com', 'O3 Capital',         'Internal Alerts',    'internal',      TRUE),
('promo@o3cards.com',         'O3 Capital Offers',  'Promotions',         'promo',         TRUE)
ON CONFLICT DO NOTHING;

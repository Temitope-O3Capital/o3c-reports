-- Migration 051: Vendor Integration Registry (Wave 5I)

CREATE TABLE IF NOT EXISTS vendor_integrations (
    id             BIGSERIAL PRIMARY KEY,
    name           TEXT        NOT NULL,
    type           TEXT        NOT NULL,
    status         TEXT        NOT NULL DEFAULT 'unknown',  -- active | degraded | down | unknown
    health_url     TEXT,                                    -- URL to ping for health check
    last_ping      TIMESTAMPTZ,
    last_status_code INT,
    key_expiry     TIMESTAMPTZ,
    owner          TEXT        NOT NULL DEFAULT 'IT Admin',
    notes          TEXT        NOT NULL DEFAULT '',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vi_status ON vendor_integrations(status);

-- Pre-seed known integrations
INSERT INTO vendor_integrations (name, type, status, owner, notes) VALUES
  ('SendGrid',         'Email Delivery',   'active',  'IT Admin',  'Transactional email + campaigns. API key in api_credentials.'),
  ('Zoho Voice',       'Call Center',      'active',  'IT Admin',  'VoIP + call recording for contact centre.'),
  ('Microsoft Graph',  'Email Inbound',    'active',  'IT Admin',  'OAuth2 for reading inbound mail (helpdesk@o3cards.com).'),
  ('Supabase',         'Primary Database', 'active',  'IT Admin',  'PostgreSQL. Connection string in DATABASE_URL env var.'),
  ('Railway',          'Hosting / CI/CD',  'active',  'IT Admin',  'Backend API + workers. Auto-deploy on push to main.'),
  ('Cloudflare Pages', 'Frontend CDN',     'active',  'IT Admin',  'Frontend SPA. Auto-deploys from GitHub Actions.'),
  ('MSSQL Tunnel',     'Card Data Source', 'unknown', 'Cards Ops', 'Cloudflare Tunnel → on-site MSSQL for live card data.'),
  ('Eye Service',      'Credit Scoring',   'active',  'Risk Team', 'Internal ML scoring service on port 8001.'),
  ('NIP / NIBSS',      'Payment Rails',    'unknown', 'Finance',   'NIP inter-bank settlement. Credentials pending from NIBSS.'),
  ('WhatsApp API',     'Messaging',        'unknown', 'Marketing', 'Meta WhatsApp Business API.')
ON CONFLICT DO NOTHING;

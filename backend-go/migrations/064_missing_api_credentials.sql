-- 064_missing_api_credentials.sql
-- Seeds api_credentials rows for keys that the backend resolves via resolveCredKey()
-- but were never added to the admin UI. Values are empty — admin enters them at
-- /admin/api-keys. All are idempotent via ON CONFLICT DO NOTHING.

INSERT INTO api_credentials (key_name, description, category, is_secret) VALUES

-- Zoho call center (ZOHO_CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN seeded in 012)
('ZOHO_ORG_ID',   'Zoho organisation ID (shown in Zoho One admin → Company Details)', 'telephony', FALSE),
('ZOHO_DC',       'Zoho data-centre region: com | eu | in | com.au | jp | ca (default: com)', 'telephony', FALSE),

-- WhatsApp Business
('WHATSAPP_PHONE_NUMBER_ID', 'Meta Business phone number ID from the App Dashboard',   'messaging', FALSE),
('WHATSAPP_ACCESS_TOKEN',    'WhatsApp Business API permanent access token',           'messaging', TRUE),

-- Email webhooks + redirects
('EMAIL_WEBHOOK_SECRET',  'HMAC secret for verifying inbound email-event webhooks',   'messaging', TRUE),
('EMAIL_REDIRECT_DOMAIN', 'Base URL for email unsubscribe and click-tracking links (e.g. https://api.o3capital.ng)', 'messaging', FALSE),
('HELPDESK_INBOX_ADDRESS','Inbound email address that auto-creates helpdesk tickets when mail arrives', 'messaging', FALSE),

-- Board pack
('BOARD_EMAIL_LIST', 'Comma-separated email addresses for monthly board pack delivery', 'general', FALSE),

-- SendGrid reply-to (optionally overrides the FROM address in transactional mail)
('SENDGRID_REPLY_TO_EMAIL', 'Reply-To address for transactional emails (optional; defaults to FROM address)', 'messaging', FALSE)

ON CONFLICT (key_name) DO NOTHING;

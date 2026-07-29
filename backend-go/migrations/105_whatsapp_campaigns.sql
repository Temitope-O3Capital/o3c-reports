-- 105: WhatsApp campaign channel
-- Adds whatsapp_body, template name, counters to campaigns;
-- adds per-contact whatsapp delivery tracking to campaign_contacts.

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS whatsapp_body          TEXT,
  ADD COLUMN IF NOT EXISTS whatsapp_template_name TEXT,
  ADD COLUMN IF NOT EXISTS whatsapp_sent          INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS whatsapp_delivered     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS whatsapp_failed        INTEGER NOT NULL DEFAULT 0;

ALTER TABLE campaign_contacts
  ADD COLUMN IF NOT EXISTS whatsapp_status      TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS whatsapp_sent_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS whatsapp_provider_id TEXT;

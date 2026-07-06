-- 062: HMAC blind indexes on campaign PII columns
-- Adds phone_hmac / email_hmac to both source and snapshot tables so
-- lookups (dedup, DNC check, contact search) don't require plaintext scans.
-- The application computes HMAC-SHA256(lower(trim(value)), ENCRYPTION_KEY).
-- Existing rows get NULL and are back-filled by the app at next campaign start.

ALTER TABLE contact_list_members
  ADD COLUMN IF NOT EXISTS phone_hmac TEXT,
  ADD COLUMN IF NOT EXISTS email_hmac TEXT;

CREATE INDEX IF NOT EXISTS idx_clm_phone_hmac
  ON contact_list_members(phone_hmac)
  WHERE phone_hmac IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_clm_email_hmac
  ON contact_list_members(email_hmac)
  WHERE email_hmac IS NOT NULL;

ALTER TABLE campaign_contacts
  ADD COLUMN IF NOT EXISTS phone_hmac TEXT,
  ADD COLUMN IF NOT EXISTS email_hmac TEXT;

CREATE INDEX IF NOT EXISTS idx_cc_phone_hmac
  ON campaign_contacts(phone_hmac)
  WHERE phone_hmac IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cc_email_hmac
  ON campaign_contacts(email_hmac)
  WHERE email_hmac IS NOT NULL;

-- R2: Encrypt BVN/NIN in crm_contacts.id_number.
-- Add encrypted + HMAC blind-index columns. Existing plaintext rows are
-- backfilled by the application on next write; a one-time admin script can
-- backfill in bulk. The id_number column is deprecated and cleared on write.

ALTER TABLE crm_contacts
  ADD COLUMN IF NOT EXISTS id_number_enc  TEXT,
  ADD COLUMN IF NOT EXISTS id_number_hmac TEXT;

CREATE INDEX IF NOT EXISTS idx_crm_contacts_id_hmac ON crm_contacts(id_number_hmac)
  WHERE id_number_hmac IS NOT NULL;

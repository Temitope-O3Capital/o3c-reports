-- 111_crm_contacts_external_id.sql
-- Dedup key for imported CRM contacts (Zoho Desk migration). crm_contacts.source
-- already exists for provenance ('zoho_desk'); external_id holds the origin record
-- id so re-running the contact import is idempotent.
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS external_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_contacts_source_external
    ON crm_contacts(source, external_id) WHERE external_id IS NOT NULL;

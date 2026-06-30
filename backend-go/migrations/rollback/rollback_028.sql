-- Rollback for 028_contact_list_source
DROP INDEX IF EXISTS idx_contact_lists_source;
ALTER TABLE contact_lists DROP COLUMN IF EXISTS source;

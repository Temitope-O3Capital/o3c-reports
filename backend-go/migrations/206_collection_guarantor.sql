-- 206: guarantor fields for uploaded loans, so guarantor name/contact live in their
-- own columns instead of being crammed into the free-text notes. Additive, nullable.
ALTER TABLE app.collection_assignments ADD COLUMN IF NOT EXISTS guarantor_name    text;
ALTER TABLE app.collection_assignments ADD COLUMN IF NOT EXISTS guarantor_contact text;

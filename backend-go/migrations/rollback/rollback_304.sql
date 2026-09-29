-- Rollback for 304_a_lead_converts_on_a_product
--
-- The columns are additive, so this is a clean drop. What it does NOT restore is the
-- ability to convert a loan or a fixed-deposit lead — after this runs, convertLead's
-- card-CIF-only rule is the only rule again, and any lead converted on a loan or FD
-- since the deploy keeps lead_stage='converted' but loses the record of what it
-- converted on. Those rows are worth listing before running:
--
--   SELECT id, first_name, last_name, converted_line, converted_ref, converted_at
--     FROM app.crm_contacts
--    WHERE converted_line IN ('loans','fixed_deposit');
--
-- Card conversions are unaffected: their reference also lives in converted_cif, which
-- 304 never touched and this does not drop.
--
-- party_id links written by 304's ensure_lead_party pass are deliberately LEFT IN
-- PLACE. They are a correct statement about who the customer is, independent of how the
-- conversion was recorded, and other modules read them.

DROP INDEX IF EXISTS app.idx_crm_contacts_converted_line;

ALTER TABLE app.crm_contacts
    DROP CONSTRAINT IF EXISTS crm_contacts_converted_ref_chk,
    DROP CONSTRAINT IF EXISTS crm_contacts_converted_line_chk;

ALTER TABLE app.crm_contacts
    DROP COLUMN IF EXISTS converted_ref,
    DROP COLUMN IF EXISTS converted_line;

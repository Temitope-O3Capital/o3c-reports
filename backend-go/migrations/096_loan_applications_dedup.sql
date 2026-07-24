-- 096_loan_applications_dedup — M21
-- loan_applications has semantic-duplicate columns added by migration 015:
--   ref_no      ≈ reference        (004's canonical column)
--   cif         ≈ applicant_cif    (004's canonical column)
--   first_name  ]
--   last_name   ] together ≈ applicant_name (004's canonical column)
--
-- Application code (los.go, loans.go, reports.go etc.) uses ONLY the 004 columns.
-- The 015 aliases appear to have been added for a MSSQL import script that was
-- later abandoned. They are not queried by any handler.
--
-- Phase 1 (this migration): backfill aliases from canonical columns so both are
-- consistent, and add comments documenting which is authoritative.
-- Phase 2 (future, after verifying no external consumer reads the alias columns):
-- DROP COLUMN ref_no, cif, first_name, last_name.

-- Backfill alias columns from canonical columns for any rows that have the
-- canonical value but not the alias (handles rows created before 015 was applied).
UPDATE loan_applications
   SET ref_no    = COALESCE(ref_no, reference)
WHERE ref_no IS NULL AND reference IS NOT NULL;

UPDATE loan_applications
   SET cif       = COALESCE(cif, applicant_cif)
WHERE cif IS NULL AND applicant_cif IS NOT NULL;

UPDATE loan_applications
   SET first_name = COALESCE(first_name, split_part(applicant_name, ' ', 1)),
       last_name  = COALESCE(last_name,
           CASE WHEN position(' ' IN applicant_name) > 0
                THEN substring(applicant_name FROM position(' ' IN applicant_name) + 1)
                ELSE ''
           END)
WHERE (first_name IS NULL OR first_name = '') AND applicant_name IS NOT NULL AND applicant_name != '';

-- Document the authoritative columns so future developers know which to use.
COMMENT ON COLUMN loan_applications.reference     IS 'AUTHORITATIVE application reference (e.g. LOS-202607-0001). Prefer over ref_no.';
COMMENT ON COLUMN loan_applications.ref_no        IS 'ALIAS for reference — added by migration 015 for an abandoned MSSQL import. Do not write to; read reference instead.';
COMMENT ON COLUMN loan_applications.applicant_cif IS 'AUTHORITATIVE customer CIF. Prefer over cif.';
COMMENT ON COLUMN loan_applications.cif           IS 'ALIAS for applicant_cif — added by migration 015. Do not write to; read applicant_cif instead.';
COMMENT ON COLUMN loan_applications.applicant_name IS 'AUTHORITATIVE full name. Prefer over first_name + last_name.';
COMMENT ON COLUMN loan_applications.first_name    IS 'ALIAS — split of applicant_name, added by migration 015. Do not write to; read applicant_name instead.';
COMMENT ON COLUMN loan_applications.last_name     IS 'ALIAS — split of applicant_name, added by migration 015. Do not write to; read applicant_name instead.';

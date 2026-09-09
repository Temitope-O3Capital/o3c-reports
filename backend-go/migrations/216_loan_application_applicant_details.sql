-- The origination form has always collected applicant identity and employment
-- detail across its first two steps — BVN, NIN, date of birth, address, job
-- title, employment type, employment start date — and none of it had anywhere
-- to go. losCreate's request struct does not name those fields, so encoding/json
-- discarded them silently: staff filled in two full steps of a form and every
-- value was thrown away on save, with no error to indicate it.
--
-- BVN matters most. It is the identifier a Nigerian credit bureau pull is keyed
-- on (CRC ReportByBVN) and the one Mono's Lookup product resolves an identity
-- with, so a credit application without it cannot be checked against the bureau
-- at all.
--
-- Nullable throughout: existing rows predate collection and there is nothing to
-- backfill them from. bvn and nin are held as text rather than a numeric type —
-- they are identifiers with a fixed 11-digit shape, never arithmetic, and
-- leading zeros are significant.
ALTER TABLE app.loan_applications
  ADD COLUMN IF NOT EXISTS bvn                   text,
  ADD COLUMN IF NOT EXISTS nin                   text,
  ADD COLUMN IF NOT EXISTS date_of_birth         date,
  ADD COLUMN IF NOT EXISTS residential_address   text,
  ADD COLUMN IF NOT EXISTS job_title             text,
  ADD COLUMN IF NOT EXISTS employment_type       text,
  ADD COLUMN IF NOT EXISTS employment_start_date date;

-- Bureau pulls and duplicate-application checks both look an applicant up by
-- BVN. Partial: most historical rows have none, and there is no value in
-- indexing a column that is overwhelmingly NULL.
CREATE INDEX IF NOT EXISTS idx_loan_applications_bvn
  ON app.loan_applications (bvn)
  WHERE bvn IS NOT NULL;

COMMENT ON COLUMN app.loan_applications.bvn IS
  'Bank Verification Number, 11 digits. Collected on the origination form; the key for CRC bureau reports and Mono identity lookup.';
COMMENT ON COLUMN app.loan_applications.residential_address IS
  'Named residential_address, not address: app.loan_applications already joins tables that carry an address column and an unqualified name is ambiguous in those queries.';

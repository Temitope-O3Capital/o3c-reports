DROP INDEX IF EXISTS app.idx_loan_applications_bvn;
ALTER TABLE app.loan_applications
  DROP COLUMN IF EXISTS bvn,
  DROP COLUMN IF EXISTS nin,
  DROP COLUMN IF EXISTS date_of_birth,
  DROP COLUMN IF EXISTS residential_address,
  DROP COLUMN IF EXISTS job_title,
  DROP COLUMN IF EXISTS employment_type,
  DROP COLUMN IF EXISTS employment_start_date;

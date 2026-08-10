-- 133: Extract the rich Udara payload (already in cbs_loans.raw / cbs_fixed_deposits.raw)
-- into typed columns so the workspace can report on sector, branch, loan reference,
-- instalment amount, and approval date without re-parsing jsonb in every query. cbssync
-- populates these on every refresh; the backfill below gives immediate values.

ALTER TABLE cbs_loans
  ADD COLUMN IF NOT EXISTS economic_sector        text,
  ADD COLUMN IF NOT EXISTS branch_name            text,
  ADD COLUMN IF NOT EXISTS reference_number       text,
  ADD COLUMN IF NOT EXISTS installment_amount_kobo bigint,
  ADD COLUMN IF NOT EXISTS approved_date          timestamptz;

ALTER TABLE cbs_fixed_deposits
  ADD COLUMN IF NOT EXISTS reference_number text,
  ADD COLUMN IF NOT EXISTS branch_name      text,
  ADD COLUMN IF NOT EXISTS rollover_count   int;

UPDATE cbs_loans SET
  economic_sector         = NULLIF(raw->>'economicSector',''),
  branch_name             = NULLIF(raw->>'branchName',''),
  reference_number        = NULLIF(raw->>'referenceNumber',''),
  installment_amount_kobo = CASE WHEN (raw->>'installmentAmount') ~ '^[0-9]+(\.[0-9]+)?$'
                                 THEN (raw->>'installmentAmount')::numeric::bigint END,
  approved_date           = CASE WHEN NULLIF(raw->>'approvedDate','') IS NOT NULL
                                 THEN (raw->>'approvedDate')::timestamptz END;

UPDATE cbs_fixed_deposits SET
  reference_number = NULLIF(raw->>'referenceNumber',''),
  branch_name      = NULLIF(raw->>'branchName',''),
  rollover_count   = CASE WHEN (raw->>'rolloverCount') ~ '^[0-9]+$'
                          THEN (raw->>'rolloverCount')::int END;

CREATE INDEX IF NOT EXISTS idx_cbs_loans_sector ON cbs_loans (economic_sector);
CREATE INDEX IF NOT EXISTS idx_cbs_loans_reference ON cbs_loans (reference_number);

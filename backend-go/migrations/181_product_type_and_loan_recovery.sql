-- 181: differentiate card vs loan in the recovery/collections book, and give
-- recovery_cases somewhere to hold manual loan-recovery detail (loans carry no CIF
-- and none of the card fields). Additive + idempotent; backfills existing rows to
-- 'card' since everything there today is the card import + its auto-escalations.

ALTER TABLE app.recovery_cases         ADD COLUMN IF NOT EXISTS product_type     text;
ALTER TABLE app.recovery_cases         ADD COLUMN IF NOT EXISTS customer_name    text;  -- loans have no CIF to join a name from
ALTER TABLE app.recovery_cases         ADD COLUMN IF NOT EXISTS loan_ref         text;
ALTER TABLE app.recovery_cases         ADD COLUMN IF NOT EXISTS officer_name     text;
ALTER TABLE app.recovery_cases         ADD COLUMN IF NOT EXISTS loan_amount_kobo bigint;
ALTER TABLE app.recovery_cases         ADD COLUMN IF NOT EXISTS maturity_date    date;
ALTER TABLE app.collection_assignments ADD COLUMN IF NOT EXISTS product_type     text;

UPDATE app.recovery_cases         SET product_type = 'card' WHERE product_type IS NULL;
UPDATE app.collection_assignments SET product_type = 'card' WHERE product_type IS NULL;

-- New rows (e.g. the nightly recovery-escalation worker) are card unless stated otherwise.
ALTER TABLE app.recovery_cases         ALTER COLUMN product_type SET DEFAULT 'card';
ALTER TABLE app.collection_assignments ALTER COLUMN product_type SET DEFAULT 'card';

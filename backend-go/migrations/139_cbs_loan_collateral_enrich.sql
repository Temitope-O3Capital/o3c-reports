-- 139_cbs_loan_collateral_enrich.sql
-- Promotes high-value loan fields that Udara already returns in the LoanAccount
-- Search payload but which were only living in the raw jsonb blob.
--
-- NOTE on paymentSchedules: the Search endpoint returns it as null for every loan
-- (the amortization schedule is only available from /api/LoanAccount/v1/viewloanschedule),
-- so there is deliberately no schedule column here — promoting it would create an
-- always-empty field. Wire the viewloanschedule endpoint into its own table if
-- per-installment data is needed.

ALTER TABLE cbs_loans ADD COLUMN IF NOT EXISTS collateral_type          text;
ALTER TABLE cbs_loans ADD COLUMN IF NOT EXISTS collateral_description   text;
ALTER TABLE cbs_loans ADD COLUMN IF NOT EXISTS collateral_valuation_kobo bigint;
ALTER TABLE cbs_loans ADD COLUMN IF NOT EXISTS ledger_balance_kobo      bigint;
ALTER TABLE cbs_loans ADD COLUMN IF NOT EXISTS interest_frequency       text;
ALTER TABLE cbs_loans ADD COLUMN IF NOT EXISTS lending_model            text;
ALTER TABLE cbs_loans ADD COLUMN IF NOT EXISTS first_installment_date   timestamptz;

-- Backfill from raw (survives only until the next sync, which sets these directly).
UPDATE cbs_loans SET
    collateral_type           = NULLIF(raw->>'collateralType', ''),
    collateral_description    = NULLIF(raw->>'collateralDescription', ''),
    collateral_valuation_kobo = NULLIF(raw->>'collateralValuation', '')::numeric::bigint,
    ledger_balance_kobo       = NULLIF(raw->>'ledgerBalance', '')::numeric::bigint,
    interest_frequency        = NULLIF(raw->>'interestFrequency', ''),
    lending_model             = NULLIF(raw->>'lendingModel', ''),
    first_installment_date    = NULLIF(raw->>'firstInstallmentDate', '')::timestamptz
WHERE collateral_type IS NULL AND ledger_balance_kobo IS NULL;

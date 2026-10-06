-- 341: a place to RECORD a fee, for the two kinds this product has no reliable feed for.
--
-- Card joining fees: the Udara GL accounts for this (JOINING FEES / JOINING FEES - AMEX
-- CARDS) carry exactly 3 rows ever, all one-off manual corrections typed in by ops
-- ("Joining Fee Refund: GODWIN") -- not a live posting of every card sold. The table built
-- for this (app.fee_income, migration 049) was designed for a transaction-level fee report
-- import that never arrived: 0 rows, confirmed live 2026-10-06.
--
-- Loan fees: there is no "management fee" GL account distinct from "other" -- one generic
-- CONSUMER-only account (40102007), free-text narration is the only hint of intent
-- ("Management Fee on Loan Disbursement: ..." sits beside plain "LOAN FEE HAMMED MUSA" on
-- the same account), and there is no SME-side fee account at all. This is not a gap in
-- what's been synced -- Udara's own product config has applyLoanFees=false on BOTH loan
-- products (401 CONSUMER, 402 SME), confirmed live against /api/Product/v1/SearchProducts.
-- Fees are being journaled by hand, outside the product fee engine entirely.
--
-- Neither of these can be fixed by syncing harder -- there is nothing upstream to sync.
-- The fix is a place for Finance to record what they know, in the same shape this codebase
-- already trusts for a money movement it cannot auto-detect: migration 044's
-- manual_postings (initiated_by/approved_by/status). A pending row is not counted in any
-- report until approved, so a mistaken entry costs nothing until someone signs off on it.

ALTER TABLE fee_income
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'approved'
      CHECK (status IN ('pending','approved','rejected')),
  ADD COLUMN IF NOT EXISTS initiated_by BIGINT REFERENCES o3c_users(id),
  ADD COLUMN IF NOT EXISTS approved_by  BIGINT REFERENCES o3c_users(id),
  ADD COLUMN IF NOT EXISTS approved_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejected_by  BIGINT REFERENCES o3c_users(id),
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
  ADD COLUMN IF NOT EXISTS branch_name  TEXT;

-- Existing rows (there are none today, but this is the honest default for any future real
-- import path, the table's ORIGINAL intent) are pre-approved: a bulk file import is not the
-- same risk as one person typing a number into a form, and should not sit in a review queue.
COMMENT ON COLUMN fee_income.status IS
    'Defaults to approved so a future transaction-level file import (the table''s original '
    'purpose) is unaffected. Only the manual-entry path (fee_income_ops.go) writes a '
    'pending row, which a report must exclude until someone approves it.';

CREATE INDEX IF NOT EXISTS idx_fee_income_status ON fee_income(status);

CREATE TABLE IF NOT EXISTS loan_fee_income (
    id             BIGSERIAL PRIMARY KEY,
    fee_date       DATE NOT NULL,
    fee_type       TEXT NOT NULL CHECK (fee_type IN ('management','other')),
    loan_account   TEXT NOT NULL,
    amount_kobo    BIGINT NOT NULL CHECK (amount_kobo > 0),
    currency       TEXT NOT NULL DEFAULT 'NGN',
    ref            TEXT,
    status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
    initiated_by   BIGINT REFERENCES o3c_users(id),
    initiated_by_name TEXT,
    approved_by    BIGINT REFERENCES o3c_users(id),
    approved_by_name  TEXT,
    approved_at    TIMESTAMPTZ,
    rejected_by    BIGINT REFERENCES o3c_users(id),
    rejection_reason TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loan_fee_income_date    ON loan_fee_income(fee_date);
CREATE INDEX IF NOT EXISTS idx_loan_fee_income_status  ON loan_fee_income(status);
CREATE INDEX IF NOT EXISTS idx_loan_fee_income_account ON loan_fee_income(loan_account);

COMMENT ON TABLE loan_fee_income IS
    'Manually recorded loan fees (management vs other), maker-checker, status defaults to '
    '''pending'' unlike fee_income -- there is no bulk-import path here to pre-approve, every '
    'row starts as one person''s entry. SME vs Individual is NOT stored here: resolve it by '
    'joining loan_account to app.cbs_loans.product_code (''401''=Consumer/Individual, '
    '''402''=SME) at query time, so the split can never drift from the loan book itself.';

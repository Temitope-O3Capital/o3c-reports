-- 337: a branch-tagged home for the WHOLE Udara call-over ledger, not just the
-- repayment legs app.loan_repayments already captures.
--
-- app.loan_repayments (migration 272) deliberately keeps only the customer-debit leg of
-- a loan repayment -- the right scope for "what did a customer pay", the wrong scope for
-- a finance model. Every row on the real ledger (/api/Report/v1/GetTransactionCallOverReport)
-- carries a `branch` field O3 has never captured anywhere: not loan disbursements, not FD
-- placements/interest/liquidation, not fees, not the GL-to-GL journals. A branch-split
-- Balance Sheet/P&L needs all of it, both legs of every entry, because a receivable total
-- by branch has to agree with the liability/income side that produced it.
--
-- Live-verified 2026-10-06 against the API directly (not our DB mirror): 6,745 raw rows,
-- 6,643 after removing exact posting duplicates, 2026-07-01..2026-10-02 -- that date floor
-- is Udara's own ceiling (confirmed by a full per-account backfill sweep in migration 272's
-- era), not a filter we impose. Branch split on that full ledger: 6,158 Head Office Branch
-- (92.7%) / 485 Abuja Branch (7.3%) -- in line with the loan/FD book's own ~92/8 split.
-- 49 distinct entry codes appear; loan principal/interest, FD placement/interest/
-- liquidation, withholding tax, inter-branch and plain journals are all present, which is
-- exactly the generality app.loan_repayments' narrower channel column has no room for.
--
-- branch_name is stored EXACTLY as Udara returns it ('Head Office Branch' / 'Abuja Branch')
-- -- never translated to "Lagos"/"Abuja" here. That translation is a display concern for
-- the views/handlers built on top, not a fact to bake into a capture table.
--
-- Also: branchCode ("101"/"102") is present on every live FixedDepositAccount record and
-- has been silently dropped since migration 133 added branch_name without it. It costs
-- nothing to carry forward as a second, stable join key now that this work is touching the
-- same code path; loans carry branchName only, so their branch_code stays NULL by design,
-- not by omission -- the branch NAME is unambiguous on its own for loans/FDs alike (exactly
-- two values company-wide, confirmed live).

ALTER TABLE cbs_loans          ADD COLUMN IF NOT EXISTS branch_code TEXT;
ALTER TABLE cbs_fixed_deposits ADD COLUMN IF NOT EXISTS branch_code TEXT;

CREATE TABLE IF NOT EXISTS cbs_gl_postings (
    id                  BIGSERIAL PRIMARY KEY,
    financial_date      DATE        NOT NULL,
    posted_at           TIMESTAMPTZ,
    account_number      TEXT        NOT NULL,
    account_name        TEXT,
    branch_name         TEXT        NOT NULL,   -- Udara's raw value, never translated here
    entry_code          TEXT        NOT NULL,
    side                TEXT        NOT NULL CHECK (side IN ('debit','credit')),
    amount_kobo         BIGINT      NOT NULL CHECK (amount_kobo >= 0),
    posting_reference   TEXT,
    instrument_number   TEXT,
    narration           TEXT,
    initiated_by        TEXT,
    approved_by         TEXT,
    product_category    TEXT        NOT NULL,   -- 'loan' | 'fixed_deposit' | 'withholding_tax'
                                                  -- | 'journal' | 'interbank' | 'cash' | 'other'
    cbs_loan_account     TEXT,       -- resolved from narration tail where entry is loan-shaped;
                                      -- same technique as app.loan_repayments (migration 272),
                                      -- nullable because most rows here are not loan legs at all
    ledger_key           TEXT NOT NULL,
    raw                  JSONB       NOT NULL,
    captured_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_cbs_gl_postings_ledger_key ON cbs_gl_postings (ledger_key);
CREATE INDEX IF NOT EXISTS idx_cbs_gl_postings_branch_date ON cbs_gl_postings (branch_name, financial_date);
CREATE INDEX IF NOT EXISTS idx_cbs_gl_postings_entry_code  ON cbs_gl_postings (entry_code);
CREATE INDEX IF NOT EXISTS idx_cbs_gl_postings_category    ON cbs_gl_postings (product_category);
CREATE INDEX IF NOT EXISTS idx_cbs_gl_postings_loan        ON cbs_gl_postings (cbs_loan_account)
    WHERE cbs_loan_account IS NOT NULL;

COMMENT ON TABLE cbs_gl_postings IS
    'Full Udara call-over ledger (GetTransactionCallOverReport), both legs of every entry, '
    'branch-tagged. Insert-only, fed by cbssync.StartGLPostingsWorker (gl_postings.go). '
    'Covers 2026-07-01 forward only -- that is Udara''s own history ceiling, not a filter '
    'this job applies. Not a replacement for app.loan_repayments, which stays the narrower, '
    'already-tested source for "what did a customer pay"; this table is the branch-split '
    'source for Balance Sheet / Income Statement / Cash Flow.';

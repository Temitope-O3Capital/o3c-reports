-- 272 — Let app.loan_repayments hold OBSERVED repayments from the Udara360 GL.
--
-- Until now arrears across this product have been model output. app.loan_repayments has
-- held 0 rows since it was created, so every "paid" and "arrears" figure was derived from
-- balances rather than from postings. This migration is what lets the hourly capture in
-- cbssync/repayments.go write what the core banking ledger actually says.
--
-- ── THE BLOCKER ──────────────────────────────────────────────────────────────
-- application_id is NOT NULL REFERENCES loan_applications(id). app.loan_applications
-- holds 8 rows, all 'submitted'/'risk_review', none disbursed, and 0 of them reconcile to
-- any CBS loan account. The CBS book is a separate population — 52 loan accounts over 44
-- distinct linked CASA accounts. There is therefore no legal application_id for a CBS
-- ledger repayment, and the NOT NULL made capture impossible.
--
-- Dropping the NOT NULL is the smallest change that unblocks this. The FOREIGN KEY STAYS
-- and NULL satisfies it, so a non-NULL application_id is still forced to be a real
-- application. The alternative — minting fake loan_applications rows to satisfy the
-- constraint — would corrupt the origination book to satisfy a bookkeeping detail.
--
-- ── WHAT THE LEDGER ACTUALLY LOOKS LIKE ──────────────────────────────────────
-- Measured live on 2026-09-22 against GET /api/Report/v1/GetTransactionCallOverReport:
--
--   * A repayment is NOT posted against the loan account. The debit lands on the
--     customer's CASA account; the loan account appears only as the trailing segment of
--     `narration`. Querying the loan account returns the disbursement and nothing else.
--   * One repayment is 2 or 4 ledger legs (customer side + GL side, and interest splits
--     again). Summing by entry code naively double- and quadruple-counts. Only the
--     customer-side DEBIT leg is captured: D-LPOP / D-LPRP -> principal,
--     D-LIOP1A / D-LIRP1 -> interest.
--   * One CASA can serve two loans (1000005509 backs both …5530 and …5531), so the CASA
--     is NOT a safe attribution key. The narration tail is; that is what lands in
--     cbs_loan_account.
--   * The endpoint has NO server-side date filter. Every date parameter tried
--     (StartDate/EndDate, FromDate/ToDate, Date, FinancialDate, TransactionDate) returned
--     a byte-identical unfiltered page. Windowing is done client-side, and `recordCount`
--     is always 0 on this endpoint so a page count cannot be derived from it.
--   * Amounts are KOBO. All 5,682 ledger amounts match ^\d+\.00$ — the decimals are
--     always zero padding. Loan 1200045402000005971 carries loan_amount_kobo
--     13,333,333,333 and its C-LPDP disbursement reads "13333333333.00".
--
-- The whole ledger is 5,682 rows spanning financialDate 2026-07-01..2026-09-16 — it does
-- not reach back further, so the capture can never reconstruct a full history. Within it
-- there are 39 capturable repayment legs across 17 loans: principal 56,311,755,432 kobo
-- (N563,117,554.32) and interest 8,109,000,000 kobo (N81,090,000). Cross-checked two
-- independent ways (walking the global feed, and sweeping all 44 CASA accounts): both give
-- exactly 39 legs and identical totals, and no leg falls outside the 44 linked accounts.
-- For 9 of the 17 loans the observed principal matches loan_amount - outstanding_principal
-- to the kobo; the other 8 undershoot because their earlier repayments pre-date the
-- report's 2026-07-01 floor.
--
-- ── IDEMPOTENCY ──────────────────────────────────────────────────────────────
-- ledger_key is a sha256 over postingReferenceNumber | entryCode | accountNumber |
-- financialDate | amount | instrumentNumber. Across the entire ledger: 39 legs, 39
-- distinct keys, 0 collisions (still 0 with instrumentNumber removed, so there is
-- headroom). The unique index is PARTIAL — workspace and manual repayments carry
-- ledger_key IS NULL and are untouched by it. Capture is insert-only: no DELETE, no
-- UPDATE, so unlike the snapshot refreshes a bad API response cannot empty or gut this
-- table.
--
-- ── TRIGGERS: BOTH VERIFIED, NEITHER CHANGED ─────────────────────────────────
-- trg_loan_repayments_sync mirrors loan_id <-> application_id and is a no-op when both
-- are NULL (read the function body: two IF NULL assignments, then RETURN NEW).
-- trg_gl_check_loan_repayments only RAISEs WARNING, never EXCEPTION, and returns early
-- when app.skip_gl_check = 'true' — which the capture sets inside its transaction. The
-- warning would be wrong for this path anyway: these rows ARE the general ledger, mirrored
-- from core banking, not a workspace posting needing its own journal entry.
--
-- ── ONE BEHAVIOUR CHANGE, ACCEPTED DELIBERATELY ──────────────────────────────
-- handlers/batch.go computes the nightly repayments_count / repayments_kobo as
-- COUNT(*) / SUM(amount_kobo) FROM loan_repayments WHERE payment_date::date = $1, with no
-- application filter, so CBS ledger rows will now be included. That is left alone ON
-- PURPOSE: the table has held 0 rows for its whole life, so that figure has always
-- reported zero. Including observed repayments does not create a discontinuity in a
-- previously meaningful number — it makes the number mean something for the first time.
--
-- The capture code refuses to run and logs at Error until every column below exists, so
-- deploying the code ahead of this migration writes nothing.

BEGIN;

-- 1. A repayment may exist without a workspace loan application. The FK stays.
ALTER TABLE app.loan_repayments
    ALTER COLUMN application_id DROP NOT NULL;

-- 2. Ledger provenance and the principal/interest split. Kobo throughout. One row is one
--    GL leg, so exactly one of principal_kobo / interest_kobo is non-zero and
--    amount_kobo = principal_kobo + interest_kobo.
ALTER TABLE app.loan_repayments
    ADD COLUMN IF NOT EXISTS cbs_loan_account  text,
    ADD COLUMN IF NOT EXISTS cbs_casa_account  text,
    ADD COLUMN IF NOT EXISTS entry_code        text,
    ADD COLUMN IF NOT EXISTS component         text,
    ADD COLUMN IF NOT EXISTS principal_kobo    bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS interest_kobo     bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS posting_reference text,
    ADD COLUMN IF NOT EXISTS instrument_number text,
    ADD COLUMN IF NOT EXISTS financial_date    date,
    ADD COLUMN IF NOT EXISTS posted_at         timestamptz,
    ADD COLUMN IF NOT EXISTS ledger_key        text,
    ADD COLUMN IF NOT EXISTS raw               jsonb;

COMMENT ON COLUMN app.loan_repayments.cbs_loan_account IS
    'Udara loan account this leg repaid, taken from the NARRATION TAIL — not from the '
    'posting account, which is the customer''s CASA. One CASA can serve two loans, so the '
    'CASA is not a safe attribution key.';
COMMENT ON COLUMN app.loan_repayments.entry_code IS
    'Raw Udara GL entry code, stored so the principal/interest classification in '
    '`component` can be audited rather than trusted.';
COMMENT ON COLUMN app.loan_repayments.ledger_key IS
    'sha256 idempotency key over the stable fields of a call-over entry. NULL on '
    'workspace/manual repayments, which the partial unique index therefore ignores.';

-- 3. Idempotency, scoped to ledger rows only.
CREATE UNIQUE INDEX IF NOT EXISTS ux_loan_repayments_ledger_key
    ON app.loan_repayments (ledger_key)
    WHERE ledger_key IS NOT NULL;

-- 4. "What did this CBS loan actually repay, and when."
CREATE INDEX IF NOT EXISTS idx_loan_repayments_cbs_loan
    ON app.loan_repayments (cbs_loan_account, financial_date)
    WHERE cbs_loan_account IS NOT NULL;

-- 5. No new `source` column: `channel` already exists and carries this.
COMMENT ON COLUMN app.loan_repayments.channel IS
    'manual | collections | card | cbs_gl. cbs_gl rows are OBSERVED Udara360 GL call-over '
    'postings captured hourly by cbssync.SyncRepayments; they carry ledger_key, '
    'entry_code and cbs_loan_account, and a NULL application_id.';

DO $$
DECLARE nullable text; cols int;
BEGIN
    SELECT is_nullable INTO nullable FROM information_schema.columns
     WHERE table_schema='app' AND table_name='loan_repayments' AND column_name='application_id';
    SELECT count(*) INTO cols FROM information_schema.columns
     WHERE table_schema='app' AND table_name='loan_repayments'
       AND column_name IN ('cbs_loan_account','cbs_casa_account','entry_code','component',
                           'principal_kobo','interest_kobo','posting_reference',
                           'instrument_number','financial_date','posted_at','ledger_key','raw');
    IF nullable <> 'YES' OR cols <> 12 THEN
        RAISE EXCEPTION '272: schema not in the expected state (application_id nullable=%, new cols=%/12)', nullable, cols;
    END IF;
    RAISE NOTICE '272: loan_repayments ready for GL capture — application_id nullable, all 12 ledger columns present';
END $$;

COMMIT;

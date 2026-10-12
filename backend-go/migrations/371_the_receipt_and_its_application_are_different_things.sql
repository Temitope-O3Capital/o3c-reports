-- A repayment RECEIPT and its APPLICATION to a loan are two different events.
--
-- app.loan_repayments holds the application side: the loan-account legs that reduce a
-- facility. It is the right source for "how much has this loan been repaid" and the
-- portfolio uses it correctly. It is the WRONG source for "how much did we collect",
-- and that is what this migration separates.
--
-- Measured on the live ledger 2026-10-12:
--
--   79 of the 88 captured legs (752,969,821.33) are an APPLICATION of a receipt whose
--      narration they cite: "Loan Principal Repayment Recovered - BA2610060001 - ..."
--    9 of the 88 (148,336,666.65) are direct, citing nothing.
--   91 journal-credit legs (1,029,965,072.55) are the RECEIPTS those applications came
--      from, and nothing captured them at all.
--
-- So a billion naira of money-in was invisible, and the one figure built on
-- loan_repayments as if it were money-in was mixing two bases.
--
-- ATTRIBUTION IS UDARA'S OWN, NOT A NAME MATCH. The decision taken was to never guess
-- which loan a receipt belongs to. It does not have to be guessed: Udara cross-references
-- them itself. The journal credit carries a posting reference, and the loan leg that
-- applies it cites that reference in its narration:
--
--   C-JRNL  ref 2609120001  "Loan Repayment: NASS Society"                     26,888,888.89
--   D-LPOP  ref 2609120002  "...Recovered - 2609120001 - NASSCOOP ... -5971"            888.00
--
-- That is the whole linkage: deterministic, from the book of record, with no fuzzy
-- matching on a free-text borrower name. It also shows the thing a name match would have
-- hidden — Udara credited the cooperative's current account and applied only 888.00 of
-- the receipt to the loan, leaving 26,888,000.89 sitting in the CASA account.

/* ── The receipts ───────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS app.cbs_journal_receipts (
  id                bigserial PRIMARY KEY,
  -- Same idempotency shape as app.loan_repayments: the capture re-walks an overlapping
  -- window every hour and must never insert a leg twice.
  ledger_key        text        NOT NULL UNIQUE,
  posting_reference text        NOT NULL,
  casa_account      text        NOT NULL,
  account_name      text,
  entry_code        text        NOT NULL,
  amount_kobo       bigint      NOT NULL,
  financial_date    date        NOT NULL,
  posted_at         timestamptz,
  instrument_number text,
  narration         text,
  initiated_by      text,
  approved_by       text,
  raw               jsonb,
  synced_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_journal_receipts_ref  ON app.cbs_journal_receipts (posting_reference);
CREATE INDEX IF NOT EXISTS idx_journal_receipts_date ON app.cbs_journal_receipts (financial_date DESC);
CREATE INDEX IF NOT EXISTS idx_journal_receipts_acct ON app.cbs_journal_receipts (casa_account);

COMMENT ON TABLE app.cbs_journal_receipts IS
  'Repayment money arriving as a journal credit to a borrower''s account. This is the RECEIPT; app.loan_repayments is the application of it to a facility. Never sum the two as collections — see app.v_loan_receipts.';

/* ── The link from an application back to its receipt ───────────────────────── */

ALTER TABLE app.loan_repayments
  ADD COLUMN IF NOT EXISTS source_posting_reference text;

COMMENT ON COLUMN app.loan_repayments.source_posting_reference IS
  'The posting reference of the receipt this leg applied, parsed from the narration ("Recovered - <ref> -"). NULL means the leg is itself the receipt (a direct repayment), which is how collections avoids counting the same money twice.';

-- Backfill from the narration Udara already wrote.
UPDATE app.loan_repayments
   SET source_posting_reference =
         (regexp_match(COALESCE(raw->>'narration',''), 'Recovered - ([A-Za-z0-9]+) -'))[1]
 WHERE source_posting_reference IS NULL
   AND COALESCE(raw->>'narration','') ~ 'Recovered - [A-Za-z0-9]+ -';

CREATE INDEX IF NOT EXISTS idx_loan_repayments_source_ref
  ON app.loan_repayments (source_posting_reference)
  WHERE source_posting_reference IS NOT NULL;

/* ── Receipt against application ────────────────────────────────────────────── */

-- What came in, what Udara applied to a facility, and what is still sitting in the
-- borrower's account. The retained figure is the one nothing could show before.
CREATE OR REPLACE VIEW app.v_loan_receipts AS
SELECT r.id,
       r.posting_reference,
       r.financial_date,
       r.casa_account,
       r.account_name,
       r.narration,
       r.amount_kobo                                   AS received_kobo,
       COALESCE(a.applied_kobo, 0)                     AS applied_kobo,
       r.amount_kobo - COALESCE(a.applied_kobo, 0)     AS retained_kobo,
       a.loan_accounts,
       (a.applied_kobo IS NOT NULL)                    AS linked_to_a_loan
  FROM app.cbs_journal_receipts r
  LEFT JOIN LATERAL (
       SELECT SUM(lr.amount_kobo)                              AS applied_kobo,
              string_agg(DISTINCT lr.cbs_loan_account, ', ')   AS loan_accounts
         FROM app.loan_repayments lr
        WHERE lr.source_posting_reference = r.posting_reference
  ) a ON true;

COMMENT ON VIEW app.v_loan_receipts IS
  'Per receipt: what arrived, what Udara applied to a facility, and what stayed in the borrower''s account. linked_to_a_loan false means no loan leg cites this receipt — money received that Udara has not applied, which is a fact to report rather than a loan to guess at.';

DO $$
DECLARE
  linked bigint;
  direct bigint;
BEGIN
  SELECT COUNT(*) INTO linked FROM app.loan_repayments WHERE source_posting_reference IS NOT NULL;
  SELECT COUNT(*) INTO direct FROM app.loan_repayments WHERE source_posting_reference IS NULL;
  RAISE NOTICE 'loan legs: % are an application of a cited receipt, % are direct receipts in their own right', linked, direct;
END $$;

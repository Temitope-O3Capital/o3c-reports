-- NASSCOOP's pending receipt IS in Udara — as a journal credit, not a loan-account leg.
--
-- Migration 368 left two of the eleven pending receipts alone because Udara appeared to
-- have nothing matching them. For NASSCOOP that was wrong, and the reason matters more
-- than the row.
--
-- WHY IT LOOKED MISSING. app.loan_repayments only carries postings whose entry code is
-- one of the four loan-account codes (D-LPOP, D-LIOP1A, D-LPRP, D-LIRP1). Checked
-- against that, NASSCOOP's live facility 1200045402000005971 shows a single posting of
-- 888.00 naira and nothing else, so a 26,888,888.89 receipt looked unsupported.
--
-- WHAT THE LEDGER ACTUALLY HAS. Read directly from
-- /api/Report/v1/GetTransactionCallOverReport on 2026-10-12:
--
--   2026-09-12  acct 1000005918  C-JRNL  credit 2688888889 kobo  ref 2609120001
--               "Loan Repayment: NASS Society"
--
-- 2,688,888,889 kobo is 26,888,888.89 naira, which is EXACTLY the pending receipt's
-- amount_kobo, three days after it was logged on 2026-09-09 and well inside the
-- publication lag. The money arrived; Udara credited it to the cooperative's current
-- account and applied only 888.00 of it to the loan on the same day
-- (ref 2609120002), which is why the loan-account view of it is almost empty.
--
-- So the receipt is a duplicate of money already in the book of record, and it is
-- superseded on the same basis as the nine cleared by migration 368. It is NOT
-- approved: no sign-off was given and the money needs no second posting.
--
-- FREDSONS (id 3518) STAYS PENDING, re-checked the same way. Its journal credit is
-- 153,333,333 kobo = 1,533,333.33 naira on 2026-09-28 (ref BA2610020020), applied to
-- the loan on 2026-10-02 as 1,133,333.33 principal + 400,000.00 interest. The pending
-- receipt is 1,788,000.00. Different amount, so it is not that payment and still needs
-- a human decision.
--
-- THE GENERAL PROBLEM IS NOT FIXED HERE, deliberately. Loan repayments reach Udara as
-- journal credits carrying the borrower's name in free text ("Loan Repayment: Odometa",
-- "Loan Repayment: GOKE DOUBLE AUTOS", "Wabibat loan repayment", "Repayment From
-- Edgewood College", "Staff Loan repayment September 2026"), and app.loan_repayments
-- captures none of them. Ingesting them means attributing a free-text name to a loan
-- account, which is a matching decision with real money behind it and should not be
-- guessed inside a migration. This row is reconciled on named, cited evidence; the
-- feed gap is reported separately.

DO $$
DECLARE
  amt bigint;
  st  text;
  sup boolean;
BEGIN
  SELECT amount_kobo, status, superseded_by_udara INTO amt, st, sup
    FROM app.collection_payments WHERE id = 3522;

  IF amt IS NULL THEN
    RAISE EXCEPTION 'collection_payments id 3522 no longer exists — re-run the reconciliation before clearing anything';
  END IF;

  -- The whole case rests on this amount equalling the ledger's journal credit. If the
  -- row has changed, stop rather than clear something that was never reviewed.
  IF amt <> 2688888889 THEN
    RAISE EXCEPTION
      'id 3522 is now % kobo, not the 2688888889 that matches Udara journal ref 2609120001 — refusing to clear it',
      amt;
  END IF;

  IF sup THEN
    RAISE NOTICE 'id 3522 was already superseded; nothing to do';
    RETURN;
  END IF;

  IF st <> 'pending_hop' THEN
    RAISE EXCEPTION 'id 3522 is now %, not pending_hop — somebody has acted on it, so leave it alone', st;
  END IF;

  UPDATE app.collection_payments
     SET superseded_by_udara = true
   WHERE id = 3522;

  RAISE NOTICE 'id 3522 (NASSCOOP, 26,888,888.89) superseded: Udara journal ref 2609120001 on 2026-09-12 carries the same amount to the kobo';
END $$;

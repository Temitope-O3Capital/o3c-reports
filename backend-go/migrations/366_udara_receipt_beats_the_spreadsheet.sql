-- Where Udara has the repayment, Udara's figure is the one that counts.
--
-- Udara is the book of record for a facility it holds (migration 268), and migration
-- 363 applied that to the LOANS. The RECEIPTS were still counted from both books: the
-- same money reached app.loan_repayments from the Udara call-over ledger and
-- app.collection_payments from the uploaded spreadsheet, and the spreadsheet figure is
-- the hand-entered one.
--
-- They cannot be matched receipt to receipt, and pretending otherwise would be
-- guessing. The repayments are equal recurring instalments -- FINTRAK pays 5,600,000
-- every month, so four Udara receipts and five entered receipts all carry the identical
-- amount and only two of the twenty-one amount-matches share a date. An exact amount is
-- the monthly figure, not a fingerprint.
--
-- So precedence is applied at the FACILITY, exactly as it is for the loans themselves:
-- if Udara holds the facility, Udara's receipts are the record and the entered ones for
-- that facility are suppressed.
--
-- BOUNDED BY WHAT UDARA ACTUALLY HAS, which is the part that stops this destroying
-- money. The call-over report does not reach back past 2026-07-01 -- confirmed live
-- 2026-10-12: /api/LoanRepayment/v1/Search, /api/RepaymentSchedule/v1/Search,
-- /api/Transaction/v1/Search, /api/AccountTransaction/v1/Search and
-- /api/GeneralLedger/v1/Search all return 404 on this instance, while
-- /api/LoanAccount/v1/Search and the call-over report return 200 with data, so the
-- client authenticates and those endpoints genuinely do not exist. The call-over
-- ledger is the only repayment source Udara exposes and its floor is Udara's limit,
-- not ours.
--
-- Of the 35 entered receipts on Udara-owned facilities, 13 (75,530,477.78 naira, dated
-- 2026-05-08 to 2026-06-30) fall BEFORE that floor. Udara has no record of them, so the
-- spreadsheet is the only record and they are KEPT. Suppressing them would delete the
-- only evidence of real money. Only receipts inside Udara's coverage are superseded.
--
-- Nothing is deleted either way: the rows stay, flagged, so the decision is auditable
-- and reversible with one UPDATE.

ALTER TABLE app.collection_payments
  ADD COLUMN IF NOT EXISTS superseded_by_udara boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN app.collection_payments.superseded_by_udara IS
  'True when this hand-entered receipt is on a facility Udara holds AND falls inside Udara''s repayment coverage, so app.loan_repayments carries the authoritative version. Excluded from every paid and collected figure. Receipts before Udara''s ledger floor are NOT flagged: Udara has no record of them and this is the only one.';

DO $$
DECLARE
  udara_floor date;
  flagged     bigint;
  kept_early  bigint;
  kept_kobo   bigint;
  flag_kobo   bigint;
BEGIN
  SELECT MIN(payment_date) INTO udara_floor FROM app.loan_repayments;
  IF udara_floor IS NULL THEN
    RAISE EXCEPTION 'app.loan_repayments is empty — refusing to supersede anything against a book that has no receipts';
  END IF;

  UPDATE app.collection_payments cp
     SET superseded_by_udara = true
   WHERE cp.status = 'approved'
     AND cp.superseded_by_udara = false
     AND cp.payment_date >= udara_floor
     AND (
       -- The receipt names a facility, and that facility is a Udara mirror.
       EXISTS (SELECT 1 FROM app.collection_assignments ca
                WHERE ca.id = cp.assignment_id
                  AND ca.product_type = 'loan'
                  AND ca.duplicate_of_cbs_id IS NOT NULL)
       -- Or it names none, and EVERY loan facility on its CIF is a Udara mirror, so
       -- there is no other facility the money could belong to. A CIF that also holds a
       -- genuine uploaded loan is deliberately left alone: the receipt could be for
       -- that loan and nothing in the row says which.
       OR (cp.assignment_id IS NULL
           AND EXISTS (SELECT 1 FROM app.collection_assignments ca
                        WHERE ca.account_cif = cp.account_cif AND ca.product_type = 'loan')
           AND NOT EXISTS (SELECT 1 FROM app.collection_assignments ca
                            WHERE ca.account_cif = cp.account_cif
                              AND ca.product_type = 'loan'
                              AND ca.duplicate_of_cbs_id IS NULL))
     );

  GET DIAGNOSTICS flagged = ROW_COUNT;

  SELECT COUNT(*), COALESCE(SUM(amount_kobo),0) INTO kept_early, kept_kobo
    FROM app.collection_payments cp
   WHERE cp.status='approved' AND cp.superseded_by_udara = false
     AND cp.payment_date < udara_floor
     AND EXISTS (SELECT 1 FROM app.collection_assignments ca
                  WHERE ca.id = cp.assignment_id AND ca.product_type='loan'
                    AND ca.duplicate_of_cbs_id IS NOT NULL);

  SELECT COALESCE(SUM(amount_kobo),0) INTO flag_kobo
    FROM app.collection_payments WHERE superseded_by_udara;

  RAISE NOTICE 'Udara ledger floor %: superseded % entered receipt(s) worth % kobo; kept % earlier receipt(s) worth % kobo that Udara has no record of',
    udara_floor, flagged, flag_kobo, kept_early, kept_kobo;
END $$;

-- Every paid/collected figure filters on this, so index it with the status it pairs with.
CREATE INDEX IF NOT EXISTS idx_collection_payments_live_receipts
  ON app.collection_payments (account_cif, payment_date)
  WHERE status = 'approved' AND superseded_by_udara = false;

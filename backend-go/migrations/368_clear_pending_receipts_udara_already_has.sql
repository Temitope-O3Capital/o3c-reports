-- Clear the pending receipts Udara has already posted.
--
-- Eleven staff-logged payments had sat at 'pending_hop' since 2026-09-09, 106,393,555.56
-- naira awaiting Head of Operations sign-off. Every one is on a facility Udara holds, so
-- the question was whether Udara had already posted the same money.
--
-- NINE OF THE ELEVEN HAD. They are not approved here -- approving would record a
-- sign-off nobody gave and post the receipt a second time. They are marked superseded,
-- which is what they are: the money is in the book of record already.
--
-- THE MATCH IS THE DAY'S LEG SUM, NOT A SINGLE LEG. Udara posts one repayment as
-- separate principal and interest legs on the same date, so a single logged payment
-- equals the SUM of that date's legs on that loan, never an individual leg. Matching leg
-- by leg found almost nothing and would have left real duplicates in the queue:
--
--   3525 FINTRAK            40,000,000  <- 2026-09-11  34,400,000 + 5,600,000   (2 legs)
--   3527 SHERATON            23,000,000  <- 2026-09-04  20,600,000 + 2,400,000   (2 legs)
--   3526 FINTRAK              5,600,000  <- 2026-09-12   5,600,000               (1 leg)
--   3519 AMBIENCE PLUS BEST   4,000,000  <- 2026-09-07   4,000,000               (1 leg)
--   3524 INTERIOR BAZAR       1,500,000  <- 2026-09-11     900,000 +   600,000   (2 legs)
--   3521 AB INITIO            1,250,000  <- 2026-09-08   1,250,000               (1 leg)
--   3517 KASARACHI            1,000,000  <- 2026-09-28     600,000 +   400,000   (2 legs)
--   3520 ANTHONY OMERA          866,666.67 <- 2026-09-23   266,666.67 + 600,000  (2 legs)
--   3523 JUSTICE SUCCESS         500,000  <- 2026-09-28     500,000               (1 leg)
--
-- The date window is -7/+40 days around the logged date because publication lags the
-- value date: measured across the ledger the gap averages 12 days and the worst is 38
-- (see cbssync/repayments.go). Three of the nine landed 15 to 23 days later, which is
-- why a tight window would have missed them.
--
-- TWO ARE DELIBERATELY LEFT PENDING. Udara has nothing matching them, so they are not
-- duplicates and somebody still has to decide:
--
--   3522 NASSCOOP SOCIETY LTD  26,888,888.00  Udara has posted 888.00 on that loan, and
--                                             nothing else. This is the facility
--                                             ...5971 that reads 44m "paid" from the
--                                             balance against 888 actually posted.
--   3518 FREDSONS INTEGRATED    1,788,000.00  Udara's only posting on that loan is
--                                             1,533,333.33 on 2026-10-02 -- a different
--                                             amount, not this payment.
--
-- Nothing is deleted and no approval is recorded. One UPDATE reverses it.

DO $$
DECLARE
  cleared bigint;
  left_pending bigint;
BEGIN
  WITH pend AS (
    SELECT cp.id, cp.amount_kobo, cp.payment_date, cl.cbs_account_number AS acct
      FROM app.collection_payments cp
      JOIN app.collection_assignments ca ON ca.id = cp.assignment_id
      JOIN app.cbs_loans cl ON cl.cbs_id::text = ca.duplicate_of_cbs_id
     WHERE cp.status = 'pending_hop'
       AND cp.superseded_by_udara = false
  ), udara_day AS (
    -- One repayment per (loan, value date): the legs summed.
    SELECT cbs_loan_account AS acct, payment_date, SUM(amount_kobo) AS day_kobo
      FROM app.loan_repayments
     GROUP BY 1, 2
  ), matched AS (
    SELECT DISTINCT p.id
      FROM pend p
      JOIN udara_day u
        ON u.acct = p.acct
       AND u.day_kobo = p.amount_kobo
       AND u.payment_date BETWEEN p.payment_date - 7 AND p.payment_date + 40
  )
  UPDATE app.collection_payments cp
     SET superseded_by_udara = true
   WHERE cp.id IN (SELECT id FROM matched);

  GET DIAGNOSTICS cleared = ROW_COUNT;

  SELECT COUNT(*) INTO left_pending
    FROM app.collection_payments
   WHERE status = 'pending_hop' AND superseded_by_udara = false;

  -- The analysis found exactly nine. If the data has moved under this migration,
  -- fail rather than clear a different set than the one reviewed above.
  IF cleared <> 9 THEN
    RAISE EXCEPTION
      'expected to clear 9 pending receipts Udara already holds, matched % — the ledger or the queue has changed since this was reviewed, so re-run the analysis before clearing anything',
      cleared;
  END IF;

  RAISE NOTICE 'cleared % pending receipt(s) Udara already posted; % still pending a human decision', cleared, left_pending;
END $$;

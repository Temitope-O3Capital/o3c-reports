-- Uploaded loans: reduce outstanding by what has actually been received, and close
-- the ones that are fully repaid.
--
-- THE BUG: the Loan Repayment CRM import wrote the sheet's APPROVED AMOUNT into both
-- target_amount_kobo AND outstanding_kobo, and nothing ever reduced it. When the
-- repayments were imported afterwards (migration 212, ₦814,718,199.00) they were
-- recorded as receipts but never netted off. So a borrower who had repaid in full still
-- showed their whole loan outstanding — MON DIEU MONTESSORI reads ₦1,000,000.00
-- outstanding against ₦1,149,999.99 received.
--
-- Across the uploaded book that overstates exposure by ₦759,733,031.00:
--   stated outstanding  ₦1,367,833,333.33
--   receipts allocated    ₦759,733,031.00
--   true outstanding      ₦608,100,302.33
--
-- ALLOCATION. collection_payments records the CUSTOMER, not which of their loans a
-- payment settled, so a CIF's receipts are run down its loans oldest-disbursement-first
-- — the same waterfall the Credit Portfolio, Payment Tiers and the Credit File use, so
-- every page reports the same figure. Superseded (pre-restructure) rows take part in
-- the allocation so they keep their own receipts instead of handing them to their
-- successor; they are simply not displayed. Where a customer holds several loans this
-- is an allocation, not a fact — the ledger cannot say which facility was paid. Tagging
-- payments with their facility is the real fix and is not attempted here.
--
-- REVERSIBLE: the pre-netting figure is snapshotted into original_outstanding_kobo
-- before anything is changed, so this can be undone with a single UPDATE.

ALTER TABLE app.collection_assignments
    ADD COLUMN IF NOT EXISTS original_outstanding_kobo BIGINT;

COMMENT ON COLUMN app.collection_assignments.original_outstanding_kobo IS
  'outstanding_kobo as first imported (the sheet''s approved amount, before receipts were netted off by migration 222). Kept so the netting is reversible.';

-- Snapshot once, and only once.
UPDATE app.collection_assignments
   SET original_outstanding_kobo = outstanding_kobo
 WHERE data_source = 'manual' AND product_type = 'loan'
   AND original_outstanding_kobo IS NULL;

WITH cif_paid AS (
    SELECT account_cif, SUM(amount_kobo) AS paid
      FROM app.collection_payments GROUP BY 1
), al AS (
    SELECT a.id,
           COALESCE(a.target_amount_kobo, a.original_outstanding_kobo, 0) AS approved,
           COALESCE(p.paid, 0) AS pool,
           -- How much of the customer's receipts the loans ahead of this one have
           -- already claimed.
           COALESCE(SUM(COALESCE(a.target_amount_kobo, a.original_outstanding_kobo, 0)) OVER (
               PARTITION BY a.account_cif
               ORDER BY a.disbursement_date ASC NULLS LAST, a.id ASC
               ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS claimed_before
      FROM app.collection_assignments a
      LEFT JOIN cif_paid p ON p.account_cif = a.account_cif
     WHERE a.data_source = 'manual' AND a.product_type = 'loan'
), netted AS (
    SELECT id, approved,
           LEAST(approved, GREATEST(pool - claimed_before, 0)) AS received
      FROM al
)
UPDATE app.collection_assignments a
   SET outstanding_kobo = GREATEST(n.approved - n.received, 0),
       updated_at       = NOW()
  FROM netted n
 WHERE a.id = n.id
   AND a.outstanding_kobo IS DISTINCT FROM GREATEST(n.approved - n.received, 0);

-- A loan with nothing left to collect is closed, not a live collections item. This
-- covers the nine the source workbook already banners as CLOSED — every one of which
-- is independently confirmed fully repaid by its own receipts (ASI ENGINEERING
-- ₦400,000,000.00 approved against ₦420,000,000.00 received, MON DIEU MONTESSORI
-- ₦1,000,000.00 against ₦1,149,999.99, and so on) — plus any other uploaded loan the
-- receipts show as settled. Confirmed with the user 2026-09-09.
UPDATE app.collection_assignments
   SET status     = 'closed',
       updated_at = NOW()
 WHERE data_source = 'manual' AND product_type = 'loan'
   AND superseded_by_id IS NULL
   AND status IN ('active', 'sent_to_recovery')
   AND COALESCE(original_outstanding_kobo, 0) > 0
   AND outstanding_kobo = 0;

-- Recovery cases opened against a loan that turns out to be fully repaid are closed
-- with it, so the recovery book does not keep chasing settled debt.
UPDATE app.recovery_cases r
   SET status     = 'closed',
       closed_at  = COALESCE(r.closed_at, NOW()),
       outstanding_kobo = 0,
       total_outstanding_kobo = 0,
       updated_at = NOW()
 WHERE r.status <> 'closed'
   AND NOT EXISTS (
       SELECT 1 FROM app.collection_assignments a
        WHERE COALESCE(NULLIF(a.account_cif,''), '') = COALESCE(NULLIF(r.account_cif,''), r.cif_number)
          AND a.status IN ('active','sent_to_recovery')
          AND COALESCE(a.outstanding_kobo,0) > 0)
   AND EXISTS (
       SELECT 1 FROM app.collection_assignments a
        WHERE COALESCE(NULLIF(a.account_cif,''), '') = COALESCE(NULLIF(r.account_cif,''), r.cif_number)
          AND a.data_source = 'manual' AND a.product_type = 'loan');

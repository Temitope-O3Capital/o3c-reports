-- Remove the corrupted duplicate block from the LOAN REPAYMENT CRM import.
--
-- WHAT WENT WRONG (proved against the source workbook, not inferred):
-- The sheet's CLOSED section is pasted twice — rows 57-64 (block A) and rows
-- 112-121 (block B). Every column matches between the two blocks — mandate,
-- approved amount, rate, debit day, tenor, repayment — EXCEPT the NAME column,
-- which in block B is offset by one row because the first customer's name landed
-- on the "CLOSED" marker row (r112) instead of the first data row (r113). Six
-- loans were therefore filed against the wrong customers:
--
--   MANDATE                  block A (correct)      block B (wrong)
--   NO MANDATE      ₦5m      ODOMETA ONOME          VESTITUDE PARTNERS
--   1014-6135-5687  ₦10m     VESTITUDE PARTNERS     ABEEB ADAMS OLAMILEKAN
--   2514-6394-6723  ₦5m      ABEEB ADAMS OLAMILEKAN FINTRAK
--   NO MANDATE      ₦60m     FINTRAK                EDWARD COSMETICS
--   1314-5801-…     ₦5m      EDWARD COSMETICS       OKE STEPHEN
--   0928650/…       ₦1.5m    OKE STEPHEN            AJAYI JOSEPH
--
-- Block A is authoritative: it sits in the natural CLOSED section and runs on to
-- FOLTI, BELLE REPUBLIK, THIERRY, TRADEPORT, BALOGUN, KEMDIO and ASI, whereas
-- block B stops after eight rows. Confirmed with the user 2026-09-09.
--
-- Block B's month columns carry amounts but NO dates, so none of its payments were
-- ever imported (they were parked as "no_date" — see COLLECTION_REPAYMENTS_parked.csv).
-- Nothing financial is being reversed here: only the six phantom loan rows go, plus
-- the payment→assignment links that pointed at them.
--
-- Reversible: the six deleted rows are reconstructable from the workbook, and every
-- row this migration writes is tagged (reference marker 'LRCRM:' / notes 'imp:').

BEGIN;

-- The six block-B assignment rows, identified by the sheet sequence the import
-- recorded in cif_number. Resolved by value, never by hardcoded id.
CREATE TEMP TABLE _bad_block ON COMMIT DROP AS
SELECT ca.id,
       ca.account_cif,
       (SELECT MIN(a.id) FROM app.collection_assignments a
         WHERE a.account_cif = ca.account_cif
           AND a.data_source = 'manual' AND a.product_type = 'loan'
           AND a.id <> ca.id) AS keep_id
  FROM app.collection_assignments ca
 WHERE ca.data_source = 'manual'
   AND ca.cif_number IN ('LRC0056','LRC0057','LRC0058','LRC0059','LRC0060','LRC0061');

-- 1. Payments were attached to the NEWEST assignment for their CIF, which made them
--    point at block-B rows. The payments themselves are block A's and are correct —
--    only the link is wrong. Repoint before deleting so nothing is orphaned.
UPDATE app.collection_payments p
   SET assignment_id = b.keep_id
  FROM _bad_block b
 WHERE p.assignment_id = b.id AND b.keep_id IS NOT NULL;

-- Any that cannot be repointed lose the link rather than the payment (assignment_id
-- is nullable and most of the ledger carries no link at all).
UPDATE app.collection_payments p
   SET assignment_id = NULL
  FROM _bad_block b
 WHERE p.assignment_id = b.id;

-- 2. Recovery cases opened off a block-B row keep the case but follow the surviving
--    assignment, and have their exposure recomputed from what actually remains.
UPDATE app.recovery_cases r
   SET source_assignment_id = b.keep_id
  FROM _bad_block b
 WHERE r.source_assignment_id = b.id;

UPDATE app.recovery_cases r
   SET source_assignment_id = NULL
  FROM _bad_block b
 WHERE r.source_assignment_id = b.id;

-- 3. Drop the phantom loans.
DELETE FROM app.collection_assignments ca USING _bad_block b WHERE ca.id = b.id;

-- 4. Re-derive the affected recovery cases' outstanding from the surviving loans, so
--    the deleted exposure stops being counted.
UPDATE app.recovery_cases r
   SET outstanding_kobo       = sub.kobo,
       total_outstanding_kobo = sub.kobo,
       updated_at             = NOW()
  FROM (SELECT ca.account_cif AS cif, COALESCE(SUM(ca.outstanding_kobo),0) AS kobo
          FROM app.collection_assignments ca
         WHERE ca.data_source = 'manual' AND ca.product_type = 'loan'
         GROUP BY 1) sub
 WHERE COALESCE(NULLIF(r.account_cif,''), r.cif_number) = sub.cif
   AND r.account_cif IN ('W000000000000044','W000000000000002')
   AND r.status <> 'closed';

-- 5. Mandate 0928650/1674/0020347869 belongs to AJAYI JOSEPH (CIF 00000637, two live
--    Udara loans), not to "OKE STEPHEN" — a name that appears nowhere in the customer
--    master or in Udara. Confirmed with the user 2026-09-09. The loan was never
--    imported because that name resolved to no CIF; it is created here against the
--    real customer. Terms from workbook row 62.
INSERT INTO app.collection_assignments
    (cif_number, account_cif, customer_name, product_type, data_source, status,
     loan_ref, outstanding_kobo, target_amount_kobo, repayment_kobo, loan_rate,
     loan_tenor, debit_day, disbursement_date, maturity_date, officer_name,
     assignment_date, assigned_by, current_stage, dpd_bucket, notes)
-- cif_number carries a UNIQUE index among active rows, and the import never assigned
-- this row a sequence number (it skipped straight from EDWARD COSMETICS to FAHOMI
-- because "OKE STEPHEN" resolved to no customer). LRC0066 is the next free slot after
-- the imported range LRC0001-LRC0061.
SELECT 'LRC0066', '00000637', 'AJAYI JOSEPH', 'loan', 'manual', 'active',
       '0928650/1674/0020347869', 150000000, 150000000, 20000000, '5',
       '12', '28', DATE '2026-02-28', DATE '2027-02-28', 'COO',
       CURRENT_DATE, 1, 'new', '0',
       'imp:loan-repayment-crm-2026-09; re-filed from the mis-named OKE STEPHEN row'
 WHERE NOT EXISTS (
     SELECT 1 FROM app.collection_assignments
      WHERE account_cif = '00000637' AND loan_ref = '0928650/1674/0020347869');

-- 6. Its three DATED repayments (workbook row 62 months 1-3), previously parked for
--    want of a CIF. Guarded by the same marker convention as migration 212.
INSERT INTO app.collection_payments
    (assignment_id, account_cif, amount_kobo, payment_date, channel, reference,
     received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments
         WHERE account_cif = '00000637' AND loan_ref = '0928650/1674/0020347869'
         ORDER BY id DESC LIMIT 1),
       '00000637', v.kobo, v.d, 'crm_import', v.ref, 11, 'approved', false
  FROM (VALUES
        (37500000::bigint,  DATE '2026-03-29', 'LRCRM:00000637:M1:2026-03-29:37500000'),
        (77500000::bigint,  DATE '2026-04-29', 'LRCRM:00000637:M2:2026-04-29:77500000'),
        (57500000::bigint,  DATE '2026-05-09', 'LRCRM:00000637:M3:2026-05-09:57500000')
       ) AS v(kobo, d, ref)
 WHERE NOT EXISTS (
     SELECT 1 FROM app.collection_payments p
      WHERE p.channel = 'crm_import' AND p.reference = v.ref);

COMMIT;

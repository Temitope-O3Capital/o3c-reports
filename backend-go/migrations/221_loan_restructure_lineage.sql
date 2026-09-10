-- Restructured loans should appear ONCE, with their prior terms as history.
--
-- The LOAN REPAYMENT CRM workbook is in two sections: a RUNNING book (rows 3-53) and,
-- under a "CLOSED" banner, the settled / pre-restructure facilities (rows 57-71). The
-- import flattened both into collection_assignments with status='active', so a mandate
-- that had been restructured came through TWICE and reads as two live loans:
--
--   1114-7014-7802  FOLTI TECHNOLOGY   running r25 (₦156m)  + closed r65 (₦250m, DD "RESTRUCTURED/15")
--   1314-5801-…     EDWARD COSMETICS   running r36 (₦5m)    + closed r61 (₦5m, repaid ₦5.5m)
--
-- This migration records which section each row came from and links the pairs, so the
-- live facility carries its predecessor as lineage instead of standing beside it.
--
-- It deliberately does NOT change any status or outstanding amount. Eleven CLOSED-section
-- rows are still marked active and carry ₦751,000,000 between them; whether that is live
-- exposure is a business call, not something to infer from a banner in a spreadsheet.
-- book_section makes the question answerable — and reversible — without pre-empting it.

ALTER TABLE app.collection_assignments ADD COLUMN IF NOT EXISTS book_section TEXT;
ALTER TABLE app.collection_assignments ADD COLUMN IF NOT EXISTS superseded_by_id BIGINT;

COMMENT ON COLUMN app.collection_assignments.book_section IS
  'Which section of the source workbook this loan came from: running (live book) or closed (settled / pre-restructure). NULL for rows not sourced from that import.';
COMMENT ON COLUMN app.collection_assignments.superseded_by_id IS
  'The live assignment that replaced this one — set when the same mandate appears in both the running and closed sections, i.e. the loan was restructured or re-drawn. A superseded row is history, not a second facility.';

-- Section, from the workbook's own layout. LRC0041-LRC0055 sit under the CLOSED banner.
UPDATE app.collection_assignments
   SET book_section = CASE WHEN cif_number BETWEEN 'LRC0041' AND 'LRC0055' THEN 'closed' ELSE 'running' END
 WHERE data_source = 'manual' AND cif_number LIKE 'LRC%'
   AND book_section IS DISTINCT FROM
       (CASE WHEN cif_number BETWEEN 'LRC0041' AND 'LRC0055' THEN 'closed' ELSE 'running' END);

-- Link each closed-section row to the live row on the same mandate for the same
-- customer. Matching on (account_cif, loan_ref) — a real mandate only, never the
-- 'NO MANDATE' placeholder, which is not an identifier and would collapse unrelated loans.
UPDATE app.collection_assignments old
   SET superseded_by_id = live.id
  FROM app.collection_assignments live
 WHERE old.data_source = 'manual' AND old.product_type = 'loan'
   AND live.data_source = 'manual' AND live.product_type = 'loan'
   AND old.book_section = 'closed' AND live.book_section = 'running'
   AND old.account_cif = live.account_cif
   AND old.loan_ref = live.loan_ref
   AND COALESCE(NULLIF(TRIM(old.loan_ref),''),'NO MANDATE') <> 'NO MANDATE'
   AND old.id <> live.id
   AND old.superseded_by_id IS DISTINCT FROM live.id;

CREATE INDEX IF NOT EXISTS idx_coll_assign_superseded ON app.collection_assignments (superseded_by_id)
  WHERE superseded_by_id IS NOT NULL;

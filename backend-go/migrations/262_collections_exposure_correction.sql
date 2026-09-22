-- 262 — Undo the collections exposure inflation, and stop the view double-counting.
--
-- CAUSE. handlers/collections.go `collectionsGenerateAssignments` stamped the CIF-level
-- SUM from app.collections_delinquent_unified onto EVERY active assignment for that
-- customer, with no data_source/product_type filter and no superseded_by_id guard. The
-- view's third branch reads collection_assignments.outstanding_kobo for manual rows — so
-- the statement read the column it was about to write and re-inflated on every run,
-- silently reversing migration 222's one-shot netting.
--
-- Worked example (FOLTI, account_cif W000000000000023):
--   id 1755  approved N156,000,000                     carried N279,580,000
--   id 1782  approved N250,000,000, superseded_by 1755  carried N279,580,000
-- The view returned FOLTI twice at N559,160,000 for a facility Udara carries at
-- N154,300,000 outstanding. Five rows across the book carried an outstanding balance
-- LARGER than the amount ever approved — N212,593,334 of arithmetically impossible debt.
--
-- The handler is fixed in the same change set (three statements that cannot feed each
-- other, the uploaded book recomputed per facility). This migration is the record of the
-- data correction; because the new handler is self-healing, the first run of Generate
-- Assignments after deploy would otherwise perform it silently and unrecorded.
--
-- Section 1 recomputes migration 222's netting: approved less receipts allocated
-- oldest-disbursement-first, with closed and superseded rows taking part in the
-- allocation so a superseded row claims its own receipts instead of donating them to its
-- successor. Idempotent — running it twice changes nothing.
--
-- Expected: 14 rows change; uploaded loan book N1,378,246,801.66 -> N859,406,579.10
-- (-N518,840,222.56); 0 rows left with outstanding > approved.

BEGIN;

WITH cif_paid AS (
    SELECT account_cif, SUM(amount_kobo) AS paid
      FROM app.collection_payments
     GROUP BY 1
), al AS (
    SELECT a.id,
           COALESCE(a.target_amount_kobo, a.original_outstanding_kobo, 0) AS approved,
           COALESCE(p.paid, 0) AS pool,
           COALESCE(SUM(COALESCE(a.target_amount_kobo, a.original_outstanding_kobo, 0)) OVER (
               PARTITION BY a.account_cif
               ORDER BY a.disbursement_date ASC NULLS LAST, a.id ASC
               ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS claimed_before
      FROM app.collection_assignments a
      LEFT JOIN cif_paid p ON p.account_cif = a.account_cif
     WHERE a.data_source = 'manual' AND a.product_type = 'loan'
), netted AS (
    SELECT id,
           GREATEST(approved - LEAST(approved, GREATEST(pool - claimed_before, 0)), 0) AS outstanding
      FROM al
)
UPDATE app.collection_assignments a
   SET outstanding_kobo = n.outstanding, updated_at = NOW()
  FROM netted n
 WHERE a.id = n.id
   AND a.outstanding_kobo IS DISTINCT FROM n.outstanding;

-- Mirrors migration 222's own close rule: a live facility fully repaid is closed rather
-- than left sitting at zero in the queue. Expected: 1 row (FINTRAK, approved N80,000,000).
UPDATE app.collection_assignments
   SET status = 'closed', updated_at = NOW()
 WHERE data_source = 'manual' AND product_type = 'loan'
   AND superseded_by_id IS NULL
   AND status IN ('active','sent_to_recovery')
   AND COALESCE(original_outstanding_kobo, 0) > 0
   AND outstanding_kobo = 0;

COMMIT;

-- ── 2. The view still double-counts superseded facilities ────────────────────
-- Branch 3 of app.collections_delinquent_unified (migration 207) has no lineage guard, so
-- a pre-restructure row and its successor are both returned. handlers/collections_portfolio.go
-- is the ONLY surface that compensates (WHERE u.superseded_by_id IS NULL) — every KPI that
-- reads the view directly counts the debt twice. Two rows are affected today: id 1782
-- FOLTI and id 1779 EDWARD COSMETICS, N253,999,832 combined after the correction above.
--
-- Guarded rather than assumed: only re-created if the view exists and does not already
-- carry the predicate, so a concurrent session's edit is never clobbered.
DO $$
DECLARE
    def text;
BEGIN
    SELECT pg_get_viewdef('app.collections_delinquent_unified'::regclass, true) INTO def;
    IF def IS NULL THEN
        RAISE NOTICE '262: collections_delinquent_unified absent — skipping lineage guard';
        RETURN;
    END IF;
    IF position('superseded_by_id IS NULL' IN def) > 0 THEN
        RAISE NOTICE '262: lineage guard already present — leaving view untouched';
        RETURN;
    END IF;
    IF position('ca.data_source = ''manual''::text' IN def) = 0
       AND position('ca.data_source = ''manual''' IN def) = 0 THEN
        RAISE WARNING '262: could not locate the manual branch — lineage guard NOT applied, apply by hand';
        RETURN;
    END IF;
    -- Add the guard to the manual/uploaded branch only. The CBS branches already exclude
    -- predecessors via status NOT IN ('Closed','Revoked').
    def := replace(def,
        'ca.data_source = ''manual''::text',
        'ca.data_source = ''manual''::text AND ca.superseded_by_id IS NULL');
    EXECUTE 'CREATE OR REPLACE VIEW app.collections_delinquent_unified AS ' || def;
    RAISE NOTICE '262: lineage guard applied to collections_delinquent_unified';
END $$;

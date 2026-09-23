-- 289 — One Udara loan may be mirrored by only ONE live queue row.
--
-- WHAT WENT WRONG. Migration 287 linked ODOMETA ONOME's three uploaded rows to the same
-- Udara facility (HARRIET ODOMETA, 1200045402000003550). That looked harmless — three
-- sheet rows, one real loan, now correctly identified.
--
-- It was not harmless. The collections refresh (statement 2b in runCollectionsGenerate)
-- syncs outstanding_kobo onto EVERY row carrying a duplicate_of_cbs_id, from the Udara
-- loan it points at. With three rows pointing at one loan, it stamped the full
-- N31,600,000.00 on each of them:
--
--     before 287   1741 N17,100,000.00   1742 N14,000,000.00   1789 N0.00   = N31,100,000.00
--     after  287   1741 N31,600,000.00   1742 N31,600,000.00   1789 N31,600,000.00 = N94,800,000.00
--
-- So an attempt to remove double-counting tripled one borrower instead. The sync is not
-- at fault — mirroring the book of record onto a linked row is exactly its job. The
-- fault is that a one-to-one relationship was allowed to become one-to-many.
--
-- THE RULE. A Udara facility is a single debt and can be represented on the queue once.
-- Where several live rows point at the same cbs_id, the earliest is kept and the rest are
-- closed. Keeping the earliest preserves the row an agent has been working and any
-- contact history hanging off it.
--
-- Only one loan is affected today (the one this migration created), but the statement is
-- written generally so the same shape cannot survive a future link, however it arrives.

BEGIN;

WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY duplicate_of_cbs_id ORDER BY id) AS rn
      FROM app.collection_assignments
     WHERE duplicate_of_cbs_id IS NOT NULL
       AND status IN ('active','sent_to_recovery')
)
UPDATE app.collection_assignments ca
   SET status     = 'closed',
       updated_at = NOW()
  FROM ranked r
 WHERE ca.id = r.id AND r.rn > 1;

DO $m289$
DECLARE still int;
BEGIN
    SELECT COUNT(*) INTO still FROM (
        SELECT duplicate_of_cbs_id
          FROM app.collection_assignments
         WHERE duplicate_of_cbs_id IS NOT NULL AND status IN ('active','sent_to_recovery')
         GROUP BY 1 HAVING COUNT(*) > 1) z;
    IF still > 0 THEN
        RAISE EXCEPTION '289: % Udara loan(s) still mirrored by more than one live row — refusing', still;
    END IF;
    RAISE NOTICE '289: every Udara loan is mirrored by at most one live queue row';
END $m289$;

COMMIT;

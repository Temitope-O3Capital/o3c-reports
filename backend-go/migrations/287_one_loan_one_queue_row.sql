-- 287 — One loan, one queue row: stop the uploaded sheet and Udara both carrying it.
--
-- THE DEFECT. The book-of-record rule for the collections queue is: where a facility
-- exists in BOTH the uploaded loan sheet and Udara, Udara wins; only sheet rows with no
-- Udara counterpart stand on their own. Migration 268 did the hard half — it identified
-- 30 sheet rows that mirror a Udara loan and stamped duplicate_of_cbs_id on them.
--
-- It never did the other half. The stamped rows were left on the queue as live work,
-- and the Udara arm carries its OWN row for the same loan keyed 'UD-<customer id>'. So
-- 22 borrowers sat on the queue twice — once from the sheet, once from Udara, at the
-- same amount 20 times out of 22:
--
--     NASSCOOP SOCIETY LTD   sheet id 1767  N111,111,111.11   +  udara id 1801  N111,111,111.11
--     AMBIENCE PLUS          sheet id 1745  N100,000,000.00   +  udara id 1308  N100,000,000.00
--     FINTRAK                sheet id 1747  N 40,000,000.00   +  udara id 1812  N 40,000,000.00
--
-- Sheet side N612,986,666.66 against a Udara side of N720,566,666.66 — N612,986,666.66
-- of the loan queue's N1,767,498,334.99 is the same debt counted twice, about 35% of it.
-- An agent works both rows; every queue total, portfolio figure and management report
-- reads the sum.
--
-- PART 1 links five more sheet rows whose Udara counterpart migration 268's name matcher
-- did not reach. Each was confirmed by the business, not inferred here — the matcher is
-- deliberately not being loosened, because it is exactly the kind of guess that paired
-- "Grey Loft Hotel" with "Ambience Hotel and Resorts" on a shared token earlier:
--
--     AREMU KIMSET              -> AREMU AYOBAMI                  (00000001)
--     ODOMETA ONOME (x3 rows)   -> HARRIET ODOMETA                (00000355)
--     DOOSHIMA CAROLINE FAGGA   -> DOOSH TRADING GLOBAL VENTURES  (00000560)
--
-- PART 2 closes any sheet row that mirrors a Udara loan WHEN a live Udara row already
-- carries that customer. The guard is the point: a mirror whose Udara row is not on the
-- queue is left alone, because closing it would drop the debt entirely rather than move
-- it. HARRIET ODOMETA is precisely that case — Udara has her Active, DPD 0, with zero
-- overdue instalments and the facility maturing today, so no Udara row exists to inherit
-- her. Her rows stay and are merely linked, and the fact that Udara considers her
-- current is left for a person to act on.
--
-- Verified in a rolled-back dry run before writing.

BEGIN;

-- ── Part 1: link the five confirmed matches ────────────────────────────────────
UPDATE app.collection_assignments SET duplicate_of_cbs_id = '57184836-38cf-44ea-87b4-a49bc5ae5aa1', updated_at = NOW()
 WHERE id = 1768 AND duplicate_of_cbs_id IS NULL;   -- AREMU KIMSET -> AREMU AYOBAMI

UPDATE app.collection_assignments SET duplicate_of_cbs_id = 'cc8bc1da-739b-4006-a212-af6c59c69660', updated_at = NOW()
 WHERE id IN (1741, 1742, 1789) AND duplicate_of_cbs_id IS NULL;  -- ODOMETA ONOME -> HARRIET ODOMETA

UPDATE app.collection_assignments SET duplicate_of_cbs_id = 'c38522bc-52d3-4036-9262-287762e19988', updated_at = NOW()
 WHERE id = 1740 AND duplicate_of_cbs_id IS NULL;   -- DOOSHIMA CAROLINE FAGGA -> DOOSH TRADING

-- ── Part 2: Udara wins where Udara is actually on the queue ────────────────────
UPDATE app.collection_assignments ca
   SET status     = 'closed',
       updated_at = NOW()
  FROM app.cbs_loans cl
 WHERE cl.cbs_id::text = ca.duplicate_of_cbs_id::text
   AND ca.status IN ('active','sent_to_recovery')
   AND EXISTS (SELECT 1 FROM app.collection_assignments u
                WHERE u.account_cif = 'UD-' || cl.cbs_customer_id
                  AND u.status IN ('active','sent_to_recovery'));

-- Nothing may have been dropped: every borrower whose sheet row just closed must still
-- be on the queue on the Udara side.
DO $m287$
DECLARE dropped int; closed_n int;
BEGIN
    SELECT COUNT(*) INTO closed_n
      FROM app.collection_assignments ca JOIN app.cbs_loans cl ON cl.cbs_id::text = ca.duplicate_of_cbs_id::text
     WHERE ca.status = 'closed';

    SELECT COUNT(*) INTO dropped
      FROM app.collection_assignments ca
      JOIN app.cbs_loans cl ON cl.cbs_id::text = ca.duplicate_of_cbs_id::text
     WHERE ca.status = 'closed'
       AND NOT EXISTS (SELECT 1 FROM app.collection_assignments u
                        WHERE u.account_cif = 'UD-' || cl.cbs_customer_id
                          AND u.status IN ('active','sent_to_recovery'))
       AND NOT EXISTS (SELECT 1 FROM app.collection_assignments k
                        WHERE k.id = ca.superseded_by_id AND k.status IN ('active','sent_to_recovery'));
    IF dropped > 0 THEN
        RAISE EXCEPTION '287: % closed row(s) have nothing carrying the debt — refusing', dropped;
    END IF;
    RAISE NOTICE '287: % mirrored sheet row(s) now closed; Udara carries them', closed_n;
END $m287$;

COMMIT;

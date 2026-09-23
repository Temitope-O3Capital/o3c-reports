-- 286 — A superseded facility must not sit on the collections queue as live work.
--
-- THE DEFECT. When a loan is restructured, the uploaded loan book carries BOTH halves as
-- separate rows: the old facility and the one that replaced it. Migration 221 linked them
-- with superseded_by_id precisely so the pair would not read as two live loans, and
-- migration 268 taught the delinquency VIEW to skip the superseded half.
--
-- Neither was enough, because the collections QUEUE reads app.collection_assignments
-- directly. The rows were correctly marked and still had status='active', so they kept
-- appearing as work to do:
--
--   id 1782  FOLTI TECHNOLOGY  N250,000,000.00  superseded_by_id=1755  status=active
--   id 1755  FOLTI TECHNOLOGY  N154,300,000.00  live, mirrors Udara 1200045402000005531
--
-- Udara is the book of record and it is unambiguous here: account 1200045402000005530
-- (N250,000,000) is Closed, and app.loan_restructure_links records it as re-papered into
-- 1200045402000005531, which is the N154,300,000 facility row 1755 already tracks. So the
-- borrower was on the queue twice for the two halves of one debt — N253,999,832.33 of
-- work that does not exist, across the two rows below.
--
-- THE RULE THIS RESTORES is the one the collections book was given: where a facility
-- exists in BOTH the uploaded sheet and Udara, Udara wins; only sheet rows with no Udara
-- counterpart stand on their own.
--
-- SAFETY. Verified in a rolled-back dry run before writing: both rows are covered after
-- closing, so no debt stops being worked —
--
--   1782 FOLTI TECHNOLOGY   successor row 1755 is itself active and mirrors Udara
--   1779 EDWARD COSMETICS   successor 1763 is closed, BUT the borrower is already
--                           carried on the Udara arm as UD-00000556 (row 908), which is
--                           in recovery — so the N5,000,000 Udara says they owe is worked
--                           there, not lost with this row.
--
-- The code-side guard in collectionsOpsList (WHERE ... AND ca.superseded_by_id IS NULL)
-- lands with this and stops a newly-marked row ever showing before a migration runs.
-- This statement fixes the eleven OTHER readers that filter only on status, which is why
-- the data is corrected here rather than by patching each call site.

BEGIN;

UPDATE app.collection_assignments ca
   SET status     = 'closed',
       updated_at = NOW()
 WHERE ca.superseded_by_id IS NOT NULL
   AND ca.status IN ('active','sent_to_recovery')
   -- Never close a row whose replacement is not actually carrying the debt. Either the
   -- successor row is live, or the borrower is on the Udara arm of the queue.
   AND (
        EXISTS (SELECT 1 FROM app.collection_assignments k
                 WHERE k.id = ca.superseded_by_id
                   AND k.status IN ('active','sent_to_recovery'))
     OR EXISTS (SELECT 1 FROM app.collection_assignments u
                  JOIN app.cbs_links l ON l.entity_type = 'party' AND l.entity_id = ca.party_id
                 WHERE u.account_cif = 'UD-' || l.cbs_customer_id
                   AND u.status IN ('active','sent_to_recovery'))
   );

DO $m286$
DECLARE closed_n int; still int;
BEGIN
    SELECT COUNT(*) INTO closed_n FROM app.collection_assignments
     WHERE superseded_by_id IS NOT NULL AND status = 'closed';
    SELECT COUNT(*) INTO still FROM app.collection_assignments
     WHERE superseded_by_id IS NOT NULL AND status IN ('active','sent_to_recovery');
    RAISE NOTICE '286: % superseded row(s) closed; % left open because nothing else covers the debt', closed_n, still;
END $m286$;

COMMIT;

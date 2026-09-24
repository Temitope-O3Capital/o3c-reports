-- 292 — Restore the trail from a recovery case back to the collections row it came from.
--
-- THE DEFECT. recovery_cases.source_assignment_id is the only link between a case and the
-- queue row that produced it. escalateSevereToRecovery looked for that row with
--
--     WHERE ca.account_cif = b.key_cif AND ca.status = 'active'
--
-- but an assignment that has been escalated is no longer 'active' — the escalation itself
-- moves it to 'sent_to_recovery'. So for any account already in that state the subquery
-- returned NULL and the link was silently dropped.
--
-- Measured 2026-09-23 over 1,615 recovery cases:
--
--     1,036  in-app (RC-) cases carry no source_assignment_id
--       982  of those have a collections row on the same account_cif
--       959  of those rows were created BEFORE the case was opened
--       955  of those are sitting in 'sent_to_recovery'
--
-- So roughly 95% of every case recovery has opened from the queue cannot be traced back
-- to its origin — you cannot ask "where did this figure come from", reconcile a case
-- against the work that preceded it, or see that closing an assignment orphans a case.
--
-- WHAT IS AND IS NOT BACKFILLED. Only pairs where exactly ONE collections row exists for
-- the case's account_cif AND that row was created at or before the case was opened. The
-- date test is the honest part: 22 otherwise-matching rows were created AFTER their case,
-- so they cannot be what the case came from, and writing the link would be inventing
-- history rather than recovering it. One case has several candidate rows and is left
-- alone. 54 cases were never in collections at all and correctly have no source.
--
-- The code fix lands with this so new cases record the link; this repairs the old ones.

BEGIN;

UPDATE app.recovery_cases rc
   SET source_assignment_id = ca.id,
       updated_at           = NOW()
  FROM app.collection_assignments ca
 WHERE rc.case_ref LIKE 'RC-%'
   AND rc.source_assignment_id IS NULL
   AND rc.account_cif IS NOT NULL
   AND ca.account_cif = rc.account_cif
   AND ca.created_at <= rc.opened_at
   AND (SELECT COUNT(*) FROM app.collection_assignments c2
         WHERE c2.account_cif = rc.account_cif) = 1;

DO $m292$
DECLARE linked_n int; bad int;
BEGIN
    -- Nothing may point at an assignment that post-dates it.
    SELECT COUNT(*) INTO bad
      FROM app.recovery_cases rc JOIN app.collection_assignments ca ON ca.id = rc.source_assignment_id
     WHERE ca.created_at > rc.opened_at;
    IF bad > 0 THEN
        RAISE EXCEPTION '292: % case(s) now point at an assignment created after them — refusing', bad;
    END IF;

    SELECT COUNT(*) INTO linked_n FROM app.recovery_cases WHERE source_assignment_id IS NOT NULL;
    RAISE NOTICE '292: % recovery case(s) now carry a source assignment', linked_n;
END $m292$;

COMMIT;

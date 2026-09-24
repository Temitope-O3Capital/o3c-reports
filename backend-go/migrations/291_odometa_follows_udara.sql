-- 291 — ODOMETA: Udara becomes the only source, and Udara says she is not in arrears.
--
-- CONFIRMED BY THE BUSINESS: the uploaded sheet's ODOMETA ONOME and Udara's HARRIET
-- ODOMETA are one person, and Udara is to be her only source. The workspace still holds
-- them as two parties (708802 and 763109) with no crosswalk between them, so this is an
-- asserted identity, recorded here because nothing in the data states it.
--
-- WHAT UDARA ACTUALLY SAYS. Facility 1200045402000003550:
--
--     disbursed 2026-08-24    N31,600,000.00      status Active     DPD 0
--     matures   2026-09-23    one bullet instalment of N33,180,000.00, NotYetDue
--     repayments posted: none
--
-- It is a 30-day bullet loan falling due TODAY. She is not delinquent, and she does not
-- appear in app.collections_delinquent_unified at all.
--
-- WHAT THE WORKSPACE WAS DOING INSTEAD. Three uploaded rows on the queue and a recovery
-- case, all derived from the sheet:
--
--     collections 1741  N31,600,000.00  sent_to_recovery   (1742/1789 closed by 289)
--     recovery  RC-001060  N5,000,000.00  active, opened 2026-09-09 from assignment 1741
--
-- Neither figure is Udara's, and the recovery case was chasing N5,000,000 of a debt that
-- is not yet due. Under "Udara only" both come off.
--
-- WHY THIS IS SAFE. Nothing holds her bare Udara id — no collections row, no recovery
-- case — and app.cbs_links carries the 00000355 -> party 763109 bridge. So if the
-- instalment is not met, she enters the delinquency view tomorrow and the hourly queue
-- refresh opens a UD-00000355 row for her on its own, with Udara's own figure. Closing
-- these does not drop her; it stops her being worked on a number no system of record
-- agrees with, and lets the Udara arm pick her up if and when she actually defaults.

BEGIN;

UPDATE app.collection_assignments
   SET status        = 'closed',
       updated_at    = NOW()
 WHERE account_cif = 'W000000000000038'
   AND status IN ('active','sent_to_recovery');

UPDATE app.recovery_cases
   SET status        = 'closed',
       closed_at     = NOW(),
       closed_reason = 'Udara is the sole source for this borrower (confirmed 2026-09-23). '
                       || 'Udara facility 1200045402000003550 is Active at DPD 0 with its only '
                       || 'instalment NotYetDue, so there is no delinquency to recover. This case '
                       || 'was opened from uploaded-sheet assignment 1741 for N5,000,000, a figure '
                       || 'no system of record carries. Closed by migration 291; the hourly queue '
                       || 'refresh will open a UD-00000355 row if the instalment is missed.',
       updated_at    = NOW()
 WHERE source_assignment_id IN (
         SELECT id FROM app.collection_assignments WHERE account_cif = 'W000000000000038')
   AND status NOT IN ('closed','recovered','written_off');

DO $m291$
DECLARE left_open int; blocked int;
BEGIN
    SELECT COUNT(*) INTO left_open
      FROM app.collection_assignments WHERE account_cif = 'W000000000000038'
       AND status IN ('active','sent_to_recovery');
    IF left_open > 0 THEN
        RAISE EXCEPTION '291: % sheet row(s) still open for this borrower — refusing', left_open;
    END IF;

    -- The Udara arm must remain free to claim her: nothing may hold the bare id.
    SELECT COUNT(*) INTO blocked FROM app.collection_assignments
     WHERE account_cif = '00000355' AND status IN ('active','sent_to_recovery');
    IF blocked > 0 THEN
        RAISE EXCEPTION '291: a cards-namespace row holds this Udara id — the Udara arm could not reclaim her';
    END IF;

    RAISE NOTICE '291: ODOMETA now follows Udara only; not delinquent, so not on the queue';
END $m291$;

COMMIT;

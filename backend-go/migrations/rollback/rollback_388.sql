-- Rollback for 388_a_future_dated_payment_is_a_schedule_not_a_receipt.sql
--
-- WHAT THIS RESTORES. Five recovery payments dated between 2026-11-28 and 2027-01-28 go back
-- to status 'approved', and the trigger that keeps a future-dated row out of every "collected"
-- sum is dropped.
--
-- WHAT YOU ARE ROLLING BACK TO. A reported recovery figure that is N140,600,000 higher than
-- the money received, because it counts two N64,200,000 FINTRAK instalments dated January 2027
-- as though they had already been paid. Recovery collected goes from N780,623,281.92 back to
-- N921,223,281.92. Roll this back only if 388 broke a consumer that cannot cope with the
-- status — not to restore the larger number, which was never true.
--
-- THE GO SIDE MUST GO BACK WITH IT. chainStatusClause excludes 'scheduled' from its "still in
-- the chain" branch and writeOffStageLabel labels it. If any row anywhere still carries
-- 'scheduled' after this rollback and that code has ALSO been reverted, those rows become
-- invisible: not approved, not rejected, and not pending either. The assertion below refuses
-- to finish while such a row exists.
--
-- NOTHING WAS DELETED by 388, so no amount, case or reference needs reconstructing.

BEGIN;

-- THE TRIGGER GOES FIRST, AND THE ORDER IS THE WHOLE TRICK. 388's trigger fires BEFORE
-- UPDATE OF status and coerces any future-dated row back to 'scheduled' — so with the UPDATE
-- written first, as it was in the draft of this file, the rollback runs without error,
-- reports "UPDATE 5", changes nothing, and its own assertion then fails one line later.
DROP TRIGGER IF EXISTS recovery_payment_not_a_receipt_yet ON app.recovery_payments;
DROP FUNCTION IF EXISTS app.recovery_payment_not_a_receipt_yet();

UPDATE app.recovery_payments
   SET status = 'approved',
       notes  = NULLIF(
                  btrim(
                    replace(
                      replace(COALESCE(notes,''),
                        ' | Reclassified by migration 388: dated in the future, so a scheduled instalment rather than a receipt.', ''),
                      'Reclassified by migration 388: dated in the future, so a scheduled instalment rather than a receipt.', '')
                  ), '')
 WHERE status = 'scheduled'
   AND payment_date > CURRENT_DATE;

DO $assert$
DECLARE
  n INT;
BEGIN
  SELECT COUNT(*) INTO n FROM app.recovery_payments WHERE status = 'scheduled';
  IF n > 0 THEN
    RAISE EXCEPTION
      'rollback 388: % row(s) still carry status ''scheduled''. Revert them before reverting the Go change, or they will be invisible to every status filter.', n;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'recovery_payment_not_a_receipt_yet') THEN
    RAISE EXCEPTION 'rollback 388: the trigger is still present';
  END IF;
END $assert$;

COMMIT;

-- 388: A future-dated payment is a schedule, not a receipt
--
-- Five rows in app.recovery_payments are dated in the future and carry status 'approved',
-- so every figure that sums approved recovery counts N140,600,000 the business has not
-- received. Two of them are an identical pair of N64,200,000 against FINTRAK dated
-- 2027-01-28. You cannot have received money that has not happened yet.
--
-- All five came from the same spreadsheet load, reference 'imp:loans-2026-08', which loaded
-- an instalment PLAN as though every instalment were a receipt. The plan is real — migration
-- 366 records that FINTRAK genuinely pays 5,600,000 a month — so the rows are kept and
-- reclassified rather than deleted. What changes is what they claim to be.
--
--   446  FINTRAK                      N5,600,000   2026-11-28
--   448  KASARACHI ISAAC/KC UNITED    N1,000,000   2026-11-28
--   447  FINTRAK                      N5,600,000   2026-12-28
--   486  FINTRAK                     N64,200,000   2027-01-28
--   517  FINTRAK                     N64,200,000   2027-01-28
--
-- THIS MOVES A REPORTED FIGURE, WHICH IS THE POINT. Recovery collected drops by
-- N140,600,000 wherever it is summed over 'approved'. That is not a loss of data; it is the
-- removal of a claim that was never true. Nothing is deleted and the rollback restores the
-- old status exactly.
--
-- WHY A STATUS AND NOT A DATE FILTER
--
-- The codebase is already inconsistent about this, which is the deeper fault. handlers/
-- executive.go and recovery.go:244 guard their sums with `payment_date <= CURRENT_DATE`;
-- collections_ops.go:1959 and executive.go:1336-1345 do not, so a 2027 date can surface to
-- an officer as a customer's "last payment date". Fixing the rows fixes every reader at
-- once, including the ones nobody has found yet, where adding a sixth date guard would
-- leave the seventh reader still wrong.
--
-- 'scheduled' IS TERMINAL, AND THE CODE HAD TO LEARN THAT IN THE SAME CHANGE.
-- chainStatusClause's default branch is `status NOT IN ('approved','rejected')`, so on its
-- own this migration would have moved N140.6m OUT of recovery collected and straight INTO
-- the Recovery Payment Approvals queue, presented to a COO as money awaiting sign-off. The
-- Go change that teaches chainStatusClause and writeOffStageLabel about 'scheduled' ships
-- with this file and is not optional.
--
-- AND IT WILL NOT COUNT AGAIN WHEN THE DATE ARRIVES. A scheduled instalment reaching its
-- due date does not mean it was paid, so nothing promotes these rows automatically. They
-- stay 'scheduled' until a real receipt is recorded against the case, which is a person's
-- act and not a clock's.

BEGIN;

DO $guard$
DECLARE
  n INT;
  v NUMERIC;
BEGIN
  SELECT COUNT(*), COALESCE(SUM(amount_kobo),0) INTO n, v
    FROM app.recovery_payments
   WHERE payment_date > CURRENT_DATE AND status = 'approved';
  IF n <> 5 OR v <> 14060000000 THEN
    RAISE EXCEPTION
      'migration 388: expected exactly 5 future-dated approved recovery payments totalling N140,600,000; found % rows / % kobo. Re-measure before reclassifying money.', n, v;
  END IF;

  -- Nothing anywhere should already be using this status; if something does, the terminal
  -- handling in Go may mean something else and this file would be overloading it.
  SELECT COUNT(*) INTO n FROM app.recovery_payments WHERE status = 'scheduled';
  IF n <> 0 THEN
    RAISE EXCEPTION 'migration 388: % row(s) already carry status ''scheduled''; resolve the meaning collision first', n;
  END IF;
END $guard$;

UPDATE app.recovery_payments
   SET status = 'scheduled',
       notes  = CASE
                  WHEN COALESCE(notes,'') = '' THEN 'Reclassified by migration 388: dated in the future, so a scheduled instalment rather than a receipt.'
                  ELSE notes || ' | Reclassified by migration 388: dated in the future, so a scheduled instalment rather than a receipt.'
                END
 WHERE payment_date > CURRENT_DATE
   AND status = 'approved';

-- The structural half. A future-dated row can never again be stored as a receipt, whoever
-- writes it — an import, an endpoint, or a hand-written UPDATE. Keyed on the DATE, which is
-- the subject of the rule, rather than on the loader that happened to introduce it: the next
-- spreadsheet will have a different reference and the same problem.
--
-- It coerces rather than refusing. Refusing would abort an entire import over one undue
-- instalment and lose the rest of a genuine plan; coercing keeps the row, keeps its amount,
-- and corrects only the claim it makes about itself. A row deliberately written as
-- 'pending_hop' with a future date is left alone — that is an approval in flight, not a
-- claimed receipt.
CREATE OR REPLACE FUNCTION app.recovery_payment_not_a_receipt_yet()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.payment_date IS NOT NULL
     AND NEW.payment_date > CURRENT_DATE
     AND NEW.status IN ('approved', 'posted') THEN
    NEW.status := 'scheduled';
  END IF;
  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION app.recovery_payment_not_a_receipt_yet() IS
  'Keeps a future-dated recovery payment out of every "collected" sum by refusing to let it '
  'hold a receipt-bearing status. See migration 388: a spreadsheet load stored an instalment '
  'plan as 269 approved receipts, 5 of them dated up to 2027-01-28, overstating recovery by '
  'N140,600,000.';

DROP TRIGGER IF EXISTS recovery_payment_not_a_receipt_yet ON app.recovery_payments;
CREATE TRIGGER recovery_payment_not_a_receipt_yet
  BEFORE INSERT OR UPDATE OF payment_date, status ON app.recovery_payments
  FOR EACH ROW EXECUTE FUNCTION app.recovery_payment_not_a_receipt_yet();

DO $assert$
DECLARE
  n INT;
  v NUMERIC;
BEGIN
  SELECT COUNT(*) INTO n FROM app.recovery_payments WHERE status = 'scheduled';
  IF n <> 5 THEN
    RAISE EXCEPTION 'migration 388: expected 5 rows reclassified to scheduled, found %', n;
  END IF;

  -- No receipt-bearing row is dated in the future any more. This is the whole claim.
  SELECT COUNT(*) INTO n
    FROM app.recovery_payments
   WHERE payment_date > CURRENT_DATE AND status IN ('approved','posted');
  IF n <> 0 THEN
    RAISE EXCEPTION 'migration 388: % future-dated row(s) still claim to be received money', n;
  END IF;

  -- The money that remains claimed as recovered is the real figure, and it is asserted
  -- rather than described. 269 approved rows totalled N921,223,281.92; removing the
  -- N140,600,000 that is not yet due leaves N780,623,281.92.
  --
  -- The first draft of this assertion read N774,680,170.92, taken from the N915,280,170.92
  -- that is the total of the 264 IMPORTED rows rather than of all 269 approved ones. The
  -- assertion caught it on the first run, which is the whole reason the figure is asserted
  -- instead of written in a comment.
  SELECT COALESCE(SUM(amount_kobo),0) INTO v
    FROM app.recovery_payments WHERE status = 'approved';
  IF v <> 78062328192 THEN
    RAISE EXCEPTION
      'migration 388: approved recovery should now total N780,623,281.92 (78062328192 kobo); it is % kobo', v;
  END IF;

  -- And the trigger actually fires. A rule nobody tested is a comment.
  BEGIN
    INSERT INTO app.recovery_payments
      (case_id, amount_kobo, payment_date, channel, reference, status, posted_by)
    SELECT rp.case_id, 100, CURRENT_DATE + 30, 'Bank Transfer', 'mig388:trigger-probe', 'approved', rp.posted_by
      FROM app.recovery_payments rp LIMIT 1;
    IF EXISTS (SELECT 1 FROM app.recovery_payments WHERE reference = 'mig388:trigger-probe' AND status <> 'scheduled') THEN
      RAISE EXCEPTION 'migration 388: the trigger did not coerce a future-dated approved payment';
    END IF;
    DELETE FROM app.recovery_payments WHERE reference = 'mig388:trigger-probe';
  END;
END $assert$;

COMMIT;

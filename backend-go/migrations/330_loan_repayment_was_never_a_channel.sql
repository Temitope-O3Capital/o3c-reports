-- 330: "loan repayment" was never a channel. These were bank transfers.
--
-- Migration 321 reconciled recovery_payments.channel from 8 spellings to 5 and preserved every
-- original in channel_raw. It could not decide what 'loan repayment' (89 rows) and 'recovery'
-- (1 row) meant, so both were parked as 'Unspecified' rather than guessed at -- 95% of the
-- recovery payment book sitting under a label that answers no question.
--
-- The business has now answered it: 'loan repayment' is not a channel, it is what the money was
-- FOR. The channel was bank transfer, and the reason no channel was captured is that these rows
-- were uploaded rather than keyed by an officer.
--
-- The evidence agrees that all 90 are one upload, so they get one answer:
--     channel_raw      rows   created_at    payment_method   status     posted_by
--     loan repayment     89   2026-08-24    NULL             approved   1
--     recovery            1   2026-08-24    NULL             approved   1
-- Same day, same poster, no payment_method on any of them. 'recovery' is the same kind of
-- mislabel as 'loan repayment' -- a purpose word, not a channel -- from the same batch, so it
-- is mapped the same way instead of being left behind as a population of one.
--
-- channel_raw is NOT touched. It keeps 'loan repayment' and 'recovery' verbatim, so the fact
-- that this mapping is a business decision taken on 2026-10-05, rather than something the
-- upload told us, stays auditable for ever.
--
-- 'Unspecified' stays in the CHECK vocabulary. It is the right answer for a future payment whose
-- channel genuinely is not known; it was only wrong as a resting place for these 90.

BEGIN;

UPDATE app.recovery_payments
   SET channel = 'Bank Transfer'
 WHERE channel = 'Unspecified'
   AND channel_raw IN ('loan repayment', 'recovery');

DO $g$
DECLARE
    v_left      int;
    v_moved     int;
    v_total     bigint;
    v_raw_kept  int;
BEGIN
    SELECT count(*) INTO v_left FROM app.recovery_payments WHERE channel = 'Unspecified';
    IF v_left <> 0 THEN
        RAISE EXCEPTION '330: % payments still sit under Unspecified', v_left;
    END IF;

    SELECT count(*) INTO v_moved FROM app.recovery_payments
     WHERE channel = 'Bank Transfer' AND channel_raw IN ('loan repayment','recovery');
    IF v_moved <> 90 THEN
        RAISE EXCEPTION '330: expected 90 rows remapped to Bank Transfer, found %', v_moved;
    END IF;

    -- The originals must survive, or the audit trail for this decision is gone.
    SELECT count(*) INTO v_raw_kept FROM app.recovery_payments
     WHERE channel_raw = 'loan repayment';
    IF v_raw_kept <> 89 THEN
        RAISE EXCEPTION '330: channel_raw lost rows -- expected 89 "loan repayment", found %', v_raw_kept;
    END IF;

    -- Measured 2026-10-05 across the whole table, BEFORE this migration. Remapping a label
    -- must not move a single kobo. Migration 321 taught this twice: both its totals were
    -- wrong because I typed them instead of measuring them.
    SELECT COALESCE(sum(amount_kobo),0) INTO v_total FROM app.recovery_payments;
    IF v_total <> 92122328192 THEN
        RAISE EXCEPTION '330: recovery payment total changed -- expected 92122328192, got %', v_total;
    END IF;

    RAISE NOTICE '330: 90 uploaded payments attributed to Bank Transfer; total % unchanged', v_total;
END
$g$;

COMMIT;

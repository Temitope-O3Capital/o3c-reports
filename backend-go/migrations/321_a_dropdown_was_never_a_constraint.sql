-- 321: give the two recovery vocabularies a server and a database that agree with the screen.
--
-- Both existed ONLY as a TypeScript list. recoveryOpsPayment checked that channel was non-empty;
-- recoveryAddLegalMilestone checked that milestone_type was non-empty; neither column had a
-- CHECK. So the dropdown was the entire enforcement, and a dropdown is not a constraint.
--
-- PART 1 — recovery_payments.channel
--
-- 269 rows, NGN 921m, EIGHT distinct values, and not one of them was among the six the dropdown
-- offered (Bank Transfer, Cash, Cheque, TPA, Legal Settlement, Self-Cure). What was actually
-- there, and where it came from:
--
--     TRANSFER        99  imp:cards-2026-07     -> Bank Transfer
--     loan repayment  89  imp:loans-2026-08     -> Unspecified     (a description, not a channel)
--     REMITA          41  imp:cards-2026-07     -> Remita
--     NDD             25  imp:cards-2026-07     -> Direct Debit
--     ZENITH           6  imp:cards-2026-07     -> Bank Transfer   (a bank, not a method)
--     legal            5  LEXOR-BACKFILL-*      -> Legal Settlement
--     TRANSFER/NDD     3  imp:cards-2026-07     -> Bank Transfer   (two methods in one string)
--     recovery         1  imp:cards-2026-07     -> Unspecified
--
-- 'loan repayment' is 89 rows and NGN 878m — 95% of the value in the table — and it is not a
-- channel at all: those rows came from a loan repayment schedule whose source had no channel
-- column, and their notes read 'Month 1' … 'Month 5'. They become 'Unspecified' because that is
-- what they are. Inventing a bank for NGN 878m to make a chart look complete would be a lie, and
-- a report that says "95% unspecified" is the honest and more useful answer.
--
-- EVERY ORIGINAL IS KEPT in recovery_payments.channel_raw. This is financial data feeding a GL
-- posting chain, so nothing here is destructive and the mapping above can be re-derived or
-- reversed from the table itself.
--
-- PART 2 — recovery_cases.legal_stage and legal_proceedings.proceeding_type
--
-- One vocabulary, because the milestone handler writes the same value to both: recovery, legal,
-- court, judgment. All 95 existing legal_proceedings rows already hold 'legal' or 'court', and
-- every non-null legal_stage is already one of the four, so this constraint describes the data as
-- it stands rather than changing it.
--
-- What it PREVENTS is the thing that had not happened yet: the milestone form offered six Title
-- Case labels ('Pre-Litigation Notice', 'Demand Letter', 'Court Filing', 'Judgment',
-- 'Enforcement', 'Other') and had never once been used — all 95 proceedings came from a single
-- import on 2026-08-24. The first person to use that screen would have put 'Court Filing' into
-- the column three dashboards read to decide what is "in legal", where one test counts it and
-- another does not.
--
-- DELIBERATELY NOT DONE HERE: nothing changes what "in legal" reports. `legal_stage = 'recovery'`
-- is the PRE-legal stage — ordinary chasing, no lawyer — and the Recovery KPI counts it anyway
-- because its test is `legal_stage IS NOT NULL`, which overstates that figure by 251 cases and
-- NGN 592m. That is a reporting decision for whoever owns the number, not a schema one. This
-- migration only stops a fifth value arriving while it is decided.

-- ---------------------------------------------------------------------------
-- PART 1
-- ---------------------------------------------------------------------------

ALTER TABLE recovery_payments ADD COLUMN IF NOT EXISTS channel_raw text;

COMMENT ON COLUMN recovery_payments.channel_raw IS
    'The channel value exactly as it arrived, before migration 321 reconciled channel to the vocabulary in handlers/recovery_vocab.go. Never written by application code.';

UPDATE recovery_payments SET channel_raw = channel WHERE channel_raw IS NULL;

UPDATE recovery_payments
   SET channel = CASE btrim(channel)
                     WHEN 'TRANSFER'       THEN 'Bank Transfer'
                     WHEN 'ZENITH'         THEN 'Bank Transfer'
                     WHEN 'TRANSFER/NDD'   THEN 'Bank Transfer'
                     WHEN 'REMITA'         THEN 'Remita'
                     WHEN 'NDD'            THEN 'Direct Debit'
                     WHEN 'legal'          THEN 'Legal Settlement'
                     WHEN 'loan repayment' THEN 'Unspecified'
                     WHEN 'recovery'       THEN 'Unspecified'
                     ELSE channel
                 END
 WHERE btrim(COALESCE(channel,'')) <> '';

-- Anything blank was never a channel either.
UPDATE recovery_payments SET channel = 'Unspecified'
 WHERE btrim(COALESCE(channel,'')) = '';

ALTER TABLE recovery_payments DROP CONSTRAINT IF EXISTS recovery_payments_channel_chk;
ALTER TABLE recovery_payments ADD CONSTRAINT recovery_payments_channel_chk
    CHECK (channel = ANY (ARRAY[
        'Bank Transfer','Remita','Direct Debit','Cash','Cheque',
        'TPA','Legal Settlement','Self-Cure','Unspecified']));

-- ---------------------------------------------------------------------------
-- PART 2
-- ---------------------------------------------------------------------------

-- Only actual empty strings. Written as `IS NOT NULL AND btrim(...) = ''` rather than the
-- COALESCE form, which matches the 1,089 rows that are already NULL and rewrites every one of
-- them to NULL again for nothing.
UPDATE recovery_cases    SET legal_stage     = NULL WHERE legal_stage     IS NOT NULL AND btrim(legal_stage)     = '';
UPDATE legal_proceedings SET proceeding_type = NULL WHERE proceeding_type IS NOT NULL AND btrim(proceeding_type) = '';

ALTER TABLE recovery_cases DROP CONSTRAINT IF EXISTS recovery_cases_legal_stage_chk;
ALTER TABLE recovery_cases ADD CONSTRAINT recovery_cases_legal_stage_chk
    CHECK (legal_stage IS NULL
           OR legal_stage = ANY (ARRAY['recovery','legal','court','judgment']));

ALTER TABLE legal_proceedings DROP CONSTRAINT IF EXISTS legal_proceedings_type_chk;
ALTER TABLE legal_proceedings ADD CONSTRAINT legal_proceedings_type_chk
    CHECK (proceeding_type IS NULL
           OR proceeding_type = ANY (ARRAY['recovery','legal','court','judgment']));

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------

DO $m321$
DECLARE
    v_rows     int;
    v_total    numeric;
    v_raw_null int;
    v_unspec   int;
    v_bad      int;
BEGIN
    SELECT count(*), COALESCE(sum(amount_kobo),0) INTO v_rows, v_total FROM recovery_payments;

    -- Not one naira may move. This migration renames routes; it does not touch money.
    -- 92,122,328,192 kobo = NGN 921,223,281.92, measured 2026-09-30. This guard earned its keep
    -- immediately: the first draft carried a hand-added total that was NGN 372,000 too high, and
    -- the migration refused to apply rather than trust it.
    IF v_total <> 92122328192 THEN
        RAISE EXCEPTION '321: recovery_payments totals % kobo, expected 92122328192 — a payment changed value', v_total;
    END IF;
    IF v_rows <> 269 THEN
        RAISE EXCEPTION '321: recovery_payments has % rows, expected 269', v_rows;
    END IF;

    -- Every row must remember what it used to say.
    SELECT count(*) INTO v_raw_null FROM recovery_payments WHERE channel_raw IS NULL;
    IF v_raw_null > 0 THEN
        RAISE EXCEPTION '321: % row(s) lost their original channel', v_raw_null;
    END IF;

    -- The rows we could not attribute are exactly the ones we said they were.
    SELECT count(*) INTO v_unspec FROM recovery_payments WHERE channel = 'Unspecified';
    IF v_unspec <> 90 THEN
        RAISE EXCEPTION '321: % rows are Unspecified, expected 90 (89 loan repayment + 1 recovery)', v_unspec;
    END IF;

    -- And the vocabulary the KPI reads is now closed.
    SELECT count(*) INTO v_bad FROM recovery_cases
     WHERE legal_stage IS NOT NULL
       AND legal_stage <> ALL (ARRAY['recovery','legal','court','judgment']);
    IF v_bad > 0 THEN
        RAISE EXCEPTION '321: % case(s) hold a legal_stage outside the vocabulary', v_bad;
    END IF;

    RAISE NOTICE '321: % payments, NGN % reconciled to % channels; legal vocabulary closed at 4 values',
        v_rows, round(v_total/100.0, 2), (SELECT count(DISTINCT channel) FROM recovery_payments);
END
$m321$;

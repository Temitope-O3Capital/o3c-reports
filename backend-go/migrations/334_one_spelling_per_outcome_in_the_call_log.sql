-- 334: One spelling per outcome in the call log.
--
-- A CORRECTION FIRST. The handover (§14.4) and migration 331's own header said
-- app.helpdesk_calls.disposition held "201,000+ rows of the LABEL form" against
-- call_center_contacts.disposition_code's codes, and called it "the same defect at real scale".
-- That framing was wrong and I am recording why, because the wrong version is already written
-- down in two places.
--
--   * The table stores LABELS BY DESIGN, consistently: 40,896 label-form rows against 2 in code
--     form, and label-form rows are still arriving (5,570 in the last 7 days). The column
--     comment on migration 145 says so outright -- disposition_code holds the code,
--     last_disposition holds the label.
--   * ccDispositionCode is the writer-side normaliser for exactly this, and it ALREADY resolves
--     every one of the five screen labels that has no matching Go label ("Unreachable / No
--     Answer", "Not Interested", "Callback Scheduled", "Interested", "Issue Resolved"), with
--     TestSimilarLabelsDoNotCaptureEachOther pinning the substring order.
--   * hdLogCall routes through it before ccDispositionByCode, so the historical silent failure
--     -- a disposition that resolved to nothing, so no close, no DNC, no callback, HTTP 201 --
--     is already fixed.
--
-- So there was no 201,000-row problem. There are FOUR rows, and they are a different, smaller
-- thing: the same outcome stored under two spellings, which splits a GROUP BY on the raw column.
--
--     Resolved        2  ->  Issue Resolved   (9 after)
--     interested      1  ->  Interested     (666 after)
--     wrong_number    1  ->  Wrong Number   (368 after)
--
-- The bare 'Resolved' pair matters slightly more than its count suggests: isRawCallOutcome
-- treats the word "resolved" as a raw telephony outcome, so helpdesk.go blanks it and
-- helpdesk_call_edit.go 422-rejects it. That is exactly why the form says "Issue Resolved".
-- These two rows hold a value today's code would refuse to write.
--
-- Safe to normalise because every reader that keys on these already accepts BOTH spellings:
-- sqlNoContactDispositions, sqlAmbiguousDispositions and dispositionExpectsConversation all list
-- 'wrong number' alongside 'wrong_number', and ccDispositionCode matches "interested" and
-- "resolved" by substring either way. Nothing reads the exact byte sequence being changed.
--
-- Guards assert DELTAS, not totals: calls are being logged continuously (5,570 in the last
-- week), so a hardcoded total would be stale before this ran.

BEGIN;

CREATE TEMP TABLE m334_before ON COMMIT DROP AS
SELECT
    count(*) FILTER (WHERE disposition = 'Issue Resolved') AS issue_resolved,
    count(*) FILTER (WHERE disposition = 'Interested')     AS interested,
    count(*) FILTER (WHERE disposition = 'Wrong Number')   AS wrong_number,
    count(*) FILTER (WHERE disposition = 'Resolved')       AS bare_resolved,
    count(*) FILTER (WHERE disposition = 'interested')     AS lower_interested,
    count(*) FILTER (WHERE disposition = 'wrong_number')   AS snake_wrong_number,
    count(*) FILTER (WHERE COALESCE(btrim(disposition),'') <> '') AS non_blank
  FROM app.helpdesk_calls;

UPDATE app.helpdesk_calls SET disposition = 'Issue Resolved' WHERE disposition = 'Resolved';
UPDATE app.helpdesk_calls SET disposition = 'Interested'     WHERE disposition = 'interested';
UPDATE app.helpdesk_calls SET disposition = 'Wrong Number'   WHERE disposition = 'wrong_number';

DO $g$
DECLARE
    b  m334_before;
    a_issue   int;
    a_int     int;
    a_wrong   int;
    a_left    int;
    a_nonblank int;
BEGIN
    SELECT * INTO b FROM m334_before;

    SELECT count(*) FILTER (WHERE disposition = 'Issue Resolved'),
           count(*) FILTER (WHERE disposition = 'Interested'),
           count(*) FILTER (WHERE disposition = 'Wrong Number'),
           count(*) FILTER (WHERE disposition IN ('Resolved','interested','wrong_number')),
           count(*) FILTER (WHERE COALESCE(btrim(disposition),'') <> '')
      INTO a_issue, a_int, a_wrong, a_left, a_nonblank
      FROM app.helpdesk_calls;

    IF a_left <> 0 THEN
        RAISE EXCEPTION '334: % rows still hold a duplicate spelling', a_left;
    END IF;
    IF a_issue <> b.issue_resolved + b.bare_resolved THEN
        RAISE EXCEPTION '334: Issue Resolved is % , expected %', a_issue, b.issue_resolved + b.bare_resolved;
    END IF;
    IF a_int <> b.interested + b.lower_interested THEN
        RAISE EXCEPTION '334: Interested is % , expected %', a_int, b.interested + b.lower_interested;
    END IF;
    IF a_wrong <> b.wrong_number + b.snake_wrong_number THEN
        RAISE EXCEPTION '334: Wrong Number is % , expected %', a_wrong, b.wrong_number + b.snake_wrong_number;
    END IF;
    -- Re-spelling must never create or destroy a disposition.
    IF a_nonblank <> b.non_blank THEN
        RAISE EXCEPTION '334: non-blank disposition count moved from % to %', b.non_blank, a_nonblank;
    END IF;

    RAISE NOTICE '334: % rows re-spelled; non-blank dispositions unchanged at %',
        b.bare_resolved + b.lower_interested + b.snake_wrong_number, a_nonblank;
END
$g$;

COMMIT;

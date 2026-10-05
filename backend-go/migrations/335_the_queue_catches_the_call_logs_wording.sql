-- 335: The outbound queue's own disposition catalog (ccDispositions, in
-- call_center_dispositions.go) carried 'Callback Requested' / 'No Answer' for codes
-- 'callback' / 'no_answer', while every call-centre and collections screen that logs the
-- SAME outcome against helpdesk_calls has long said 'Callback Scheduled' / 'Unreachable /
-- No Answer' -- the majority spelling by a wide margin (helpdesk_calls carries those two
-- wordings on thousands of rows; call_center_contacts, the only table that ever wrote the
-- old wording, carries ten rows total). ccDispositions' Label is now the call-centre
-- wording too, and a 'Callback Requested'/'Legacy "No Answer"' lookup still resolves via
-- the legacy map in ccDispositionByCode -- this is cosmetic, not a behaviour change.
--
-- @nonblocking: data only, and the two rows below are the entire blast radius. Not the
-- §14.4 problem the handover doc corrected itself on (that was never real, see mig 334) --
-- this is call_center_contacts.last_disposition specifically, a column fed by the Go
-- struct's Label at write time (ccApplyDisposition), so every future write already carries
-- the corrected wording. Only pre-existing rows need this, and there are two.
BEGIN;

CREATE TEMP TABLE m335_before ON COMMIT DROP AS
SELECT count(*) FILTER (WHERE last_disposition = 'Callback Requested') AS callback_old,
       count(*) FILTER (WHERE last_disposition = 'No Answer')          AS no_answer_old
  FROM app.call_center_contacts;

UPDATE app.call_center_contacts SET last_disposition = 'Callback Scheduled'
 WHERE last_disposition = 'Callback Requested';
UPDATE app.call_center_contacts SET last_disposition = 'Unreachable / No Answer'
 WHERE last_disposition = 'No Answer';

DO $g$
DECLARE
    b m335_before;
    left_old   int;
    non_blank_before int;
    non_blank_after  int;
BEGIN
    SELECT * INTO b FROM m335_before;

    SELECT count(*) FILTER (WHERE last_disposition IN ('Callback Requested','No Answer'))
      INTO left_old FROM app.call_center_contacts;

    IF left_old <> 0 THEN
        RAISE EXCEPTION '335: % row(s) still hold the retired wording', left_old;
    END IF;

    RAISE NOTICE '335: re-spelled % Callback Requested and % No Answer row(s)',
        b.callback_old, b.no_answer_old;
END
$g$;

COMMIT;

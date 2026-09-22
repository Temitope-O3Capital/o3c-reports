-- 278: leads whose promised callback was dialled and went unanswered should read
-- "No Answer", not "Callback".
--
-- Companion to 275. That one released the leads whose callback had been dialled and
-- ANSWERED (17 "not interested", 8 "not ready"). This one finishes the job for the
-- larger group behind it: the callback was dialled, nobody picked up, and the lead
-- still read as an outstanding callback because 'no_answer' ranks 1 against
-- 'callback''s 3 and lost syncLeadFromCall's forward-only comparison.
--
-- Measured on 2026-09-22 immediately before running — the 95 leads then on 'callback':
--     latest code 'no_answer'   48 leads  -> 'no_answer'   (this migration)
--     latest code 'callback'    46 leads  -> left alone
--     no disposition at all      1 lead   -> left alone
--
-- Of the 46 left alone: 19 are not yet due, 17 are overdue and have NEVER been retried,
-- 8 were reached and re-logged as a callback without a fresh time, and 2 carry no time.
-- Every one of those is either still pending or genuinely still owed a call, so none of
-- them is this migration's business. Nothing here closes work that has not been done.
--
-- THE PROMISE IS NOT DISCARDED. callback_at is deliberately left exactly as it is:
--   - the outbound queue dials from call_center_contacts.callback_at, never from this
--     status column (see callback_due / callbacks_due in call_center_outbound.go), so
--     every one of these customers is still rung back;
--   - syncLeadFromCall likewise preserves callback_at on a no-answer, so the lead keeps
--     its own record of what was promised.
-- Only the label changes — from "still owed a call" to "we called, nobody answered",
-- which is what actually happened.
WITH latest AS (
  SELECT DISTINCT ON (d.lead_id) d.lead_id, d.outcome
    FROM call_center_dispositions d
   ORDER BY d.lead_id, d.created_at DESC
)
UPDATE call_center_leads l
   SET status     = 'no_answer',
       updated_at = NOW()
  FROM latest
 WHERE l.id = latest.lead_id
   AND l.status = 'callback'
   AND latest.outcome = 'no_answer';

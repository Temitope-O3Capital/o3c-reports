-- 275: release leads frozen on status='callback' after the promised call was made.
--
-- 263 and 265 repaired callback_at. Neither touched `status`, and status is the half
-- the Leads screen actually shows — so a lead whose callback had been dialled, answered
-- and logged still displayed "Callback".
--
-- Cause (fixed in syncLeadFromCall alongside this migration): the forward-only rank
-- guard treated 'callback' (rank 3) as funnel progress. A promised call that was made
-- and answered "Not Interested" maps to 'called' (rank 1), lost the comparison, and the
-- status was left untouched. 'callback' is not an achievement, it is an open promise,
-- and a real conversation resolves it.
--
-- Scope, measured on 2026-09-22 before running:
--     latest code = 'answered_not_interested'  17 leads   -> 'called'
--     latest code = 'not_ready'                 8 leads   -> 'not_ready'
-- and deliberately NOT touched:
--     latest code = 'no_answer'                45 leads   nobody picked up, promise stands
--     latest code = 'callback'                 46 leads   genuinely rescheduled, still due
--
-- Evidence of connection is the DISPOSITION CODE, not duration_sec. 265 could require
-- duration > 0 because it was reasoning about re-logged callbacks; that test is wrong
-- here, because syncLeadFromCall passes durationSec = nil for every queue-logged call
-- ("a queue call has no measured talk time"), so only 3 of those 17 carry a duration at
-- all. An agent choosing "Answered — Not Interested" IS the record that a human spoke;
-- both codes below are Connected in ccDispositions, and neither is 'call_dropped', the
-- one connected code where nothing was really discussed.
WITH latest AS (
  SELECT DISTINCT ON (d.lead_id) d.lead_id, d.outcome
    FROM call_center_dispositions d
   ORDER BY d.lead_id, d.created_at DESC
)
UPDATE call_center_leads l
   SET status = CASE latest.outcome
                  WHEN 'answered_not_interested' THEN 'called'
                  WHEN 'not_ready'               THEN 'not_ready'
                END,
       -- The promise is discharged either way. 'not_ready' keeps its optional
       -- try-again date; a flat "not interested" has nothing left to ring back for.
       callback_at = CASE WHEN latest.outcome = 'not_ready' THEN l.callback_at
                          ELSE NULL END,
       updated_at  = NOW()
  FROM latest
 WHERE l.id = latest.lead_id
   AND l.status = 'callback'
   AND latest.outcome IN ('answered_not_interested', 'not_ready');

-- 263: repair leads whose promised callback was already resolved by a later call, but
-- got frozen in place by syncLeadFromCall's forward-only status guard (fixed in code
-- alongside this migration — see call_center_outbound.go).
--
-- The guard skipped the ENTIRE lead update whenever the new call's status ranked below
-- the lead's current one — and "Not Interested" (status 'called', rank 1) ranks below
-- 'callback' (rank 3), so a promised callback that was actually dialled and answered
-- "Not Interested" never updated last_called_at OR callback_at: the lead kept showing an
-- overdue callback forever, for a call that had already happened and was logged.
--
-- Confirmed live 2026-09-21: 41 leads at status='callback' with an overdue callback_at,
-- each with a call_center_dispositions row logged AFTER that promised time. This clears
-- callback_at on exactly those — only where the later call was a real resolution, not
-- itself a fresh callback/not-ready promise or an unanswered dial (no_answer/call_dropped
-- leave a promise untouched, same as the code fix). status is left as-is: recomputing it
-- correctly needs the original disposition LABEL text, which isn't reliably recoverable
-- from the canonical code alone, and clearing the false "due now" flag is the visible bug.
WITH latest AS (
  SELECT DISTINCT ON (lead_id) lead_id, outcome, created_at
  FROM call_center_dispositions
  ORDER BY lead_id, created_at DESC
)
UPDATE call_center_leads l
   SET callback_at = NULL,
       updated_at  = NOW()
  FROM latest
 WHERE l.id = latest.lead_id
   AND l.status = 'callback'
   AND l.callback_at IS NOT NULL
   AND l.callback_at <= NOW()
   AND latest.created_at > l.callback_at
   AND latest.outcome NOT IN ('callback', 'not_ready', 'no_answer', 'call_dropped');

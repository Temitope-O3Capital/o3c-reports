-- 265: finish repairing leads whose promised callback was already worked — the
-- previous pass (263) deliberately left 35 leads alone because their latest logged
-- call was itself coded 'callback' or 'not_ready', which usually means "still owed
-- a call". But checking the actual call rows behind them shows two different things
-- hiding under those same codes:
--   - 25 got 'no_answer' on the return dial — genuinely never reached, correctly
--     still due. Left alone here too.
--   - 10 (6 'callback', 4 'not_ready') WERE reached — a real, minutes-long
--     conversation happened (see helpdesk_calls) — but the agent re-logged the same
--     disposition without picking a fresh date/time, so the OLD, now-stale time was
--     left untouched by the (now-fixed) CASE in syncLeadFromCall. These are "called"
--     in every sense that matters to a supervisor scanning for overdue callbacks;
--     the stale timestamp is just wrong, not a real outstanding promise.
--
-- This clears callback_at for that second group only: latest disposition is
-- 'callback'/'not_ready' (i.e. excluded by 263) AND the underlying call it came from
-- actually connected (duration_sec > 0 or a recording exists) rather than being a
-- dial that never got picked up.
WITH latest AS (
  SELECT DISTINCT ON (d.lead_id) d.lead_id, d.outcome, d.created_at, d.call_id
  FROM call_center_dispositions d
  ORDER BY d.lead_id, d.created_at DESC
)
UPDATE call_center_leads l
   SET callback_at = NULL,
       updated_at  = NOW()
  FROM latest
  JOIN helpdesk_calls c ON c.id = latest.call_id
 WHERE l.id = latest.lead_id
   AND l.status = 'callback'
   AND l.callback_at IS NOT NULL
   AND l.callback_at <= NOW()
   AND latest.created_at > l.callback_at
   AND latest.outcome IN ('callback', 'not_ready')
   AND (COALESCE(c.duration_sec, 0) > 0 OR c.recording_filename IS NOT NULL);

-- Rollback for 281 — restore the collapsed call records as separate dials.
--
-- READ THIS FIRST: the rollback is PARTIAL BY NATURE.
--
-- 281 does two things. The MERGE (setting merged_into_call_id) is reversible. The FOLD
-- is not: once the survivor has taken the longest duration, a recovered customer name, a
-- recording or a better outcome from its twin, there is nothing in the row that says
-- which of those values it arrived with. Reversing the merge therefore restores the
-- twins as separate dials but leaves the survivor holding the merged content — so the
-- twins' content is double-counted until the values are corrected by hand.
--
-- If that matters, take a copy of app.helpdesk_calls BEFORE running 281:
--     CREATE TABLE scrap.helpdesk_calls_pre281 AS SELECT * FROM app.helpdesk_calls;
--
-- The WHERE clause below is deliberately NOT date-based. Dating it would also un-merge
-- whatever the LIVE de-duper (zohoCollapseDuplicateCall) collapsed on the same day, which
-- is correct work that should stay. Instead it re-derives exactly the groups 281 matched
-- and reverses only those.

BEGIN;

WITH groups_281 AS (
    SELECT app.norm_phone(k.customer_phone) AS ph, k.direction, k.agent_id, k.zoho_agent_id,
           date_trunc('second', k.started_at) AS sec, k.id AS keep_id
      FROM app.helpdesk_calls k
     WHERE k.merged_into_call_id IS NULL
       AND k.voided_at IS NULL
       AND k.source_system = 'zoho_desk'
       AND k.zoho_call_id IS NOT NULL
)
UPDATE app.helpdesk_calls h
   SET merged_into_call_id = NULL,
       updated_at          = NOW()
  FROM groups_281 g
 WHERE h.merged_into_call_id = g.keep_id
   AND app.norm_phone(h.customer_phone) = g.ph
   AND h.direction = g.direction
   AND h.agent_id      IS NOT DISTINCT FROM g.agent_id
   AND h.zoho_agent_id IS NOT DISTINCT FROM g.zoho_agent_id
   AND date_trunc('second', h.started_at) = g.sec;

COMMIT;

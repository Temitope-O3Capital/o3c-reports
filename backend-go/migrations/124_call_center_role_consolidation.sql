-- Consolidate every Contact-Centre role variant into the canonical Call Center roles.
-- The team is now uniformly "Call Center" (calls, call tickets, inbound/outbound,
-- collection calls, and telemarketing) — there is no separate Telemarketing role.
--
-- Context: no telemarketing_agent/telemarketing_head users exist in this database;
-- `call_centre` is a single legacy generic account. Idempotent — safe to re-run.

UPDATE o3c_users SET role = 'call_center_agent'
 WHERE role IN ('call_centre', 'telemarketing_agent');

UPDATE o3c_users SET role = 'call_center_head'
 WHERE role = 'telemarketing_head';

-- Fold the same legacy names out of any extra_roles arrays.
UPDATE o3c_users
   SET extra_roles = (
     SELECT jsonb_agg(DISTINCT CASE
              WHEN v IN ('call_centre','telemarketing_agent') THEN 'call_center_agent'
              WHEN v = 'telemarketing_head'                   THEN 'call_center_head'
              ELSE v END)
     FROM jsonb_array_elements_text(extra_roles) AS v
   )
 WHERE extra_roles IS NOT NULL
   AND extra_roles::text ~ '(call_centre|telemarketing_agent|telemarketing_head)';

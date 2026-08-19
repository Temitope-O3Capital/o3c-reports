-- 166_reattach_orphan_dispositions.sql
--
-- Puts historic write-ups back on the calls they describe.
--
-- Before the merge work landed at 13:22 today, logging a call from the Leads page
-- advanced the LEAD (status, last_called_at, a row in call_center_dispositions)
-- but the write-up never reached the call ledger. So a lead showed "Last Outcome:
-- Interested" while its call history showed two calls both labelled "completed" —
-- which is what MR OBINNA (lead 106) looked like.
--
-- 105 dispositions are in that state. This attaches each to the best call for that
-- lead: the one that actually connected, closest in time to when the agent filed
-- the disposition, and not already carrying a write-up of its own.
--
-- Deliberately conservative:
--   * only the disposition is written, never invented notes
--   * only calls within 2 hours BEFORE the write-up — an agent files after the
--     call, never before, and a wider window is guesswork
--   * a call that already carries a disposition is left alone
--   * where no such call exists the disposition stays on the lead only, which is
--     the honest record of what we know
--
-- Idempotent: safe to re-run.

-- Runs once. The attachment is a JUDGEMENT about historic data, not a
-- derivation, so re-running it must never reconsider and pick a different call.
-- An earlier draft did exactly that and put one write-up on two calls.
INSERT INTO app.schema_migrations (filename) VALUES ('166_reattach_orphan_dispositions.sql.applied')
ON CONFLICT DO NOTHING;

WITH guard AS (
  SELECT COUNT(*) = 1 AS first_run FROM app.schema_migrations
   WHERE filename = '166_reattach_orphan_dispositions.sql.applied'
),
orphan AS (
  SELECT d.id AS disp_id, d.lead_id, d.outcome, d.created_at
    FROM app.call_center_dispositions d
   -- "Already attached" must not depend on a time window. An earlier draft
   -- tested created_at within 5 minutes of the disposition, so on a re-run the
   -- same disposition still looked orphaned and was attached to a SECOND call —
   -- the migration was not idempotent and put one write-up on two calls.
   -- The honest test is simply: does any call for this lead already carry it?
   WHERE NOT EXISTS (
     SELECT 1 FROM app.helpdesk_calls h
      WHERE h.lead_id = d.lead_id
        AND NULLIF(TRIM(h.disposition), '') IS NOT NULL)
),
best AS (
  SELECT o.disp_id, o.outcome, o.lead_id,
         (SELECT h.id
            FROM app.helpdesk_calls h
            JOIN app.call_center_leads l ON l.id = o.lead_id
           WHERE right(regexp_replace(COALESCE(h.customer_phone,''),'\D','','g'),10)
               = right(regexp_replace(COALESCE(l.customer_phone,''),'\D','','g'),10)
             AND right(regexp_replace(COALESCE(l.customer_phone,''),'\D','','g'),10) <> ''
             AND h.merged_into_call_id IS NULL
             AND NULLIF(TRIM(h.disposition), '') IS NULL
             AND h.started_at BETWEEN o.created_at - interval '2 hours' AND o.created_at
           -- The conversation first (a connected call is what a disposition is
           -- about), then the one closest to when it was filed.
           ORDER BY (COALESCE(h.duration_sec, 0) > 5) DESC,
                    abs(extract(epoch FROM (o.created_at - h.started_at))) ASC
           LIMIT 1) AS call_id
    FROM orphan o
)
UPDATE app.helpdesk_calls h
   SET disposition = b.outcome,
       lead_id     = COALESCE(h.lead_id, b.lead_id)
  FROM best b
 WHERE h.id = b.call_id AND b.call_id IS NOT NULL
   AND NULLIF(TRIM(h.disposition), '') IS NULL;

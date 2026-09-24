-- Rollback for 298_qualified_means_they_said_yes
--
-- Scoped to what 298 itself did. Migration 248's rollback deletes EVERY stage_regraded
-- event, which would now take 248's 1,809 rows with it; this one matches on the note 298
-- writes, so the two cleanups stay independent.

-- --- Part two first: take back the backlog hand-offs -----------------------------
-- The forwards 298 created are the only ones whose notes begin 'Backlog:'. A row Sales
-- has already picked up (owner assigned, outcome recorded, or resolved) is left alone:
-- withdrawing work someone has started is worse than an extra row in the queue.
CREATE TEMP TABLE rb298_forwards ON COMMIT DROP AS
  SELECT id, lead_id, contact_id
    FROM app.call_center_lead_forwards
   WHERE notes LIKE 'Backlog:%'
     AND resolved_at IS NULL
     AND sales_owner_id IS NULL
     AND outcome IS NULL;

DELETE FROM app.activities a
 USING rb298_forwards r
 WHERE a.lead_id = r.lead_id AND a.type = 'handoff' AND a.subject = 'Forwarded To Sales';

DELETE FROM app.crm_lead_events e
 USING rb298_forwards r
 WHERE e.contact_id = r.contact_id
   AND e.event = 'forwarded_to_sales'
   AND e.note LIKE 'Backlog hand-off:%';

UPDATE app.call_center_leads l
   SET forwarded_at = b.forwarded_at
  FROM rb298_forwards r
  JOIN scrap.bk298_lead_forward_state b ON b.id = r.lead_id
 WHERE l.id = r.lead_id;

DELETE FROM app.call_center_lead_forwards f USING rb298_forwards r WHERE f.id = r.id;

-- --- Part one: put the re-graded leads back at qualified -------------------------
-- Only where the lead is still in the stage 298 moved it to. A lead Sales has worked
-- since stays where they took it.
UPDATE app.crm_contacts c
   SET lead_stage        = 'qualified',
       stage_changed_at  = e.created_at,
       updated_at        = NOW(),
       disqualified_at   = CASE WHEN e.to_stage = 'disqualified' THEN NULL ELSE c.disqualified_at END,
       disqualify_reason = CASE WHEN e.to_stage = 'disqualified' THEN NULL ELSE c.disqualify_reason END
  FROM app.crm_lead_events e
 WHERE e.contact_id = c.id
   AND e.event = 'stage_regraded'
   AND e.note LIKE 'Re-graded: no call on this lead ever recorded%'
   AND c.lead_stage = e.to_stage;

DELETE FROM app.activities
 WHERE subject = 'Stage Regraded'
   AND body LIKE 'Re-graded: no call on this lead ever recorded%';

DELETE FROM app.crm_lead_events
 WHERE event = 'stage_regraded'
   AND note LIKE 'Re-graded: no call on this lead ever recorded%';

DROP FUNCTION IF EXISTS app.regrade_unqualified_leads();
DROP FUNCTION IF EXISTS app.lead_qualified_by_machine(bigint);

DELETE FROM schema_migrations WHERE filename = '298_qualified_means_they_said_yes.sql';

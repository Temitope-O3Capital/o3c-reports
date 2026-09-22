-- Rollback for 248_regrade_call_qualified_leads
--
-- Returns each re-graded lead to 'qualified', but only if it is still in the stage the
-- re-grade put it in -- a lead Sales has worked since is left where they took it. Then
-- removes the re-grade events and the timeline entries the trigger wrote for them.
UPDATE app.crm_contacts c
   SET lead_stage        = 'qualified',
       stage_changed_at  = e.created_at,
       updated_at        = NOW(),
       disqualified_at   = CASE WHEN e.to_stage = 'disqualified' THEN NULL ELSE c.disqualified_at END,
       disqualify_reason = CASE WHEN e.to_stage = 'disqualified' THEN NULL ELSE c.disqualify_reason END
  FROM app.crm_lead_events e
 WHERE e.contact_id = c.id
   AND e.event = 'stage_regraded'
   AND c.lead_stage = e.to_stage;

DELETE FROM app.activities WHERE source = 'crm_lead' AND subject = 'Stage Regraded';
DELETE FROM app.crm_lead_events WHERE event = 'stage_regraded';

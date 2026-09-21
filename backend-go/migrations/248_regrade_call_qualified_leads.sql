-- 248: Re-grade leads qualified under the old call-centre rule.
--
-- Until 14 Sept 2026 the call-centre sync marked a lead 'qualified' whenever an agent
-- reached the person, so refusals filled the qualified book. On that day, of 1,998
-- qualified leads, 702 had last said Not Interested and 144 Interested. From this release
-- a call qualifies a lead only when the customer says they are interested (shown to
-- people as "Interested"); callbacks, not-ready-yet, unreachable and calls with no
-- outcome stay contacted, and refusals disqualify. See crmStageForCall in
-- handlers/call_center_outbound.go, which this migration ships alongside.
--
-- This applies the same rule to the leads the old rule qualified, by each lead's most
-- recent call. Dry run on 14 Sept 2026: of 1,945 leads the sync had qualified, 1,104 go
-- back to contacted and 702 to disqualified; 192 leads remain interested, including the
-- 53 a person qualified, which are not touched.
--
-- Reversible: every re-graded lead gets a 'stage_regraded' event recording the stage it
-- left, which rollback/rollback_248.sql restores from.

-- Re-grade leads the call-centre sync qualified under the old rule (anyone reached),
-- by the lead's most recent call, using the rule agreed on 14 Sept 2026: only a call
-- where the customer said they are interested qualifies a lead.
--
-- Only leads still at 'qualified' whose latest move there was the call-centre sync are
-- re-graded. A lead a person judged interested, or one Sales has already moved on, is
-- left exactly as it is.

CREATE TEMP TABLE lead_regrade ON COMMIT DROP AS
WITH last_call AS (
  SELECT DISTINCT ON (contact_id)
         contact_id,
         lower(btrim(status)) AS status,
         NULLIF(btrim(last_disposition), '') AS disposition
    FROM app.call_center_leads
   WHERE contact_id IS NOT NULL
   ORDER BY contact_id, last_called_at DESC NULLS LAST, updated_at DESC
),
qualified_by_call AS (
  SELECT c.id
    FROM app.crm_contacts c
   WHERE c.lead_stage = 'qualified'
     AND (SELECT e.note
            FROM app.crm_lead_events e
           WHERE e.contact_id = c.id AND e.to_stage = 'qualified'
           ORDER BY e.created_at DESC
           LIMIT 1) = 'Advanced by a call-centre call'
)
SELECT q.id,
       lc.status,
       lc.disposition,
       CASE
         WHEN lc.status = 'interested' THEN 'qualified'
         WHEN lc.status IN ('dnc', 'closed', 'invalid') THEN 'disqualified'
         WHEN lc.status = 'called' AND lower(coalesce(lc.disposition, '')) LIKE '%not interested%' THEN 'disqualified'
         WHEN lc.status IN ('called', 'callback', 'not_ready', 'no_answer', 'pending') THEN 'contacted'
       END AS target
  FROM qualified_by_call q
  JOIN last_call lc ON lc.contact_id = q.id;

DELETE FROM lead_regrade WHERE target IS NULL OR target = 'qualified';

UPDATE app.crm_contacts c
   SET lead_stage        = r.target,
       stage_changed_at  = NOW(),
       updated_at        = NOW(),
       disqualified_at   = CASE WHEN r.target = 'disqualified' THEN NOW() ELSE c.disqualified_at END,
       disqualify_reason = CASE WHEN r.target = 'disqualified'
                                THEN 'Call centre: ' || coalesce(r.disposition, r.status)
                                ELSE c.disqualify_reason END
  FROM lead_regrade r
 WHERE r.id = c.id;

-- One event per lead, which the crm_lead_events trigger also puts on the lead's activity
-- timeline, so anyone opening the lead sees why it moved.
INSERT INTO app.crm_lead_events (contact_id, event, from_stage, to_stage, note, created_by)
SELECT r.id, 'stage_regraded', 'qualified', r.target,
       'Re-graded: the last call recorded "' || coalesce(r.disposition, r.status)
         || '". Only a call where the customer says they are interested qualifies a lead (rule agreed 14 Sept 2026).',
       NULL
  FROM lead_regrade r;

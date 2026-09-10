-- 229_activities_backfill.sql
--
-- Full historical backfill of the siloed event tables into app.activities, so the new
-- stream is complete retroactively (past handoffs, risk decisions and notes show on the
-- timeline, not just events from today forward).
--
-- Scope is deliberately ONLY the events that have no first-class Customer-360 feed today —
-- handoffs, LOS stage/decisions and CRM/lead notes. Calls, payments, tickets, campaigns,
-- statements, field visits and surveys are NOT copied: the timeline already sources those
-- from their own tables, and copying them here would show every one of them twice.
--
-- Each insert is guarded by `NOT EXISTS (… source = '<tag>')`, so the migration is safe to
-- re-run and never double-inserts a source. bd_activities is intentionally skipped: its
-- lead_id references the legacy bd_leads table, not call_center_leads, so it cannot be
-- anchored to the right person without a bridge that does not exist.

-- 1) Call-centre → Sales hand-offs (the durable tracker; the richest handoff source).
INSERT INTO app.activities
  (lead_id, contact_id, cif, phone, actor_user_id, actor_name, actor_team,
   type, target_team, target_user_id, subject, body, outcome, status, occurred_at, source, metadata)
SELECT f.lead_id, f.contact_id, NULLIF(f.customer_cif,''),
       NULLIF(app.normalise_ng_phone(f.customer_phone),''),
       f.forwarded_by, NULLIF(f.forwarded_by_name,''), 'call_center',
       'handoff', 'sales', f.sales_owner_id,
       'Forwarded to Sales', NULLIF(f.notes,''), NULLIF(f.outcome,''), NULLIF(f.status,''),
       f.forwarded_at, 'backfill:cc_forward',
       CASE WHEN f.product_interest IS NOT NULL OR f.marketing_campaign_id IS NOT NULL
            THEN jsonb_build_object('product_interest', f.product_interest,
                                    'marketing_campaign_id', f.marketing_campaign_id)
            ELSE NULL END
  FROM app.call_center_lead_forwards f
 WHERE NOT EXISTS (SELECT 1 FROM app.activities a WHERE a.source = 'backfill:cc_forward');

-- 2) LOS stage changes + decisions. Anchored by application_id AND the application's CIF
--    (so they surface on Customer 360, which matches by CIF).
INSERT INTO app.activities
  (application_id, cif, actor_user_id, actor_name, type, subject, body, outcome, occurred_at, source)
SELECT e.application_id, NULLIF(la.applicant_cif,''),
       e.actor_user_id, NULLIF(e.actor_label,''),
       CASE WHEN e.event_type = 'declined' THEN 'decision' ELSE 'stage_change' END,
       CASE WHEN e.event_type = 'stage_advance' THEN 'Moved ' || COALESCE(e.from_stage,'?') || ' → ' || COALESCE(e.to_stage,'?')
            WHEN e.event_type = 'declined'      THEN 'Application declined'
            WHEN e.event_type = 'request_info'  THEN 'Returned for more information'
            WHEN e.event_type = 'assign'        THEN 'Assigned'
            ELSE e.event_type END,
       NULLIF(e.notes,''),
       CASE WHEN e.event_type = 'declined' THEN 'declined' ELSE NULLIF(e.to_stage,'') END,
       e.created_at, 'backfill:los'
  FROM app.application_events e
  LEFT JOIN app.loan_applications la ON la.id = e.application_id
 WHERE NOT EXISTS (SELECT 1 FROM app.activities a WHERE a.source = 'backfill:los');

-- 3) CRM activities → notes (mapped to 'note' so any 'call'-typed CRM rows can't duplicate
--    the helpdesk_calls feed).
INSERT INTO app.activities
  (contact_id, actor_user_id, type, direction, subject, body, outcome, occurred_at, source)
SELECT c.contact_id, c.created_by, 'note', NULLIF(c.direction,''),
       NULLIF(c.subject,''), NULLIF(c.body,''), NULLIF(c.outcome,''), c.created_at, 'backfill:crm_activity'
  FROM app.crm_activities c
 WHERE NOT EXISTS (SELECT 1 FROM app.activities a WHERE a.source = 'backfill:crm_activity');

-- 4) CRM lead events, EXCLUDING forwards (those are covered by #1, so no duplicate handoff).
INSERT INTO app.activities
  (contact_id, actor_user_id, actor_team, type, subject, body, occurred_at, source)
SELECT e.contact_id, e.created_by, 'call_center', 'stage_change',
       e.event, NULLIF(e.note,''), e.created_at, 'backfill:crm_lead_event'
  FROM app.crm_lead_events e
 WHERE e.event NOT ILIKE '%forward%'
   AND NOT EXISTS (SELECT 1 FROM app.activities a WHERE a.source = 'backfill:crm_lead_event');

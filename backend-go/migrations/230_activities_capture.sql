-- 230_activities_capture.sql
--
-- Phase 2 of the activity stream: (a) a deep-link tweak, and (b) LIVE capture of the three
-- siloed event logs that only reach Customer 360 THROUGH app.activities.
--
-- Migration 229 backfilled the HISTORY of application_events / crm_lead_events /
-- crm_activities. But those logs are written from many inline call sites (no single Go
-- helper), and nothing emitted NEW rows into the stream — so any LOS stage change, CRM lead
-- move or note created after the backfill would silently drop off the timeline. Rather than
-- edit ~20 call sites (and miss future ones), an AFTER INSERT trigger on each log emits into
-- app.activities. Every current and future writer is captured, in one place, and the
-- mappings mirror the backfill so history and go-forward look identical. Modules with NO
-- event log (fixed deposits, cards ops, credit accommodations, the Eye decision) have no
-- table to trigger on and are emitted from Go via LogActivity().

-- (a) Deep-link tweak: a generic entity pointer (mirrors credit_activity_log) so a timeline
--     row can link back to the exact promise / dispute / FD txn / card request / condition
--     / deal instead of burying the id in metadata.
ALTER TABLE app.activities ADD COLUMN IF NOT EXISTS entity_type TEXT;
ALTER TABLE app.activities ADD COLUMN IF NOT EXISTS entity_id   TEXT;
CREATE INDEX IF NOT EXISTS idx_activities_entity ON app.activities (entity_type, entity_id)
  WHERE entity_type IS NOT NULL;

-- (b1) LOS application_events → stage changes + decisions. Anchored by application_id AND
--      the application's CIF (so it matches on Customer 360 either way).
CREATE OR REPLACE FUNCTION app.activities_from_application_event() RETURNS trigger AS $$
BEGIN
  INSERT INTO app.activities
    (application_id, cif, actor_user_id, actor_name, type, subject, body, outcome, occurred_at, source, entity_type, entity_id)
  VALUES (
    NEW.application_id,
    (SELECT NULLIF(applicant_cif,'') FROM app.loan_applications WHERE id = NEW.application_id),
    NEW.actor_user_id, NULLIF(NEW.actor_label,''),
    CASE WHEN NEW.event_type = 'declined' THEN 'decision' ELSE 'stage_change' END,
    CASE WHEN NEW.event_type = 'stage_advance' THEN 'Moved ' || COALESCE(NEW.from_stage,'?') || ' → ' || COALESCE(NEW.to_stage,'?')
         WHEN NEW.event_type = 'declined'      THEN 'Application declined'
         WHEN NEW.event_type = 'request_info'  THEN 'Returned for more information'
         WHEN NEW.event_type = 'assign'        THEN 'Assigned'
         ELSE initcap(replace(NEW.event_type,'_',' ')) END,
    NULLIF(NEW.notes,''),
    CASE WHEN NEW.event_type = 'declined' THEN 'declined' ELSE NULLIF(NEW.to_stage,'') END,
    NEW.created_at, 'los', 'loan_application', NEW.application_id::text);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_activities_application_event ON app.application_events;
CREATE TRIGGER trg_activities_application_event
  AFTER INSERT ON app.application_events
  FOR EACH ROW EXECUTE FUNCTION app.activities_from_application_event();

-- (b2) CRM lead events → hand-offs (forwards) + stage changes. Resolves the contact's CIF
--      and phone so a hand-off can be matched (and reflected back) by identity, not just id.
CREATE OR REPLACE FUNCTION app.activities_from_crm_lead_event() RETURNS trigger AS $$
DECLARE
  is_forward boolean := NEW.event ILIKE '%forward%';
BEGIN
  INSERT INTO app.activities
    (contact_id, cif, phone, actor_user_id, actor_team, type, target_team, status, subject, body, occurred_at, source, entity_type, entity_id)
  VALUES (
    NEW.contact_id,
    (SELECT COALESCE(NULLIF(converted_cif,''), NULLIF(cif_number,'')) FROM app.crm_contacts WHERE id = NEW.contact_id),
    (SELECT NULLIF(app.normalise_ng_phone(phone),'') FROM app.crm_contacts WHERE id = NEW.contact_id),
    NEW.created_by,
    CASE WHEN is_forward THEN 'call_center' ELSE 'sales' END,
    CASE WHEN is_forward THEN 'handoff' ELSE 'stage_change' END,
    CASE WHEN is_forward OR NEW.event ILIKE '%sales%' THEN 'sales' ELSE NULL END,
    CASE WHEN is_forward THEN 'open' ELSE NULL END,
    initcap(replace(NEW.event,'_',' ')),
    NULLIF(NEW.note,''), NEW.created_at, 'crm_lead', 'crm_contact', NEW.contact_id::text);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_activities_crm_lead_event ON app.crm_lead_events;
CREATE TRIGGER trg_activities_crm_lead_event
  AFTER INSERT ON app.crm_lead_events
  FOR EACH ROW EXECUTE FUNCTION app.activities_from_crm_lead_event();

-- (b3) CRM activities → notes (mapped to 'note' so a 'call'-typed CRM row can't duplicate
--      the helpdesk_calls feed).
CREATE OR REPLACE FUNCTION app.activities_from_crm_activity() RETURNS trigger AS $$
BEGIN
  INSERT INTO app.activities
    (contact_id, actor_user_id, type, direction, subject, body, outcome, occurred_at, source, entity_type, entity_id)
  VALUES (
    NEW.contact_id, NEW.created_by, 'note', NULLIF(NEW.direction,''),
    NULLIF(NEW.subject,''), NULLIF(NEW.body,''), NULLIF(NEW.outcome,''),
    NEW.created_at, 'crm_activity', 'crm_activity', NEW.id::text);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_activities_crm_activity ON app.crm_activities;
CREATE TRIGGER trg_activities_crm_activity
  AFTER INSERT ON app.crm_activities
  FOR EACH ROW EXECUTE FUNCTION app.activities_from_crm_activity();

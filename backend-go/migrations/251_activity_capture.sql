-- 241: capture call dispositions on the unified activity timeline, give the three call
-- stores a shared id, and repair the conversion timestamp on legacy converted leads.
--
-- Investigation 2026-09-14: app.activities (the unified timeline, migrations 228-231) was
-- fed almost only stage changes. 11.6k call dispositions lived only in
-- call_center_dispositions with NO trigger and were surfaced on no timeline, and one
-- connected call was written to three unlinked stores (helpdesk_calls,
-- call_center_dispositions, crm_lead_events) with no common id. Also, the 1,454 leads
-- marked 'converted' are legacy backfill and carry converted_at = NULL.
--
-- This migration (additive + idempotent):
--   1. adds call_center_dispositions.call_id (FK helpdesk_calls) — the shared id the code
--      will start populating, so a disposition can be tied back to its call.
--   2. fans every disposition into app.activities as a type='call' row (trigger + one-time
--      backfill), anchored by lead + agent + party, so calls finally appear on the timeline.
--   3. backfills converted_at on legacy converted leads from the stage-change time.

-- ── 1. Shared call id ───────────────────────────────────────────────────────────────
ALTER TABLE call_center_dispositions ADD COLUMN IF NOT EXISTS call_id bigint;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='call_center_dispositions_call_id_fkey') THEN
    ALTER TABLE call_center_dispositions ADD CONSTRAINT call_center_dispositions_call_id_fkey
      FOREIGN KEY (call_id) REFERENCES helpdesk_calls(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_cc_dispositions_call ON call_center_dispositions (call_id) WHERE call_id IS NOT NULL;

-- ── 2. Disposition -> unified activity ──────────────────────────────────────────────
-- Mirrors the existing activities_from_crm_lead_event pattern. A call carries actor
-- (agent), subject (the outcome, humanised), the shared call_id, and the lead's identity
-- anchors (contact_id / cif / phone); the activity_resolve_party BEFORE-INSERT trigger
-- then resolves party_id from those, exactly as for every other activity.
CREATE OR REPLACE FUNCTION app.activities_from_disposition() RETURNS trigger AS $func$
BEGIN
  INSERT INTO app.activities
    (lead_id, contact_id, cif, phone, call_id, actor_user_id, actor_team, type, direction,
     subject, outcome, occurred_at, source, entity_type, entity_id)
  SELECT NEW.lead_id, l.contact_id,
         NULLIF(btrim(l.customer_cif),''), NULLIF(app.norm_phone(l.customer_phone),''),
         NEW.call_id, NEW.agent_id, 'call_center', 'call', 'outbound',
         initcap(replace(NEW.outcome,'_',' ')), NEW.outcome,
         COALESCE(NEW.created_at, NOW()), 'call_center', 'cc_lead', NEW.lead_id::text
    FROM call_center_leads l WHERE l.id = NEW.lead_id;
  RETURN NULL;
END; $func$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_activities_from_disposition ON call_center_dispositions;
CREATE TRIGGER trg_activities_from_disposition AFTER INSERT ON call_center_dispositions
  FOR EACH ROW EXECUTE FUNCTION app.activities_from_disposition();

-- One-time backfill of existing dispositions (idempotent: skip any already mirrored).
INSERT INTO app.activities
  (lead_id, contact_id, cif, phone, actor_user_id, actor_team, type, direction,
   subject, outcome, occurred_at, source, entity_type, entity_id)
SELECT d.lead_id, l.contact_id,
       NULLIF(btrim(l.customer_cif),''), NULLIF(app.norm_phone(l.customer_phone),''),
       d.agent_id, 'call_center', 'call', 'outbound',
       initcap(replace(d.outcome,'_',' ')), d.outcome, d.created_at, 'call_center',
       'cc_lead', d.lead_id::text
  FROM call_center_dispositions d JOIN call_center_leads l ON l.id = d.lead_id
 WHERE NOT EXISTS (
   SELECT 1 FROM app.activities a
    WHERE a.type='call' AND a.source='call_center'
      AND a.entity_type='cc_lead' AND a.entity_id = d.lead_id::text
      AND a.occurred_at = d.created_at);

-- ── 3. Repair conversion timestamp on legacy converted leads ────────────────────────
UPDATE crm_contacts
   SET converted_at = COALESCE(stage_changed_at, updated_at, created_at)
 WHERE lead_stage = 'converted' AND converted_at IS NULL;

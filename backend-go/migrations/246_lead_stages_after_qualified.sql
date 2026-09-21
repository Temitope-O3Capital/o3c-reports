-- 246: Stages after qualified.
--
-- The lead lifecycle stopped at "qualified". 1,969 leads sat there on 14 Sept 2026 with
-- no follow-up date, no product interest and no qualified date recorded, and none of the
-- five loan applications linked back to a lead, so nobody could say where a qualified
-- lead was actually waiting. These stages give the work after qualification somewhere to
-- be recorded, in the order it happens:
--
--   qualified -> handed_to_sales -> documents_requested -> application_submitted
--             -> approved -> converted            (or disqualified at any point)
--
-- stage_changed_at is when the lead entered its current stage, so "days waiting" is a
-- column read rather than a scan of the event log. Backfilled from the latest event that
-- moved the contact into the stage it is in now, falling back to the stage-specific
-- timestamps and finally to the record's own dates.

ALTER TABLE app.crm_contacts DROP CONSTRAINT IF EXISTS crm_contacts_lead_stage_chk;
ALTER TABLE app.crm_contacts ADD CONSTRAINT crm_contacts_lead_stage_chk CHECK (lead_stage IN (
  'new', 'contacted', 'qualified',
  'handed_to_sales', 'documents_requested', 'application_submitted', 'approved',
  'converted', 'disqualified'
));

ALTER TABLE app.crm_contacts ADD COLUMN IF NOT EXISTS stage_changed_at TIMESTAMPTZ;

UPDATE app.crm_contacts c
   SET stage_changed_at = e.entered_at
  FROM (SELECT ev.contact_id, ev.to_stage, max(ev.created_at) AS entered_at
          FROM app.crm_lead_events ev
         WHERE ev.to_stage IS NOT NULL
         GROUP BY ev.contact_id, ev.to_stage) e
 WHERE e.contact_id = c.id
   AND e.to_stage = c.lead_stage
   AND c.stage_changed_at IS NULL;

UPDATE app.crm_contacts
   SET stage_changed_at = COALESCE(
         CASE lead_stage
           WHEN 'qualified'    THEN qualified_at
           WHEN 'converted'    THEN converted_at
           WHEN 'disqualified' THEN disqualified_at
         END,
         updated_at, created_at)
 WHERE stage_changed_at IS NULL;

-- New leads are inserted in several places (sales, BD, the call centre, Zoho, imports).
-- A default stamps them all as entering their first stage now, instead of relying on
-- every insert remembering to.
ALTER TABLE app.crm_contacts ALTER COLUMN stage_changed_at SET DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_crm_contacts_stage_changed
  ON app.crm_contacts (lead_stage, stage_changed_at);

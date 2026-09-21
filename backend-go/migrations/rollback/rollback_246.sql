-- Rollback for 246_lead_stages_after_qualified
--
-- Leads already moved into a post-qualification stage are returned to 'qualified' first,
-- or restoring the five-stage constraint would be rejected by those rows.
DROP INDEX IF EXISTS app.idx_crm_contacts_stage_changed;

UPDATE app.crm_contacts
   SET lead_stage = 'qualified'
 WHERE lead_stage IN ('handed_to_sales', 'documents_requested', 'application_submitted', 'approved');

ALTER TABLE app.crm_contacts DROP CONSTRAINT IF EXISTS crm_contacts_lead_stage_chk;
ALTER TABLE app.crm_contacts ADD CONSTRAINT crm_contacts_lead_stage_chk
  CHECK (lead_stage IN ('new', 'contacted', 'qualified', 'converted', 'disqualified'));

ALTER TABLE app.crm_contacts DROP COLUMN IF EXISTS stage_changed_at;

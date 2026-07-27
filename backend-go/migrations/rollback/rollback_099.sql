-- Rollback for 099_bd_sales_handoff
ALTER TABLE crm_contacts
  DROP COLUMN IF EXISTS employer_id,
  DROP COLUMN IF EXISTS bd_assignment_id,
  DROP COLUMN IF EXISTS source_type;

DROP TABLE IF EXISTS bd_assignment_staff;
DROP TABLE IF EXISTS bd_assignments;
DROP TABLE IF EXISTS employer_staff;

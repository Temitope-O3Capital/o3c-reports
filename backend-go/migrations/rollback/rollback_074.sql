-- Rollback for 074_dsar_sla_due_at
DROP INDEX IF EXISTS idx_dsar_sla;
ALTER TABLE data_subject_requests DROP COLUMN IF EXISTS sla_due_at;

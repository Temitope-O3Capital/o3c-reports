ALTER TABLE data_subject_requests ADD COLUMN IF NOT EXISTS sla_due_at TIMESTAMPTZ;

-- Back-fill existing pending/in_progress requests to a 30-day SLA from creation.
UPDATE data_subject_requests
SET sla_due_at = created_at + INTERVAL '30 days'
WHERE sla_due_at IS NULL
  AND status IN ('pending', 'in_progress');

CREATE INDEX IF NOT EXISTS idx_dsar_sla ON data_subject_requests(sla_due_at) WHERE status IN ('pending', 'in_progress');

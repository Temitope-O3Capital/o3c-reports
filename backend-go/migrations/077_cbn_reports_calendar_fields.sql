-- Extend cbn_reports to also serve as the regulatory calendar.
-- report_name and due_date are the calendar-facing fields;
-- report_type / period_start / period_end remain for backwards-compatible CBN submissions.
ALTER TABLE cbn_reports ADD COLUMN IF NOT EXISTS report_name     TEXT;
ALTER TABLE cbn_reports ADD COLUMN IF NOT EXISTS regulatory_body TEXT;
ALTER TABLE cbn_reports ADD COLUMN IF NOT EXISTS due_date        DATE;
ALTER TABLE cbn_reports ADD COLUMN IF NOT EXISTS owner_id        BIGINT REFERENCES o3c_users(id) ON DELETE SET NULL;

-- Back-fill report_name from report_type for existing rows so the list view isn't empty.
UPDATE cbn_reports SET report_name = report_type WHERE report_name IS NULL;

CREATE INDEX IF NOT EXISTS idx_cbn_reports_due ON cbn_reports(due_date) WHERE due_date IS NOT NULL;

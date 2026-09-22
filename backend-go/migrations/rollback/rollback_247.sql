-- Rollback for 247_report_builder
--
-- Order matters. Draft runs (no report_key) are removed before report_key is made NOT
-- NULL again; test runs before the trigger check narrows; archived and custom reports
-- before the columns that describe them go. Reports made in the workspace are lost.
DELETE FROM app.management_report_runs WHERE report_key IS NULL;
DELETE FROM app.management_report_runs WHERE run_trigger = 'test';

ALTER TABLE app.management_report_runs DROP CONSTRAINT IF EXISTS management_report_runs_draft_has_config;
ALTER TABLE app.management_report_runs DROP CONSTRAINT IF EXISTS management_report_runs_run_trigger_check;
ALTER TABLE app.management_report_runs ADD CONSTRAINT management_report_runs_run_trigger_check
  CHECK (run_trigger IN ('schedule', 'manual', 'preview'));
ALTER TABLE app.management_report_runs ALTER COLUMN report_key SET NOT NULL;
ALTER TABLE app.management_report_runs DROP COLUMN IF EXISTS config;

DELETE FROM app.management_reports WHERE NOT is_builtin;
UPDATE app.management_reports SET due_rule = 'tue_to_sat' WHERE due_rule IN ('weekdays', 'every_day');
UPDATE app.management_reports SET due_rule = 'monday' WHERE due_rule IN ('tuesday', 'wednesday', 'thursday', 'friday');

DROP INDEX IF EXISTS app.idx_mgmt_reports_live;
ALTER TABLE app.management_reports DROP CONSTRAINT IF EXISTS management_reports_rule_fits_cadence;
ALTER TABLE app.management_reports DROP CONSTRAINT IF EXISTS management_reports_due_rule_check;
ALTER TABLE app.management_reports ADD CONSTRAINT management_reports_due_rule_check
  CHECK (due_rule IN ('tue_to_sat', 'monday', 'first_of_month'));
ALTER TABLE app.management_reports DROP CONSTRAINT IF EXISTS management_reports_audience_check;
ALTER TABLE app.management_reports ADD CONSTRAINT management_reports_audience_check
  CHECK (audience IN ('management', 'sales'));
ALTER TABLE app.management_reports DROP CONSTRAINT IF EXISTS management_reports_sections_array;
ALTER TABLE app.management_reports DROP CONSTRAINT IF EXISTS management_reports_template_check;

ALTER TABLE app.management_reports
  DROP COLUMN IF EXISTS archived_at,
  DROP COLUMN IF EXISTS created_by,
  DROP COLUMN IF EXISTS is_builtin,
  DROP COLUMN IF EXISTS sections,
  DROP COLUMN IF EXISTS template;

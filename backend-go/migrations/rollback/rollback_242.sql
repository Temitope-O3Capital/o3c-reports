-- Rollback for 242_management_reports
--
-- Runs reference reports, so they go first. This discards send history and any
-- recipient changes made in the workspace.
DROP INDEX IF EXISTS app.uq_mgmt_report_runs_daily;
DROP INDEX IF EXISTS app.idx_mgmt_report_runs_key;
DROP TABLE IF EXISTS app.management_report_runs;
DROP TABLE IF EXISTS app.management_reports;

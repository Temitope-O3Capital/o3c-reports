-- 247: Report builder.
--
-- Management reports were six fixed emails. They are now assembled from a catalogue of
-- sections (scripts/management-reports/sections.json), so a report is simply an ordered
-- list of section ids plus a schedule and recipients, and new reports can be made in the
-- workspace without touching the generator.
--
--   template    management | sales | custom. The first two keep their headline subject
--               and plain-text summary; custom reports are titled with their own name.
--   sections    ordered section ids from the catalogue.
--   is_builtin  the six original reports: they can be edited and paused, not deleted.
--   archived_at a deleted report is archived, so its send history stays readable.
--
-- The schedule rules widen from three to nine, and must agree with the cadence: a daily
-- report goes out on working days, a weekly one on a chosen weekday, a monthly one on the
-- 1st. The period a report covers follows its cadence: the previous working day, the last
-- complete week, or the month just closed.
--
-- Runs gain a config: a preview or test of an edited, not-yet-saved report carries its
-- draft, so the editor can show what a change will look like before it is saved. A draft
-- of a brand-new report has no report_key yet, so report_key becomes nullable -- such a
-- run must then carry its config.

ALTER TABLE app.management_reports
  ADD COLUMN IF NOT EXISTS template    TEXT NOT NULL DEFAULT 'custom',
  ADD COLUMN IF NOT EXISTS sections    JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS is_builtin  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS created_by  BIGINT REFERENCES app.o3c_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

ALTER TABLE app.management_reports DROP CONSTRAINT IF EXISTS management_reports_template_check;
ALTER TABLE app.management_reports ADD CONSTRAINT management_reports_template_check
  CHECK (template IN ('management', 'sales', 'custom'));

ALTER TABLE app.management_reports DROP CONSTRAINT IF EXISTS management_reports_sections_array;
ALTER TABLE app.management_reports ADD CONSTRAINT management_reports_sections_array
  CHECK (jsonb_typeof(sections) = 'array');

ALTER TABLE app.management_reports DROP CONSTRAINT IF EXISTS management_reports_audience_check;
ALTER TABLE app.management_reports ADD CONSTRAINT management_reports_audience_check
  CHECK (audience IN ('management', 'sales', 'collections', 'cards', 'risk', 'operations', 'other'));

ALTER TABLE app.management_reports DROP CONSTRAINT IF EXISTS management_reports_due_rule_check;
ALTER TABLE app.management_reports ADD CONSTRAINT management_reports_due_rule_check
  CHECK (due_rule IN ('tue_to_sat', 'weekdays', 'every_day',
                      'monday', 'tuesday', 'wednesday', 'thursday', 'friday',
                      'first_of_month'));

ALTER TABLE app.management_reports DROP CONSTRAINT IF EXISTS management_reports_rule_fits_cadence;
ALTER TABLE app.management_reports ADD CONSTRAINT management_reports_rule_fits_cadence CHECK (
     (cadence = 'daily'   AND due_rule IN ('tue_to_sat', 'weekdays', 'every_day'))
  OR (cadence = 'weekly'  AND due_rule IN ('monday', 'tuesday', 'wednesday', 'thursday', 'friday'))
  OR (cadence = 'monthly' AND due_rule = 'first_of_month'));

CREATE INDEX IF NOT EXISTS idx_mgmt_reports_live
  ON app.management_reports (sort_order) WHERE archived_at IS NULL;

-- The six originals, with the sections the business asked for on 14 Sept 2026: collections
-- expected after the overview, the sales team rep by rep beside the sales totals, qualified
-- leads after the contact centre, and credit cards by officer in the sales reports.
UPDATE app.management_reports SET template = 'management', is_builtin = TRUE, sections =
  '["headline","standouts","overview","collections_expected","sales_summary","sales_people","chart_pitched","contact_centre","qualified_leads","cards","chart_channel_mix","chart_card_spend","position","chart_fd_book","applications","applied_products","registrations"]'::jsonb
 WHERE report_key = 'daily';

UPDATE app.management_reports SET template = 'management', is_builtin = TRUE, sections =
  '["headline","standouts","overview","collections_expected","sales_summary","sales_people","chart_pitched","contact_centre","qualified_leads","cards","chart_channel_mix","chart_card_spend","position","chart_fd_book","applications","applied_products","demographics","registrations"]'::jsonb
 WHERE report_key IN ('weekly', 'monthly');

UPDATE app.management_reports SET template = 'sales', is_builtin = TRUE, sections =
  '["sales_headline","sales_booked","sales_fd_by_officer","sales_loans_by_officer","sales_cards_by_officer","sales_teams","sales_company","sales_outside"]'::jsonb
 WHERE report_key IN ('sales-daily', 'sales-weekly', 'sales-monthly');

-- Runs ------------------------------------------------------------------------------
ALTER TABLE app.management_report_runs ADD COLUMN IF NOT EXISTS config JSONB;
ALTER TABLE app.management_report_runs ALTER COLUMN report_key DROP NOT NULL;

ALTER TABLE app.management_report_runs DROP CONSTRAINT IF EXISTS management_report_runs_run_trigger_check;
ALTER TABLE app.management_report_runs ADD CONSTRAINT management_report_runs_run_trigger_check
  CHECK (run_trigger IN ('schedule', 'manual', 'preview', 'test'));

ALTER TABLE app.management_report_runs DROP CONSTRAINT IF EXISTS management_report_runs_draft_has_config;
ALTER TABLE app.management_report_runs ADD CONSTRAINT management_report_runs_draft_has_config
  CHECK (report_key IS NOT NULL OR config IS NOT NULL);

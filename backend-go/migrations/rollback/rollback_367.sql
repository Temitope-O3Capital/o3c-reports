-- Undo 367. The holiday ROWS are deliberately not deleted: by the time anyone runs
-- this, HR may have corrected an Eid date by hand (source='manual'), and dropping
-- every row would take that correction with it. Delete what this migration added and
-- leave the data.
DROP TRIGGER IF EXISTS trg_public_holidays_rebuild ON app.public_holidays;
DROP TRIGGER IF EXISTS trg_business_hours_rebuild  ON app.business_hours;
DROP FUNCTION IF EXISTS app.public_holidays_rebuild_calendar();
DROP VIEW IF EXISTS app.v_holiday_coverage;

-- To go back to migration 355's four years of fixed holidays as well:
--   DELETE FROM app.public_holidays WHERE source IN ('arithmetic','google_ics','substitution');
--   SELECT app.rebuild_business_calendar();
-- Run that only if you mean it. It restores the bug this migration fixed.

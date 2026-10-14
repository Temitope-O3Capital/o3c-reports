-- Rollback for 374_leave_and_the_days_someone_was_available.sql
--
-- WHAT THIS DESTROYS THAT CANNOT BE RECOVERED. Two things, and they are not equivalent:
--
--   * Leave records — every request, approval trail and entitlement. These exist nowhere
--     else: this migration made the workspace the first and only book of record for
--     leave, so there is no spreadsheet or external system to fall back on. Dropping
--     these tables erases the fact that somebody's leave was approved, by whom, and when.
--
--   * hire_date and manager_user_id on app.o3c_users — typed in by hand, person by
--     person, and reconstructable only by asking people again. The columns are dropped
--     by the ALTER at the foot of this file; everything above it is only schema.
--
-- Back both up first, and keep the backups outside this database:
--
--   CREATE TABLE app.leave_requests_backup_374     AS SELECT * FROM app.leave_requests;
--   CREATE TABLE app.leave_entitlements_backup_374 AS SELECT * FROM app.leave_entitlements;
--   CREATE TABLE app.leave_types_backup_374        AS SELECT * FROM app.leave_types;
--   CREATE TABLE app.o3c_users_employment_374      AS
--          SELECT id, full_name, hire_date, manager_user_id FROM app.o3c_users;
--
-- WHAT THIS DOES NOT UNDO.
--
--   * Nothing about app.business_calendar, app.public_holidays or app.business_hours.
--     374 only reads them; they belong to migrations 355, 357 and 367.
--   * Any KPI reporting that has started dividing by app.available_working_days().
--     Dropping that function makes those callers error rather than return a wrong number,
--     which is the intended failure — but find them first:
--         grep -rn "available_working_days\|leave_days_taken\|on_leave(" backend-go/
--   * The decision that leave exists. Reverting the schema does not revert the policy,
--     and staff who have had leave approved in here will reasonably expect it to stand.

BEGIN;

DROP VIEW IF EXISTS app.v_leave_calendar;
DROP VIEW IF EXISTS app.v_leave_daycount_drift;
DROP VIEW IF EXISTS app.v_leave_entitlement_gaps;
DROP VIEW IF EXISTS app.v_leave_balance;

DROP FUNCTION IF EXISTS app.available_working_days(BIGINT, DATE, DATE);
DROP FUNCTION IF EXISTS app.leave_days_taken(BIGINT, DATE, DATE);
DROP FUNCTION IF EXISTS app.on_leave(BIGINT, DATE);
DROP FUNCTION IF EXISTS app.leave_prorata_days(DATE, INT, NUMERIC);

DROP TRIGGER  IF EXISTS leave_requests_no_overlap    ON app.leave_requests;
DROP TRIGGER  IF EXISTS leave_requests_working_days  ON app.leave_requests;
DROP FUNCTION IF EXISTS app.leave_no_overlap();
DROP FUNCTION IF EXISTS app.leave_set_working_days();

DROP TABLE IF EXISTS app.leave_requests;
DROP TABLE IF EXISTS app.leave_entitlements;
DROP TABLE IF EXISTS app.leave_types;

-- Dropped after the tables: the day-count trigger function referenced it.
DROP FUNCTION IF EXISTS app.leave_working_days(DATE, DATE);

DROP TRIGGER  IF EXISTS o3c_users_manager_cycle_guard ON app.o3c_users;
DROP FUNCTION IF EXISTS app.o3c_users_no_manager_cycle();

ALTER TABLE app.o3c_users DROP CONSTRAINT IF EXISTS o3c_users_manager_not_self;
DROP INDEX IF EXISTS app.o3c_users_manager_idx;

-- THIS IS THE IRREVERSIBLE LINE. Hand-entered employment data.
ALTER TABLE app.o3c_users
  DROP COLUMN IF EXISTS manager_user_id,
  DROP COLUMN IF EXISTS hire_date;

COMMIT;

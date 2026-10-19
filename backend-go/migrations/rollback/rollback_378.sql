-- Rollback for 378_staff_unavailability_is_one_fact_every_queue_can_ask.sql
--
-- WHAT THIS DESTROYS. app.staff_unavailability, and it exists nowhere else. Each row is
-- somebody's statement that a named person was away on named dates, with a reason and
-- who covered — the record that explains why a lead sat unclaimed on a Tuesday. Read it
-- out before dropping it if any of that is still being asked about:
--
--   CREATE TABLE app.staff_unavailability_backup_378 AS
--          SELECT * FROM app.staff_unavailability;
--
-- WHAT THIS DOES NOT UNDO.
--
--   * app.leave_requests and app.on_leave (migration 374) are untouched. Approved leave
--     keeps working as a reason somebody is away; what goes is the ad-hoc half.
--   * The Go side is not reverted by SQL. Anything calling app.is_unavailable() or
--     joining app.v_staff_availability will error once they are gone, so roll the code
--     back first or in the same step. Check before running:
--
--       grep -rn "is_unavailable\|v_staff_availability\|staff_unavailability" backend-go/
--
--   * Nothing is re-assigned. Dropping the table does not hand anybody's work back;
--     whoever was given a cover's queue keeps it.
--
-- ORDER MATTERS. The view and the function reference the table, so they go first.

BEGIN;

DROP VIEW     IF EXISTS app.v_staff_availability;
DROP FUNCTION IF EXISTS app.is_unavailable(BIGINT, DATE);
DROP TABLE    IF EXISTS app.staff_unavailability;

DO $assert$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'app'
                AND c.relname IN ('staff_unavailability','v_staff_availability')) THEN
    RAISE EXCEPTION 'rollback 378: table or view still present';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'app' AND p.proname = 'is_unavailable') THEN
    RAISE EXCEPTION 'rollback 378: app.is_unavailable still present';
  END IF;
  -- 374's half must survive this: it is the older and load-bearing one.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'app' AND p.proname = 'on_leave') THEN
    RAISE EXCEPTION 'rollback 378: app.on_leave was removed - it belongs to migration 374';
  END IF;
  RAISE NOTICE 'rollback 378 OK: ad-hoc unavailability gone, approved leave intact';
END $assert$;

COMMIT;

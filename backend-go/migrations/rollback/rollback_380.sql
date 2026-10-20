-- Rollback for 380_the_org_chart_arrives_and_a_gate_nothing_could_satisfy_opens.sql
--
-- WHAT THIS CANNOT UNDO, AND WHY YOU PROBABLY DO NOT WANT IT TO.
--
-- 380 wrote three kinds of thing. Only two can be taken back.
--
--   gender and escalation_manager_user_id are new columns, so dropping them removes
--   both the column and its contents, and nothing else loses anything.
--
--   manager_user_id was NULL for every account before 380 ran. Clearing it therefore
--   restores the previous state exactly -- and that state was a leave module that
--   nobody could submit a request through, because every submission routes to a line
--   manager and nobody had one. Clearing it re-breaks that, which is almost certainly
--   not what you are trying to do. It is left out of the automatic part below for that
--   reason; run the commented-out statement deliberately if you mean it.
--
--   department was OVERWRITTEN. The previous values are gone and this file cannot
--   invent them: ten spellings collapsed into six, twelve accounts went from NULL to a
--   real department, and seven Call Centre accounts and one Cards account were moved to
--   Operations because HR says that is where those people sit. Restoring the old
--   spellings would mean restoring the defect they caused -- a head in 'Sales & BD'
--   unable to see an officer in 'Sales'. If you genuinely need the old values, they are
--   in whatever backup predates the migration; there is no record of them in the
--   database.
--
-- ROLL THE BINARY BACK FIRST, or in the same step. The Go side reads both new columns:
--
--   grep -rn "escalation_manager_user_id\|gender" backend-go/handlers/
--
-- A build that selects escalation_manager_user_id will error against a schema without
-- it, and the handlers that read it are on the leave approval and availability paths.

DROP INDEX IF EXISTS app.o3c_users_escalation_idx;

ALTER TABLE app.o3c_users
  DROP CONSTRAINT IF EXISTS o3c_users_escalation_not_self,
  DROP CONSTRAINT IF EXISTS o3c_users_gender_vocab;

ALTER TABLE app.o3c_users
  DROP COLUMN IF EXISTS escalation_manager_user_id,
  DROP COLUMN IF EXISTS gender;

-- Deliberately NOT run. Uncomment only if you intend to return the leave module to the
-- state where no request can be submitted at all.
--
--   UPDATE app.o3c_users SET manager_user_id = NULL WHERE manager_user_id IS NOT NULL;

-- What survives, and must: migration 374's hire_date, manager_user_id column, not-self
-- check and cycle-guard trigger are 374's, not 380's.
DO $assert$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'o3c_users_manager_cycle_guard') THEN
    RAISE EXCEPTION 'rollback 380: the cycle guard from 374 is gone; it is not 380 to remove';
  END IF;
  IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'app' AND table_name = 'o3c_users'
         AND column_name = 'manager_user_id'
  ) THEN
    RAISE EXCEPTION 'rollback 380: manager_user_id is gone; the column belongs to 374';
  END IF;
END $assert$;

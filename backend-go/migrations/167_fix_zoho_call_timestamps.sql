-- 167_fix_zoho_call_timestamps.sql
--
-- Shifts every Zoho-sourced call time back one hour.
--
-- Zoho reports call times as LOCAL WALL-CLOCK LABELLED AS UTC. Confirmed against
-- live payloads on 2026-08-18 at 13:40 Lagos (12:40 UTC):
--
--   Desk   startTime  "2026-08-18T13:34:18.000Z"  — a call six minutes earlier
--   Voice  start_time  1787059853000 (13:30:53Z)  — a call ten minutes earlier
--
-- Both claim UTC and neither is: 13:34 UTC is 14:34 in Lagos, which had not
-- happened yet. Stored at face value, every call sat an hour in the future.
--
-- The damage that caused:
--   * write-ups landed on the wrong call — the matcher takes the most recent by
--     started_at, and that became whichever row carried the largest fake time, so
--     a call nobody answered could receive the notes from one that was
--   * recordings never attached — pairing allows ±180s between the Desk call and
--     the Voice leg, and an hour apart they can never meet
--
-- Lagos is UTC+1 all year with no DST, so the correction is a constant hour.
--
-- Scope is deliberately narrow: only rows Zoho produced. Manually logged calls
-- (source_system o3_crm / call_center) were stamped with the server's own clock
-- and are already right — shifting those would introduce the very bug this fixes.
--
-- RUN ONCE. Re-running would shift correct data another hour into the past, so
-- this is guarded rather than merely idempotent.

DO $$
DECLARE
  already boolean;
  moved   bigint;
BEGIN
  SELECT EXISTS (SELECT 1 FROM app.schema_migrations
                  WHERE filename = '167_fix_zoho_call_timestamps.sql.applied')
    INTO already;

  IF already THEN
    RAISE NOTICE 'already applied — skipping (shifting twice would be wrong)';
    RETURN;
  END IF;

  UPDATE app.helpdesk_calls
     SET started_at = started_at - interval '1 hour'
   WHERE source_system = 'zoho_desk';
  GET DIAGNOSTICS moved = ROW_COUNT;

  INSERT INTO app.schema_migrations (filename)
  VALUES ('167_fix_zoho_call_timestamps.sql.applied')
  ON CONFLICT DO NOTHING;

  RAISE NOTICE 'corrected % Zoho call timestamps by -1 hour', moved;
END $$;

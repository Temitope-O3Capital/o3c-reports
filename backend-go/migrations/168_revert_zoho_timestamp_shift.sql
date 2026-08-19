-- 168_revert_zoho_timestamp_shift.sql
--
-- Reverses migration 167, which was based on a false premise.
--
-- 167 shifted every Zoho call back one hour on the reading that Zoho reports
-- local wall-clock labelled as UTC. The evidence was that Desk returned
-- startTime "2026-08-18T13:34:18.000Z" while this server's clock read 12:40 UTC,
-- making the call appear 54 minutes in the future — and 246 of that day's calls
-- looked equally impossible.
--
-- The premise was wrong. THE SERVER CLOCK was running ~55 minutes slow. The
-- backend log shows it jumping backwards (13:54:10 -> 12:58:56) and later forward
-- again by 55 minutes when it was corrected. The giveaway after 167 applied: the
-- newest Zoho call read as 61 minutes old on a system where calls arrive
-- continuously.
--
-- Zoho's timestamps were correct throughout. This puts back the hour that 167
-- removed, for the rows 167 moved AND for any written by the shifted parser while
-- it was live.
--
-- RUN ONCE, for the same reason 167 was: applying it twice would push everything
-- an hour into the future.

DO $$
DECLARE
  already boolean;
  moved   bigint;
BEGIN
  SELECT EXISTS (SELECT 1 FROM app.schema_migrations
                  WHERE filename = '168_revert_zoho_timestamp_shift.sql.applied')
    INTO already;

  IF already THEN
    RAISE NOTICE 'already applied — skipping';
    RETURN;
  END IF;

  -- Only run if 167 actually applied; on a fresh database there is nothing to undo.
  IF NOT EXISTS (SELECT 1 FROM app.schema_migrations
                  WHERE filename = '167_fix_zoho_call_timestamps.sql.applied') THEN
    RAISE NOTICE '167 was never applied — nothing to revert';
    INSERT INTO app.schema_migrations (filename)
    VALUES ('168_revert_zoho_timestamp_shift.sql.applied') ON CONFLICT DO NOTHING;
    RETURN;
  END IF;

  UPDATE app.helpdesk_calls
     SET started_at = started_at + interval '1 hour'
   WHERE source_system = 'zoho_desk';
  GET DIAGNOSTICS moved = ROW_COUNT;

  INSERT INTO app.schema_migrations (filename)
  VALUES ('168_revert_zoho_timestamp_shift.sql.applied') ON CONFLICT DO NOTHING;

  RAISE NOTICE 'restored % Zoho call timestamps (+1 hour)', moved;
END $$;

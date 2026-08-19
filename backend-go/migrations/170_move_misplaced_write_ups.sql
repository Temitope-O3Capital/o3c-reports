-- 170_move_misplaced_write_ups.sql
--
-- Moves today's write-ups onto the call they actually describe.
--
-- While this server's clock ran ~55 minutes slow, the matcher that decides which
-- call an agent is writing up compared against a false present. It picks the most
-- recent call by started_at, and with the clock wrong "most recent" was not the
-- call the agent had just finished — so a write-up could land on a dial that was
-- never answered while the real conversation stayed blank.
--
-- Scope is deliberately small. Of 157 write-ups sitting on a call with no
-- duration and no recording, only 20 have a connected call nearby that carries no
-- write-up of its own. The other 137 are agents correctly logging a genuine no
-- answer, and moving those would invent a conversation that never happened.
--
-- A move requires ALL of:
--   * the write-up sits on a call with no duration and no recording
--   * a connected call (>5s) exists for the same number AND the same agent
--   * within 45 minutes either side
--   * that connected call carries no write-up of its own
--
-- RUN ONCE. This is a judgement about historic data, not a derivation: re-running
-- could reconsider and pick a different call, which is exactly how migration 166
-- briefly put one write-up on two calls.

DO $$
DECLARE
  already boolean;
  moved   bigint;
BEGIN
  SELECT EXISTS (SELECT 1 FROM app.schema_migrations
                  WHERE filename = '170_move_misplaced_write_ups.sql.applied') INTO already;
  IF already THEN
    RAISE NOTICE 'already applied — skipping';
    RETURN;
  END IF;

  WITH wrote AS (
    SELECT id, agent_id, started_at, notes, resolution, disposition, purpose, lead_id,
           right(regexp_replace(COALESCE(customer_phone,''),'\D','','g'),10) AS ph
      FROM app.helpdesk_calls
     WHERE started_at::date = CURRENT_DATE
       AND merged_into_call_id IS NULL
       AND COALESCE(NULLIF(TRIM(notes),''), NULLIF(TRIM(disposition),'')) IS NOT NULL
       AND COALESCE(duration_sec,0) <= 5
       AND recording_filename IS NULL
  ),
  pick AS (
    SELECT w.id AS from_id, w.notes, w.resolution, w.disposition, w.purpose, w.lead_id,
           (SELECT c.id FROM app.helpdesk_calls c
             WHERE right(regexp_replace(COALESCE(c.customer_phone,''),'\D','','g'),10) = w.ph
               AND w.ph <> ''
               AND c.agent_id IS NOT DISTINCT FROM w.agent_id
               AND COALESCE(c.duration_sec,0) > 5
               AND c.merged_into_call_id IS NULL
               AND COALESCE(NULLIF(TRIM(c.notes),''), NULLIF(TRIM(c.disposition),'')) IS NULL
               AND c.started_at BETWEEN w.started_at - interval '45 min'
                                    AND w.started_at + interval '45 min'
             -- The longest conversation in the window is the one worth writing up.
             ORDER BY c.duration_sec DESC LIMIT 1) AS to_id
      FROM wrote w
  )
  UPDATE app.helpdesk_calls t
     SET notes       = COALESCE(t.notes, p.notes),
         resolution  = COALESCE(t.resolution, p.resolution),
         disposition = COALESCE(NULLIF(t.disposition,''), p.disposition),
         purpose     = COALESCE(NULLIF(t.purpose,''), p.purpose),
         lead_id     = COALESCE(t.lead_id, p.lead_id)
    FROM pick p
   WHERE t.id = p.to_id AND p.to_id IS NOT NULL;
  GET DIAGNOSTICS moved = ROW_COUNT;

  -- The row the write-up came from becomes what it always was: a dial that did
  -- not connect. Marked merged rather than deleted, so the move is reversible.
  WITH wrote AS (
    SELECT id, agent_id, started_at,
           right(regexp_replace(COALESCE(customer_phone,''),'\D','','g'),10) AS ph
      FROM app.helpdesk_calls
     WHERE started_at::date = CURRENT_DATE
       AND merged_into_call_id IS NULL
       AND COALESCE(NULLIF(TRIM(notes),''), NULLIF(TRIM(disposition),'')) IS NOT NULL
       AND COALESCE(duration_sec,0) <= 5
       AND recording_filename IS NULL
  )
  UPDATE app.helpdesk_calls f
     SET merged_into_call_id = (
           SELECT c.id FROM app.helpdesk_calls c, wrote w
            WHERE w.id = f.id
              AND right(regexp_replace(COALESCE(c.customer_phone,''),'\D','','g'),10) = w.ph
              AND c.agent_id IS NOT DISTINCT FROM w.agent_id
              AND COALESCE(c.duration_sec,0) > 5
              AND c.merged_into_call_id IS NULL
              AND c.started_at BETWEEN w.started_at - interval '45 min'
                                   AND w.started_at + interval '45 min'
            ORDER BY c.duration_sec DESC LIMIT 1)
   WHERE f.id IN (SELECT id FROM wrote)
     AND EXISTS (SELECT 1 FROM app.helpdesk_calls c, wrote w
                  WHERE w.id = f.id
                    AND right(regexp_replace(COALESCE(c.customer_phone,''),'\D','','g'),10) = w.ph
                    AND c.agent_id IS NOT DISTINCT FROM w.agent_id
                    AND COALESCE(c.duration_sec,0) > 5
                    AND c.merged_into_call_id IS NULL
                    AND c.started_at BETWEEN w.started_at - interval '45 min'
                                         AND w.started_at + interval '45 min');

  INSERT INTO app.schema_migrations (filename)
  VALUES ('170_move_misplaced_write_ups.sql.applied') ON CONFLICT DO NOTHING;

  RAISE NOTICE 'moved % write-ups onto the call they describe', moved;
END $$;

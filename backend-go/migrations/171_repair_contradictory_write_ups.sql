-- 171_repair_contradictory_write_ups.sql
--
-- Repairs write-ups that contradict the call they sit on, and undoes the part of
-- migration 170 that created some of them.
--
-- Migration 170 moved any write-up off a call with no duration and no recording
-- onto a connected sibling. That was too crude: "Unreachable / No Answer" BELONGS
-- on a dial nobody answered. Moving it onto a two-minute conversation produced a
-- recorded call whose stated outcome is that it was never answered. 8 rows.
--
-- Two repairs, both narrow, both requiring an unambiguous counterpart:
--
--   A. Reverse a bad merge — the source row still exists, so the write-up goes
--      back where the agent put it and the target is cleared.
--   B. Move a write-up to an un-written-up sibling of the right kind, same agent,
--      same number, within 45 minutes.
--
-- What this deliberately does NOT do: repair the ~40 contradictory rows with no
-- counterpart. There is nothing to move them to, and rewriting the disposition to
-- match the call would be inventing an outcome no agent chose. They stay as they
-- are, visibly odd, rather than being quietly made plausible.
--
-- RUN ONCE — a judgement about historic data, per the lesson from 166 and 170.

DO $$
DECLARE
  already boolean;
  reversed bigint;
  moved    bigint;
BEGIN
  SELECT EXISTS (SELECT 1 FROM app.schema_migrations
                  WHERE filename = '171_repair_contradictory_write_ups.sql.applied') INTO already;
  IF already THEN
    RAISE NOTICE 'already applied - skipping';
    RETURN;
  END IF;

  -- ── A. Reverse the bad merges from 170 ────────────────────────────────────
  CREATE TEMP TABLE bad_merge ON COMMIT DROP AS
  SELECT t.id AS target_id, f.id AS source_id,
         t.notes, t.resolution, t.disposition, t.purpose, t.lead_id
    FROM app.helpdesk_calls t
    JOIN app.helpdesk_calls f ON f.merged_into_call_id = t.id
   WHERE lower(TRIM(t.disposition)) IN
         ('unreachable / no answer','no answer','no_answer','voicemail','unreachable')
     AND (COALESCE(t.duration_sec,0) > 5 OR t.recording_filename IS NOT NULL)
     AND COALESCE(f.duration_sec,0) <= 5
     AND f.recording_filename IS NULL
     AND f.source_system = 'zoho_desk';

  -- Put the write-up back on the dial it describes.
  UPDATE app.helpdesk_calls f
     SET notes       = COALESCE(NULLIF(TRIM(f.notes),''), b.notes),
         resolution  = COALESCE(NULLIF(TRIM(f.resolution),''), b.resolution),
         disposition = COALESCE(NULLIF(TRIM(f.disposition),''), b.disposition),
         purpose     = COALESCE(NULLIF(TRIM(f.purpose),''), b.purpose),
         lead_id     = COALESCE(f.lead_id, b.lead_id),
         merged_into_call_id = NULL
    FROM bad_merge b
   WHERE f.id = b.source_id;
  GET DIAGNOSTICS reversed = ROW_COUNT;

  -- And clear it from the conversation it never described.
  UPDATE app.helpdesk_calls t
     SET notes = NULL, resolution = NULL, disposition = NULL
    FROM bad_merge b
   WHERE t.id = b.target_id;

  -- ── B. Move write-ups that have an unambiguous correct sibling ────────────
  CREATE TEMP TABLE relocate ON COMMIT DROP AS
  WITH c AS (
    SELECT id, agent_id, started_at, disposition, notes, resolution, purpose, lead_id,
           (COALESCE(duration_sec,0) > 5 OR recording_filename IS NOT NULL) AS connected,
           right(regexp_replace(COALESCE(customer_phone,''),'\D','','g'),10) AS ph
      FROM app.helpdesk_calls
     WHERE merged_into_call_id IS NULL
       AND started_at >= CURRENT_DATE - 9
       AND NULLIF(TRIM(disposition),'') IS NOT NULL
       AND lower(TRIM(disposition)) NOT IN ('wrong number','wrong_number','pending / follow-up')
  ),
  mis AS (
    SELECT * FROM c
     WHERE ph <> ''
       AND connected <> (lower(TRIM(disposition)) NOT IN
             ('unreachable / no answer','no answer','no_answer','voicemail','unreachable'))
  )
  SELECT m.id AS from_id, m.notes, m.resolution, m.disposition, m.purpose, m.lead_id,
         (SELECT s.id FROM c s
           WHERE s.ph = m.ph AND s.id <> m.id
             AND s.agent_id IS NOT DISTINCT FROM m.agent_id
             AND s.connected <> m.connected
             AND NULLIF(TRIM(s.disposition),'') IS NULL
             AND COALESCE(NULLIF(TRIM(s.notes),''),'') = ''
             AND s.started_at BETWEEN m.started_at - interval '45 min'
                                  AND m.started_at + interval '45 min'
           ORDER BY abs(EXTRACT(epoch FROM s.started_at - m.started_at)) LIMIT 1) AS to_id
    FROM mis m;

  DELETE FROM relocate WHERE to_id IS NULL;

  UPDATE app.helpdesk_calls t
     SET notes       = COALESCE(t.notes, r.notes),
         resolution  = COALESCE(t.resolution, r.resolution),
         disposition = COALESCE(NULLIF(TRIM(t.disposition),''), r.disposition),
         purpose     = COALESCE(NULLIF(TRIM(t.purpose),''), r.purpose),
         lead_id     = COALESCE(t.lead_id, r.lead_id)
    FROM relocate r WHERE t.id = r.to_id;
  GET DIAGNOSTICS moved = ROW_COUNT;

  UPDATE app.helpdesk_calls f
     SET notes = NULL, resolution = NULL, disposition = NULL
    FROM relocate r WHERE f.id = r.from_id;

  INSERT INTO app.schema_migrations (filename)
  VALUES ('171_repair_contradictory_write_ups.sql.applied') ON CONFLICT DO NOTHING;

  RAISE NOTICE 'reversed % bad merges, relocated % write-ups', reversed, moved;
END $$;

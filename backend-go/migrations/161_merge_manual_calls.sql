-- 161_merge_manual_calls.sql
--
-- Joins an agent's hand-written call notes to the call they are actually about.
--
-- What happens today, taken from a real sequence (agent Elizabeth Nwamiro,
-- customer MR TAIWO, 2026-08-18):
--
--   10:07 → 10:12   six redials, all missed
--   10:26:13        answered — 312 seconds, recorded
--   10:31:45        a 1-second blip
--   10:47:10        the agent logs her notes as a NINTH record, no duration,
--                   no recording, started_at set to the moment she typed it
--
-- So the conversation and the record of the conversation are two different rows.
-- The recording sits on a row with no notes; the notes sit on a row with no
-- duration, no recording and a start time twenty-one minutes after the call
-- ended. Neither row is the truth on its own.
--
-- This links them. The Voice row is authoritative for what happened (when, how
-- long, the audio); the manual row is authoritative for what was said and
-- agreed. The notes move onto the Voice row and the manual row is marked as
-- merged rather than deleted, so nothing is lost and the merge is reversible.
--
-- MATCHING IS DELIBERATELY CONSERVATIVE. It requires the same agent, the same
-- number, a call that actually connected (>5s) within 3 hours before the log,
-- and it picks the BEST candidate — recorded first, then longest — not the most
-- recent. Picking the most recent would have chosen the 1-second blip at 10:31
-- and confidently stamped "1 second" on a five-minute conversation, which is
-- worse than leaving it blank.
--
-- Idempotent: safe to re-run.

ALTER TABLE app.helpdesk_calls
  ADD COLUMN IF NOT EXISTS merged_into_call_id bigint;

COMMENT ON COLUMN app.helpdesk_calls.merged_into_call_id IS
  'Set on a manually logged call whose notes have been moved onto the real Voice '
  'call. Such rows are hidden from the call list but kept for audit.';

CREATE INDEX IF NOT EXISTS idx_helpdesk_calls_merged
  ON app.helpdesk_calls (merged_into_call_id) WHERE merged_into_call_id IS NOT NULL;

WITH candidate AS (
  SELECT m.id AS manual_id, v.id AS voice_id,
         m.notes, m.resolution, m.disposition, m.purpose, m.customer_name,
         m.customer_cif, m.ticket_id, m.ticket_ref, m.ticket_type
  FROM app.helpdesk_calls m
  JOIN LATERAL (
    SELECT c.id
    FROM app.helpdesk_calls c
    WHERE c.source_system = 'zoho_desk'
      AND c.merged_into_call_id IS NULL
      AND c.agent_id IS NOT DISTINCT FROM m.agent_id
      AND right(regexp_replace(coalesce(c.customer_phone,''),'\D','','g'),10)
        = right(regexp_replace(coalesce(m.customer_phone,''),'\D','','g'),10)
      AND right(regexp_replace(coalesce(m.customer_phone,''),'\D','','g'),10) <> ''
      AND c.started_at BETWEEN m.started_at - INTERVAL '3 hours' AND m.started_at
      AND COALESCE(c.duration_sec, 0) > 5
    -- Recorded first, then longest: the answered conversation, not the last dial.
    ORDER BY (c.recording_filename IS NOT NULL) DESC, c.duration_sec DESC
    LIMIT 1
  ) v ON TRUE
  WHERE m.source_system IN ('o3_crm', 'call_center')
    AND m.merged_into_call_id IS NULL
    AND (m.notes IS NOT NULL OR m.resolution IS NOT NULL OR m.disposition IS NOT NULL)
)
-- Move the agent's account of the call onto the real call, without overwriting
-- anything the Voice row already carries.
UPDATE app.helpdesk_calls v
   SET notes         = COALESCE(v.notes, c.notes),
       resolution    = COALESCE(v.resolution, c.resolution),
       disposition   = COALESCE(v.disposition, c.disposition),
       purpose       = COALESCE(NULLIF(v.purpose,''), c.purpose),
       customer_name = COALESCE(NULLIF(v.customer_name,''), c.customer_name),
       customer_cif  = COALESCE(NULLIF(v.customer_cif,''), c.customer_cif),
       ticket_id     = COALESCE(v.ticket_id, c.ticket_id),
       ticket_ref    = COALESCE(v.ticket_ref, c.ticket_ref),
       ticket_type   = COALESCE(v.ticket_type, c.ticket_type)
  FROM candidate c
 WHERE v.id = c.voice_id;

WITH candidate AS (
  SELECT m.id AS manual_id, v.id AS voice_id
  FROM app.helpdesk_calls m
  JOIN LATERAL (
    SELECT c.id
    FROM app.helpdesk_calls c
    WHERE c.source_system = 'zoho_desk'
      AND c.merged_into_call_id IS NULL
      AND c.agent_id IS NOT DISTINCT FROM m.agent_id
      AND right(regexp_replace(coalesce(c.customer_phone,''),'\D','','g'),10)
        = right(regexp_replace(coalesce(m.customer_phone,''),'\D','','g'),10)
      AND right(regexp_replace(coalesce(m.customer_phone,''),'\D','','g'),10) <> ''
      AND c.started_at BETWEEN m.started_at - INTERVAL '3 hours' AND m.started_at
      AND COALESCE(c.duration_sec, 0) > 5
    ORDER BY (c.recording_filename IS NOT NULL) DESC, c.duration_sec DESC
    LIMIT 1
  ) v ON TRUE
  WHERE m.source_system IN ('o3_crm', 'call_center')
    AND m.merged_into_call_id IS NULL
    AND (m.notes IS NOT NULL OR m.resolution IS NOT NULL OR m.disposition IS NOT NULL)
)
UPDATE app.helpdesk_calls m
   SET merged_into_call_id = c.voice_id
  FROM candidate c
 WHERE m.id = c.manual_id;

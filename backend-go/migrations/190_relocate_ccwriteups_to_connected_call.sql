-- 190: Fold outbound-queue disposition write-ups onto the real recorded call.
--
-- ccLogCall records a queue disposition as a STANDALONE 0-duration helpdesk_calls row
-- (the disposition label + the agent's note). When Zoho Voice also recorded that same
-- conversation, the workspace ends up with two rows for one call: the recorded leg
-- (real duration, no note) and this 0-second disposition leg (the note, no recording).
-- To a supervisor the 0-second leg reads as "a conversation happened on a 1-second call".
--
-- This folds each such disposition leg INTO the connected (recorded) leg of the same
-- dialling episode — same number + agent, within 15 min — moving the note/disposition/
-- purpose onto the real call and merging the 0-second row away (merged_into_call_id), so
-- the conversation lives on the call that actually happened and the phantom row vanishes.
--
-- Conservative + safe: only fires for a CONVERSATION-type disposition (never a
-- no-answer/dropped/ambiguous one, which legitimately belongs on the unconnected leg) and
-- only when the connected sibling is itself un-written-up (so nothing is overwritten).
-- At migration time this matches ~6 rows. Idempotent: re-running matches nothing (the
-- source rows are now merged).

WITH moves AS (
    SELECT hc.id AS drop_id, tgt.id AS target_id,
           hc.notes, hc.resolution, hc.disposition, hc.purpose
      FROM helpdesk_calls hc
      CROSS JOIN LATERAL (
          SELECT s.id
            FROM helpdesk_calls s
           WHERE right(regexp_replace(coalesce(s.customer_phone,''),'\D','','g'),10)
                 = right(regexp_replace(coalesce(hc.customer_phone,''),'\D','','g'),10)
             AND COALESCE(hc.customer_phone,'') <> ''
             AND s.agent_id IS NOT DISTINCT FROM hc.agent_id
             AND s.id <> hc.id
             AND s.merged_into_call_id IS NULL AND s.voided_at IS NULL
             AND (COALESCE(s.duration_sec,0) > 5 OR s.recording_filename IS NOT NULL)
             AND COALESCE(TRIM(s.notes),'') = '' AND COALESCE(TRIM(s.disposition),'') = ''
             AND s.started_at BETWEEN hc.started_at - INTERVAL '15 min'
                                  AND hc.started_at + INTERVAL '15 min'
           ORDER BY s.started_at DESC
           LIMIT 1
      ) tgt
     WHERE COALESCE(hc.duration_sec,0) <= 1
       AND hc.recording_filename IS NULL
       AND COALESCE(TRIM(hc.notes),'') <> ''
       AND COALESCE(TRIM(hc.disposition),'') <> ''
       AND lower(TRIM(hc.disposition)) NOT IN
           ('unreachable / no answer','no answer','no_answer','voicemail','unreachable',
            'wrong number','wrong_number','pending / follow-up','call dropped','call_dropped','do not call')
       AND hc.merged_into_call_id IS NULL AND hc.voided_at IS NULL
),
moved AS (
    UPDATE helpdesk_calls t
       SET notes       = m.notes,
           resolution  = m.resolution,
           disposition = m.disposition,
           purpose     = COALESCE(NULLIF(m.purpose,''), t.purpose)
      FROM moves m
     WHERE t.id = m.target_id
    RETURNING m.drop_id
)
UPDATE helpdesk_calls d
   SET merged_into_call_id = m.target_id
  FROM moves m
 WHERE d.id = m.drop_id;

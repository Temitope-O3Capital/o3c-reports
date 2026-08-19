-- 159_call_duration_semantics.sql
--
-- Makes helpdesk_calls.duration_sec mean exactly one thing: TALK TIME.
--
-- The Zoho importer derives duration as completedTime − startTime on the call
-- RECORD. For an answered call that approximates talk time. For a MISSED call it
-- is how long the record stayed open — typically a second or two — and it was
-- being stored in the same column every talk-time figure reads.
--
-- Measured before this migration:
--   missed     85,397 calls · 42,378 with NULL duration · average 1 second
--   completed  24,815 calls ·  6,568 with NULL duration · average 58 seconds
--
-- So the Call Log showed 43,019 missed calls as though each had one second of
-- conversation. The aggregate KPIs already excluded missed calls from talk-time
-- averages, but the call table, the per-call duration bar and the agent-facing
-- figures did not — which is why the durations "look wrong".
--
-- A missed call has no talk time. NULL is the honest value: it means "no
-- conversation happened", which is different from 0 ("connected, said nothing").
-- Ring time is not being discarded, because completedTime − startTime on an
-- unanswered record was never a measurement of ring time in the first place.
--
-- Idempotent: safe to re-run.

UPDATE app.helpdesk_calls
   SET duration_sec = NULL
 WHERE duration_sec IS NOT NULL
   AND LOWER(COALESCE(outcome, '')) IN ('missed', 'no_answer', 'voicemail', 'abandoned');

-- A negative or absurd duration is a bad record, not a long call. The importer
-- caps at 4h going forward; this cleans anything already stored.
UPDATE app.helpdesk_calls
   SET duration_sec = NULL
 WHERE duration_sec IS NOT NULL
   AND (duration_sec < 0 OR duration_sec > 14400);

-- Enforce it from here on, so no future import or hand-written insert can put a
-- nonsensical talk time back into the column.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'app.helpdesk_calls'::regclass
      AND conname  = 'helpdesk_calls_duration_sane_chk'
  ) THEN
    ALTER TABLE app.helpdesk_calls
      ADD CONSTRAINT helpdesk_calls_duration_sane_chk
      CHECK (duration_sec IS NULL OR (duration_sec >= 0 AND duration_sec <= 14400));
  END IF;
END $$;

-- The Call Log is ordered by start time and filtered by agent; the change-feed
-- topic added in this release polls MAX(started_at) every 4 seconds.
CREATE INDEX IF NOT EXISTS idx_helpdesk_calls_started_at
  ON app.helpdesk_calls (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_helpdesk_calls_agent_started
  ON app.helpdesk_calls (agent_id, started_at DESC);

-- ── Lead linkage ─────────────────────────────────────────────────────────────
--
-- The Leads page logged calls through its own reduced form, which wrote a
-- disposition row and mirrored a thin record into helpdesk_calls with no CIF, no
-- disposition, no ticket and a hardcoded purpose. Both pages now use the same
-- modal and the same endpoint, so the call ledger needs to know which lead a call
-- belongs to in order to update it.
ALTER TABLE app.helpdesk_calls
  ADD COLUMN IF NOT EXISTS lead_id bigint;

CREATE INDEX IF NOT EXISTS idx_helpdesk_calls_lead
  ON app.helpdesk_calls (lead_id) WHERE lead_id IS NOT NULL;

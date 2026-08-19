-- 172_call_dropped_and_log_audit.sql
--
-- 1. Reclassifies the write-ups that "Call Dropped" now explains.
-- 2. Flags the ones it does not, for a supervisor to decide.
-- 3. Adds the audit trail behind editing and voiding a call log.
--
-- Agents had no way to say "they picked up and dropped after a few seconds", so
-- they used "Unreachable / No Answer". That reads as a call nobody answered, and
-- it hides a number that is reachable but keeps cutting off. Six such write-ups
-- sit on calls that connected for 1-20 seconds; those become "Call Dropped".
--
-- Eleven more sit on calls averaging 108 seconds. A near-two-minute conversation
-- is not a dropped call and not an unanswered one, and there is no sibling call to
-- move the write-up to. Rather than invent an outcome, they are flagged for review
-- and surfaced to supervisors, who can correct them with the edit trail below.
--
-- Steps 1 and 2 are RUN ONCE (a judgement about historic data). Step 3 is plain
-- schema and is idempotent.

-- ── 3. Audit trail (idempotent) ───────────────────────────────────────────────

ALTER TABLE app.helpdesk_calls ADD COLUMN IF NOT EXISTS voided_at    timestamptz;
ALTER TABLE app.helpdesk_calls ADD COLUMN IF NOT EXISTS voided_by    bigint;
ALTER TABLE app.helpdesk_calls ADD COLUMN IF NOT EXISTS void_reason  text;
-- Set when the workspace cannot tell what a write-up describes and wants a human
-- to look. Not an error state: the call and its write-up stay exactly as they are.
ALTER TABLE app.helpdesk_calls ADD COLUMN IF NOT EXISTS needs_review     boolean NOT NULL DEFAULT false;
ALTER TABLE app.helpdesk_calls ADD COLUMN IF NOT EXISTS review_reason    text;
ALTER TABLE app.helpdesk_calls ADD COLUMN IF NOT EXISTS reviewed_at      timestamptz;
ALTER TABLE app.helpdesk_calls ADD COLUMN IF NOT EXISTS reviewed_by      bigint;

CREATE TABLE IF NOT EXISTS app.helpdesk_call_edits (
  id          bigserial PRIMARY KEY,
  call_id     bigint      NOT NULL REFERENCES app.helpdesk_calls(id) ON DELETE CASCADE,
  action      text        NOT NULL CHECK (action IN ('edit','void','restore','review_cleared')),
  edited_by   bigint,
  edited_name text        NOT NULL DEFAULT '',
  -- Only the fields that changed, old and new. Keeping both means a supervisor
  -- can see what an agent corrected without having to trust the correction.
  changes     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  reason      text        NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS helpdesk_call_edits_call_idx    ON app.helpdesk_call_edits (call_id, created_at DESC);
CREATE INDEX IF NOT EXISTS helpdesk_call_edits_recent_idx  ON app.helpdesk_call_edits (created_at DESC);
CREATE INDEX IF NOT EXISTS helpdesk_calls_needs_review_idx ON app.helpdesk_calls (needs_review) WHERE needs_review;
CREATE INDEX IF NOT EXISTS helpdesk_calls_voided_idx       ON app.helpdesk_calls (voided_at) WHERE voided_at IS NOT NULL;

-- ── 1 & 2. Historic reclassification (run once) ───────────────────────────────

DO $$
DECLARE
  already   boolean;
  dropped   bigint;
  flagged   bigint;
BEGIN
  SELECT EXISTS (SELECT 1 FROM app.schema_migrations
                  WHERE filename = '172_call_dropped_and_log_audit.sql.applied') INTO already;
  IF already THEN
    RAISE NOTICE 'historic reclassification already applied - skipping';
    RETURN;
  END IF;

  -- A "no answer" write-up on a call that connected for a few seconds is the
  -- outcome agents had no word for.
  WITH fixed AS (
    UPDATE app.helpdesk_calls
       SET disposition = 'Call Dropped'
     WHERE merged_into_call_id IS NULL
       AND lower(TRIM(disposition)) IN
           ('unreachable / no answer','no answer','no_answer','voicemail','unreachable')
       AND (COALESCE(duration_sec,0) > 5 OR recording_filename IS NOT NULL)
       AND COALESCE(duration_sec,0) BETWEEN 1 AND 20
     RETURNING id
  )
  SELECT COUNT(*) INTO dropped FROM fixed;

  -- Everything still contradicting itself goes to a human, with the reason stated.
  WITH flag AS (
    UPDATE app.helpdesk_calls
       SET needs_review  = true,
           review_reason = 'Disposition says the call was not answered, but it ran for '
                           || COALESCE(duration_sec,0) || 's'
                           || CASE WHEN recording_filename IS NOT NULL THEN ' and was recorded' ELSE '' END
                           || '. No other call on this number matches it.'
     WHERE merged_into_call_id IS NULL
       AND voided_at IS NULL
       AND lower(TRIM(disposition)) IN
           ('unreachable / no answer','no answer','no_answer','voicemail','unreachable')
       AND (COALESCE(duration_sec,0) > 20 OR
            (recording_filename IS NOT NULL AND COALESCE(duration_sec,0) > 20))
     RETURNING id
  )
  SELECT COUNT(*) INTO flagged FROM flag;

  INSERT INTO app.schema_migrations (filename)
  VALUES ('172_call_dropped_and_log_audit.sql.applied') ON CONFLICT DO NOTHING;

  RAISE NOTICE 'reclassified % as Call Dropped, flagged % for review', dropped, flagged;
END $$;

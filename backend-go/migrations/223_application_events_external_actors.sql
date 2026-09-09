-- Let the activity trail record who did something when it was not a workspace user.
--
-- application_events.actor_user_id is NOT NULL, so the table can only describe an
-- action taken by someone with an o3c_users row. Everything else in an
-- application's life — Phoenix scoring it, the customer accepting an offer or
-- signing a mandate, a scheduled job expiring one — had nowhere to go and was
-- simply not written. That is why a Phoenix-originated application shows an empty
-- Activity tab forever: not a wiring fault, a schema that could not express the
-- actor.
--
-- Phoenix emits 19 event types across the credit lifecycle (offer.accepted,
-- mandate.reminder, consent.recorded, card.issued, credit_request.amount_confirmed
-- and so on). The workspace handled three. Recording the rest needs somewhere to
-- say "this was Phoenix", "this was the customer", or "this was the scheduler".
--
-- actor_source names WHERE the action came from; actor_label carries the display
-- name for a non-workspace actor (a Phoenix operator's name, or just "Customer").
-- For a workspace user both stay NULL and actor_user_id is used exactly as before,
-- so every existing row and every existing query keeps working unchanged.

BEGIN;

ALTER TABLE app.application_events ALTER COLUMN actor_user_id DROP NOT NULL;

ALTER TABLE app.application_events
  ADD COLUMN IF NOT EXISTS actor_source text NOT NULL DEFAULT 'workspace',
  ADD COLUMN IF NOT EXISTS actor_label  text,
  -- The upstream event id, so a redelivered webhook cannot write the same entry
  -- twice. Phoenix retries on any non-2xx and its own docs say to expect
  -- duplicates; without this a retry storm would fill the timeline with repeats.
  ADD COLUMN IF NOT EXISTS external_event_id text;

-- Existing rows are all workspace actions, which the default already states.
-- Nothing to backfill.

ALTER TABLE app.application_events
  DROP CONSTRAINT IF EXISTS application_events_actor_source_chk;
ALTER TABLE app.application_events
  ADD CONSTRAINT application_events_actor_source_chk
  CHECK (actor_source IN ('workspace', 'phoenix', 'customer', 'system'));

-- A workspace action must still name its user. Anything else must not pretend to.
ALTER TABLE app.application_events
  DROP CONSTRAINT IF EXISTS application_events_actor_shape_chk;
ALTER TABLE app.application_events
  ADD CONSTRAINT application_events_actor_shape_chk
  CHECK (
    (actor_source = 'workspace' AND actor_user_id IS NOT NULL)
    OR (actor_source <> 'workspace' AND actor_user_id IS NULL)
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_application_events_external_event
  ON app.application_events (external_event_id)
  WHERE external_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_application_events_app_created
  ON app.application_events (application_id, created_at DESC);

COMMIT;

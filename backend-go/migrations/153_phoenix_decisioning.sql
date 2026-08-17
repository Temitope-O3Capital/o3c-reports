-- 153_phoenix_decisioning.sql
--
-- Two-way integration with Phoenix, O3's credit decisioning system.
--
-- THE MODEL (decided with Temitope 2026-08-17)
--   * An application can START in either place.
--       - Raised in the workspace → submitted to Phoenix for a decision.
--       - Raised in Phoenix       → pushed to the workspace so it appears in the
--                                   Risk queue alongside everything else.
--   * Phoenix owns the application once it has been submitted. After hand-off the
--     workspace mirrors decision + status; it does not re-decide locally.
--   * Transport is REST both ways: we call Phoenix to submit, Phoenix calls our
--     webhook with created/updated/decided events.
--
-- WHY THE COLUMNS BELOW LAND ON loan_applications RATHER THAN A NEW TABLE
-- The origination schema already anticipated a decisioning engine — eye_score,
-- eye_rating, dti_pct, bureau_summary and (tellingly) eye_report_id are all present
-- and unused. Those ARE the Phoenix decision fields. Splitting the Phoenix copy into
-- a parallel table would fork the risk queue, so Phoenix populates the existing
-- columns and these additions only record provenance and sync state.

BEGIN;

-- ── Provenance and sync state on the application ─────────────────────────────
ALTER TABLE app.loan_applications
  -- 'workspace' — raised here.  'phoenix' — raised in Phoenix and pushed to us.
  ADD COLUMN IF NOT EXISTS source_system      text NOT NULL DEFAULT 'workspace',
  -- Phoenix's own application id. The correlation key for every later event.
  ADD COLUMN IF NOT EXISTS phoenix_id         text,
  -- pending      — needs submitting
  -- sent         — submitted, awaiting a decision
  -- decided      — decision received
  -- failed       — submission failed after retries (see phoenix_error)
  -- not_required — never goes to Phoenix (already Phoenix-owned, or a draft)
  ADD COLUMN IF NOT EXISTS phoenix_sync_state text NOT NULL DEFAULT 'not_required',
  ADD COLUMN IF NOT EXISTS phoenix_submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS phoenix_synced_at  timestamptz,
  ADD COLUMN IF NOT EXISTS phoenix_error      text,
  -- Decision payload. decision is Phoenix's verdict; decision_reasons keeps the
  -- factor breakdown verbatim so a decline can be explained to a customer without
  -- a round-trip, and so we never have to reverse-engineer a score.
  ADD COLUMN IF NOT EXISTS decision           text,
  ADD COLUMN IF NOT EXISTS decision_at        timestamptz,
  ADD COLUMN IF NOT EXISTS decision_reasons   jsonb;

-- Phoenix ids are unique where present. Partial, because workspace-raised
-- applications have none until Phoenix accepts them.
CREATE UNIQUE INDEX IF NOT EXISTS idx_loan_applications_phoenix_id
  ON app.loan_applications (phoenix_id) WHERE phoenix_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_loan_applications_sync_state
  ON app.loan_applications (phoenix_sync_state) WHERE phoenix_sync_state IN ('pending','failed');

DO $$ BEGIN
  ALTER TABLE app.loan_applications
    ADD CONSTRAINT loan_applications_source_system_check
    CHECK (source_system IN ('workspace','phoenix'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE app.loan_applications
    ADD CONSTRAINT loan_applications_phoenix_sync_state_check
    CHECK (phoenix_sync_state IN ('pending','sent','decided','failed','not_required'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Outbound queue ───────────────────────────────────────────────────────────
-- Submission is queued rather than done inline on the request. Phoenix will be on
-- the same box but it is still a separate process: a restart, a slow decision or a
-- deploy must not fail a risk officer's "submit" click or silently drop the
-- application. The worker drains this with exponential backoff.
CREATE TABLE IF NOT EXISTS app.phoenix_outbox (
  id              bigserial PRIMARY KEY,
  application_id  bigint NOT NULL REFERENCES app.loan_applications(id) ON DELETE CASCADE,
  operation       text   NOT NULL DEFAULT 'submit',
  state           text   NOT NULL DEFAULT 'queued',   -- queued | sent | failed | abandoned
  attempts        int    NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT NOW(),
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT NOW(),
  updated_at      timestamptz NOT NULL DEFAULT NOW()
);

-- One live job per application per operation — a double-click must not submit twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_phoenix_outbox_live
  ON app.phoenix_outbox (application_id, operation) WHERE state IN ('queued','failed');

CREATE INDEX IF NOT EXISTS idx_phoenix_outbox_due
  ON app.phoenix_outbox (next_attempt_at) WHERE state IN ('queued','failed');

-- ── Inbound event ledger ─────────────────────────────────────────────────────
-- Webhooks retry. Phoenix sends an event_id; we record it before acting and refuse
-- to process the same id twice, so a redelivered "decision.completed" cannot
-- overwrite a later decision or double-notify the risk officer.
CREATE TABLE IF NOT EXISTS app.phoenix_events (
  event_id       text PRIMARY KEY,
  event_type     text NOT NULL,
  phoenix_id     text,
  application_id bigint REFERENCES app.loan_applications(id) ON DELETE SET NULL,
  payload        jsonb NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT NOW(),
  processed_at   timestamptz,
  error          text
);

CREATE INDEX IF NOT EXISTS idx_phoenix_events_unprocessed
  ON app.phoenix_events (received_at) WHERE processed_at IS NULL;

-- Existing rows predate the integration and must not be swept into a bulk submit.
UPDATE app.loan_applications
SET phoenix_sync_state = 'not_required'
WHERE phoenix_sync_state IS NULL;

COMMIT;

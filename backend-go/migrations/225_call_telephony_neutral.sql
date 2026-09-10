-- 225: provider-neutral telephony model for inbound queue / ring / abandonment.
--
-- The workspace has only ever stored a flat, already-resolved call (one caller, one
-- answering agent, answered-or-missed). It never captured HOW an inbound call rang across
-- a queue, how long the caller waited, whether they hung up before anyone answered, or
-- which agents it rang and in what order before it moved on.
--
-- Zoho Voice exposes all of that, but this model is deliberately NOT Zoho-shaped. The
-- columns and the call_ring_legs table describe telephony in provider-neutral terms
-- (queue, ring strategy, ring legs, who disconnected, wait time). Zoho is merely the first
-- PRODUCER that maps into it; when O3 moves to its own telephony (FreeSWITCH, see
-- docs/IN_APP_CALLING_PLAN) or any other carrier, that producer fills the same columns and
-- the same table and nothing downstream (API, UI, reports) changes.

-- Neutral telephony facts on the single call ledger. All nullable/defaulted so historical
-- rows and providers that don't supply a field are unaffected.
ALTER TABLE helpdesk_calls ADD COLUMN IF NOT EXISTS answered_at        timestamptz;                 -- when an agent picked up (NULL = never answered)
ALTER TABLE helpdesk_calls ADD COLUMN IF NOT EXISTS wait_sec           int;                         -- ring/wait before answer (answered) or before hang-up (abandoned)
ALTER TABLE helpdesk_calls ADD COLUMN IF NOT EXISTS disconnected_by    text NOT NULL DEFAULT '';    -- 'agent' | 'caller' | 'system' | '' — who hung up
ALTER TABLE helpdesk_calls ADD COLUMN IF NOT EXISTS hangup_cause       text NOT NULL DEFAULT '';    -- raw provider cause, kept verbatim
ALTER TABLE helpdesk_calls ADD COLUMN IF NOT EXISTS queue_name         text NOT NULL DEFAULT '';    -- the ring group / queue / department the call came through
ALTER TABLE helpdesk_calls ADD COLUMN IF NOT EXISTS abandoned          boolean NOT NULL DEFAULT false; -- caller hung up before any agent answered
ALTER TABLE helpdesk_calls ADD COLUMN IF NOT EXISTS telephony_provider text NOT NULL DEFAULT '';    -- who supplied the telephony facts: zoho_voice | freeswitch | africastalking | manual

-- The per-agent ring sequence of ONE call: "rang Ada (no answer 12s) -> rang Bode
-- (answered)". One row per (call, agent, ring position). Provider-neutral: the outcome
-- vocabulary and strategy names are generic, not Zoho's.
CREATE TABLE IF NOT EXISTS call_ring_legs (
  id          BIGSERIAL PRIMARY KEY,
  call_id     BIGINT NOT NULL REFERENCES helpdesk_calls(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL DEFAULT '',   -- zoho_voice | freeswitch | africastalking | ...
  queue_name  TEXT NOT NULL DEFAULT '',
  strategy    TEXT NOT NULL DEFAULT '',   -- ring-all | top-down | round-robin | progressive | sequential | unknown
  position    INT  NOT NULL DEFAULT 0,    -- 1-based ring order
  agent_name  TEXT NOT NULL DEFAULT '',
  agent_id    BIGINT REFERENCES o3c_users(id) ON DELETE SET NULL,
  rang_at     TIMESTAMPTZ,
  ring_sec    INT,
  outcome     TEXT NOT NULL DEFAULT '',   -- answered | missed | no_answer | rejected | moved_on | cancelled
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One leg per (call, position, agent) — lets the producer re-run idempotently.
CREATE UNIQUE INDEX IF NOT EXISTS uq_call_ring_legs ON call_ring_legs (call_id, position, agent_name);
CREATE INDEX IF NOT EXISTS idx_call_ring_legs_call ON call_ring_legs (call_id);

-- Fast inbound-queue analytics (abandonment, wait) over the recent window the Inbound page reads.
CREATE INDEX IF NOT EXISTS idx_helpdesk_calls_inbound_started
  ON helpdesk_calls (started_at DESC)
  WHERE direction = 'inbound' AND merged_into_call_id IS NULL AND voided_at IS NULL;

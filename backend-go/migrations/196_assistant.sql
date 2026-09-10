-- 196_assistant.sql
--
-- Storage + audit trail for the in-workspace AI assistant (handlers/assistant.go).
--
-- The assistant answers questions about live workspace data by calling a fixed
-- registry of vetted Go tools -- it never writes or receives SQL. Every turn is
-- persisted here, and that persistence IS the audit trail: for a regulated
-- lender it must always be answerable after the fact who asked what, which data
-- tool ran on their behalf, what it returned, and what the model said back.
-- There is deliberately no separate audit table; a second copy would drift.
--
-- Retention is intentionally open-ended (no TTL) because these rows are the
-- audit record. Prune only with a documented retention decision.
--
-- Idempotent: safe to run repeatedly.

CREATE TABLE IF NOT EXISTS assistant_conversations (
  id          bigserial PRIMARY KEY,
  user_id     bigint      NOT NULL REFERENCES o3c_users(id) ON DELETE CASCADE,
  title       text        NOT NULL DEFAULT 'New conversation',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

-- Conversations are always listed newest-first for one user, never across users.
CREATE INDEX IF NOT EXISTS idx_assistant_conv_user
  ON assistant_conversations (user_id, updated_at DESC)
  WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS assistant_messages (
  id              bigserial PRIMARY KEY,
  conversation_id bigint      NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
  -- 'user' | 'assistant' | 'tool'. Tool rows record a data fetch made on the
  -- user's behalf and are the part auditors actually care about.
  role            text        NOT NULL CHECK (role IN ('user','assistant','tool')),
  content         text        NOT NULL DEFAULT '',
  tool_name       text,
  tool_args       jsonb,
  tool_result     jsonb,
  -- Denormalised from the JWT at write time. If a user is later renamed or
  -- deleted the audit row must still say who asked, so this is NOT a join.
  actor_user_id   bigint,
  actor_name      text,
  actor_role      text,
  model           text,
  prompt_tokens   integer,
  output_tokens   integer,
  latency_ms      integer,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_assistant_msg_conv
  ON assistant_messages (conversation_id, id);

-- Audit lookups are "what did this person ask", and "when did tool X run".
CREATE INDEX IF NOT EXISTS idx_assistant_msg_actor
  ON assistant_messages (actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assistant_msg_tool
  ON assistant_messages (tool_name, created_at DESC)
  WHERE tool_name IS NOT NULL;

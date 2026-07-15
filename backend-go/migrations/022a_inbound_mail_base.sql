-- 022a_inbound_mail_base
--
-- Creates `inbound_mail` BEFORE 023 alters it.
--
-- 023_mail_inbound_replies.sql runs `ALTER TABLE inbound_mail ...`, but the
-- table is only ever created at RUNTIME by ensureMailSchema() in
-- handlers/mail.go -- which cannot have run yet, because a failed migration
-- aborts startup before any handler is reachable. On a fresh database that is
-- a deadlock: 023 can never succeed.
--
-- Production never hit it: inbound_mail was created by ensureMailSchema()
-- against a database whose migrations were already seeded as applied.
--
-- DDL copied verbatim from handlers/mail.go (ensureMailSchema) so the migration
-- and the runtime bootstrap cannot drift. Both are IF NOT EXISTS, so whichever
-- runs first wins -- which also makes this a no-op against production.

CREATE TABLE IF NOT EXISTS inbound_mail (
  id              BIGSERIAL PRIMARY KEY,
  mail_message_id BIGINT REFERENCES mail_messages(id) ON DELETE SET NULL,
  from_email      TEXT NOT NULL,
  from_name       TEXT,
  to_email        TEXT,
  subject         TEXT NOT NULL DEFAULT '',
  body_text       TEXT,
  body_html       TEXT,
  message_id      TEXT,
  in_reply_to     TEXT,
  raw_headers     TEXT,
  is_read         BOOLEAN NOT NULL DEFAULT false,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inbound_mail_received ON inbound_mail(received_at DESC);

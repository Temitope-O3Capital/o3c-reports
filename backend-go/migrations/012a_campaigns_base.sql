-- 012a_campaigns_base
--
-- Creates `campaigns` BEFORE 013 alters it.
--
-- 013_campaign_tracking.sql runs `ALTER TABLE campaigns ...` but nothing had
-- created that table yet; 015_schema_fixes.sql creates it and even carries the
-- comment "013 alters it but never creates it" -- except 015 runs *after* 013,
-- so a fresh database still dies at 013. Production never noticed: those tables
-- predate the migration runner and were seeded as already-applied.
--
-- This file sorts between 012_ and 013_ ('_' < 'a' < '_'... precisely:
-- "012_api_credentials.sql" < "012a_campaigns_base.sql" < "013_campaign_tracking.sql").
--
-- Definition copied verbatim from 015 so the two cannot drift. Both use
-- IF NOT EXISTS, so whichever runs first wins and the other is a no-op --
-- which also makes this safe to apply to the existing production database.

CREATE TABLE IF NOT EXISTS campaigns (
  id                BIGSERIAL PRIMARY KEY,
  name              TEXT    NOT NULL,
  description       TEXT,
  status            TEXT    NOT NULL DEFAULT 'draft',
  type              TEXT    NOT NULL DEFAULT 'sms',
  list_id           BIGINT,
  -- body / content
  email_subject     TEXT,
  email_body_html   TEXT,
  email_body_text   TEXT,
  sms_body          TEXT,
  from_name         TEXT,
  from_email        TEXT,
  -- counters (columns referenced in startDispatch / webhooks)
  total_contacts    INT     NOT NULL DEFAULT 0,
  sms_sent          INT     NOT NULL DEFAULT 0,
  sms_failed        INT     NOT NULL DEFAULT 0,
  sms_delivered     INT     NOT NULL DEFAULT 0,
  emails_sent       INT     NOT NULL DEFAULT 0,
  emails_bounced    INT     NOT NULL DEFAULT 0,
  emails_delivered  INT     NOT NULL DEFAULT 0,
  emails_opened     INT     NOT NULL DEFAULT 0,
  emails_clicked    INT     NOT NULL DEFAULT 0,
  -- scheduling / lifecycle
  scheduled_at      TIMESTAMPTZ,
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  created_by        BIGINT  REFERENCES o3c_users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 015_schema_fixes.sql
-- Fully idempotent. Only adds — never drops or renames.
-- Run after 001–014. Fixes broken FKs, creates tables that handlers reference
-- but that were never created, adds missing columns and indexes, and creates
-- sequences for race-condition-free reference numbers.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Fix migration 012: api_credentials.updated_by references the non-existent
--    table "users"; the correct table is "o3c_users" (created in 014).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE api_credentials DROP CONSTRAINT IF EXISTS api_credentials_updated_by_fkey;

DO $$ BEGIN
  ALTER TABLE api_credentials ADD CONSTRAINT api_credentials_updated_by_fkey
    FOREIGN KEY (updated_by) REFERENCES o3c_users(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Fix migration 013: cs_interactions.agent_id also references the missing
--    "users" table. Correct it to o3c_users.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE cs_interactions DROP CONSTRAINT IF EXISTS cs_interactions_agent_id_fkey;

DO $$ BEGIN
  ALTER TABLE cs_interactions ADD CONSTRAINT cs_interactions_agent_id_fkey
    FOREIGN KEY (agent_id) REFERENCES o3c_users(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. campaigns table (013 alters it but never creates it).
--    Column set derived from handlers/campaigns.go actual INSERT/UPDATE queries.
-- ─────────────────────────────────────────────────────────────────────────────
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

-- Columns added by 013 — safe to add again with IF NOT EXISTS
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS sent_count        INT DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS delivered_count   INT DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS open_count        INT DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS click_count       INT DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS bounce_count      INT DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS unsubscribe_count INT DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS sendgrid_batch_id TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS termii_message_id TEXT;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. campaign_contacts — required by startDispatch / listCampaignContacts
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS campaign_contacts (
  id                  BIGSERIAL PRIMARY KEY,
  campaign_id         BIGINT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  first_name          TEXT,
  last_name           TEXT,
  phone               TEXT,
  email               TEXT,
  cif_number          TEXT,
  merge_data          JSONB,
  position            INT     NOT NULL DEFAULT 0,
  sms_status          TEXT    NOT NULL DEFAULT 'pending',
  sms_provider_id     TEXT,
  sms_sent_at         TIMESTAMPTZ,
  email_status        TEXT    NOT NULL DEFAULT 'pending',
  email_provider_id   TEXT,
  email_sent_at       TIMESTAMPTZ,
  email_opened_at     TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_campaign_contacts_campaign ON campaign_contacts(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_contacts_sms_pid  ON campaign_contacts(sms_provider_id) WHERE sms_provider_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_campaign_contacts_email_pid ON campaign_contacts(email_provider_id) WHERE email_provider_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. o3c_custom_roles — admin.go listRoles selects id, name, label, pages
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS o3c_custom_roles (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  label       TEXT NOT NULL DEFAULT '',
  pages       TEXT[] NOT NULL DEFAULT '{}',
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add label column if the table already existed without it
ALTER TABLE o3c_custom_roles ADD COLUMN IF NOT EXISTS label TEXT NOT NULL DEFAULT '';

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. user_sessions — admin.go getUserSessions reads logged_in_at, last_active_at
--    auth.go INSERT writes user_id, ip_address, user_agent
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_sessions (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES o3c_users(id) ON DELETE CASCADE,
  ip_address     TEXT,
  user_agent     TEXT,
  logged_in_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. o3c_activity_log — admin.go logActivity INSERTs user_id, page, action,
--    detail, ip.  getActivity / getUserActivity SELECT id, page, action, detail,
--    ip, ts, resource, method.  Note the timestamp column is named "ts".
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS o3c_activity_log (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT REFERENCES o3c_users(id) ON DELETE CASCADE,
  page       TEXT,
  action     TEXT,
  detail     TEXT,
  ip         TEXT,
  resource   TEXT,
  method     TEXT,
  ts         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_activity_log_user    ON o3c_activity_log(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_ts      ON o3c_activity_log(ts DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. loan_documents — loans.go uses application_id, doc_type, filename, notes,
--    status, confirmed_by, confirmed_at
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS loan_documents (
  id             BIGSERIAL PRIMARY KEY,
  application_id BIGINT NOT NULL REFERENCES loan_applications(id) ON DELETE CASCADE,
  doc_type       TEXT   NOT NULL,
  filename       TEXT   NOT NULL DEFAULT '',
  notes          TEXT,
  status         TEXT   NOT NULL DEFAULT 'submitted',
  confirmed_by   BIGINT REFERENCES o3c_users(id),
  confirmed_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_loan_docs_app ON loan_documents(application_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. loan_comments — loans.go uses application_id, user_id, user_name, body
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS loan_comments (
  id             BIGSERIAL PRIMARY KEY,
  application_id BIGINT NOT NULL REFERENCES loan_applications(id) ON DELETE CASCADE,
  user_id        BIGINT REFERENCES o3c_users(id),
  user_name      TEXT,
  body           TEXT   NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_loan_comments_app ON loan_comments(application_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. loan_activity_log — loans.go logLoanAction inserts
--     application_id, user_id, user_name, action, old_value, new_value, note.
--     getLoanActivity selects id, user_id, user_name, action, old_value,
--     new_value, note, created_at.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS loan_activity_log (
  id             BIGSERIAL PRIMARY KEY,
  application_id BIGINT NOT NULL REFERENCES loan_applications(id) ON DELETE CASCADE,
  user_id        BIGINT REFERENCES o3c_users(id),
  user_name      TEXT,
  action         TEXT   NOT NULL,
  old_value      TEXT,
  new_value      TEXT,
  note           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_loan_activity_app ON loan_activity_log(application_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 11. loan_applications — handlers/loans.go uses columns that differ from the
--     LOS columns in 004. Add the missing ones (ref_no, cif, first_name,
--     last_name, phone, email, loan_type, loan_amount, assigned_to, created_by,
--     reviewed_by, reviewed_at).  All existing 004 columns are left untouched.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS ref_no       TEXT;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS cif          TEXT;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS first_name   TEXT NOT NULL DEFAULT '';
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS last_name    TEXT NOT NULL DEFAULT '';
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS phone        TEXT;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS email        TEXT;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS loan_type    TEXT;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS loan_amount  NUMERIC(20,2);
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS assigned_to  BIGINT;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS created_by   BIGINT REFERENCES o3c_users(id);
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS reviewed_by  BIGINT REFERENCES o3c_users(id);
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS reviewed_at  TIMESTAMPTZ;

-- ─────────────────────────────────────────────────────────────────────────────
-- 12. recovery_cases — recovery_ops.go uses different column names than 006.
--     Add the missing aliases without touching existing columns.
--     Handler reads: account_cif, assigned_agent_id, outstanding_kobo,
--     recovered_kobo, opened_at, closed_at.
--     006 has: cif_number, assigned_to_user_id, total_outstanding_kobo,
--              total_recovered_kobo (no opened_at / closed_at).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE recovery_cases ADD COLUMN IF NOT EXISTS account_cif        TEXT;
ALTER TABLE recovery_cases ADD COLUMN IF NOT EXISTS assigned_agent_id  BIGINT REFERENCES o3c_users(id);
ALTER TABLE recovery_cases ADD COLUMN IF NOT EXISTS outstanding_kobo   BIGINT NOT NULL DEFAULT 0;
ALTER TABLE recovery_cases ADD COLUMN IF NOT EXISTS recovered_kobo     BIGINT NOT NULL DEFAULT 0;
ALTER TABLE recovery_cases ADD COLUMN IF NOT EXISTS opened_at          TIMESTAMPTZ;
ALTER TABLE recovery_cases ADD COLUMN IF NOT EXISTS closed_at          TIMESTAMPTZ;

-- ─────────────────────────────────────────────────────────────────────────────
-- 13. recovery_payments — recovery_ops.go inserts payment_method, receipt_ref.
--     006 has: channel (not payment_method), reference (not receipt_ref).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE recovery_payments ADD COLUMN IF NOT EXISTS payment_method TEXT;
ALTER TABLE recovery_payments ADD COLUMN IF NOT EXISTS receipt_ref    TEXT;

-- ─────────────────────────────────────────────────────────────────────────────
-- 14. legal_proceedings — recovery_ops.go uses court_name, case_number,
--     next_hearing_date, status. 006 has: court, filing_date, next_date,
--     outcome, notes (no court_name / case_number / next_hearing_date / status).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE legal_proceedings ADD COLUMN IF NOT EXISTS court_name        TEXT;
ALTER TABLE legal_proceedings ADD COLUMN IF NOT EXISTS case_number       TEXT;
ALTER TABLE legal_proceedings ADD COLUMN IF NOT EXISTS next_hearing_date TEXT;
ALTER TABLE legal_proceedings ADD COLUMN IF NOT EXISTS status            TEXT NOT NULL DEFAULT 'active';

-- ─────────────────────────────────────────────────────────────────────────────
-- 15. recovery_write_off_approvals — recovery_ops.go stageProgressions updates
--     recovery_head_approved_by, finance_approved_by, md_approved_by columns.
--     Also uses case_id, amount_kobo, reason, requested_by, status.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS recovery_write_off_approvals (
  id                        BIGSERIAL PRIMARY KEY,
  case_id                   BIGINT NOT NULL REFERENCES recovery_cases(id) ON DELETE CASCADE,
  requested_by              BIGINT REFERENCES o3c_users(id),
  recovery_head_approved_by BIGINT REFERENCES o3c_users(id),
  finance_approved_by       BIGINT REFERENCES o3c_users(id),
  md_approved_by            BIGINT REFERENCES o3c_users(id),
  amount_kobo               BIGINT NOT NULL,
  status                    TEXT   NOT NULL DEFAULT 'pending_recovery_head',
  reason                    TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_write_off_case   ON recovery_write_off_approvals(case_id);
CREATE INDEX IF NOT EXISTS idx_write_off_status ON recovery_write_off_approvals(status);

-- ─────────────────────────────────────────────────────────────────────────────
-- 16. Sequences for race-condition-free reference numbers
-- ─────────────────────────────────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS los_ref_seq     START 1;
CREATE SEQUENCE IF NOT EXISTS sar_ref_seq     START 1;
CREATE SEQUENCE IF NOT EXISTS finding_ref_seq START 1;

-- ─────────────────────────────────────────────────────────────────────────────
-- 17. Missing indexes on loan_applications
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_loan_apps_updated ON loan_applications(updated_at DESC);
-- idx_loan_apps_status and idx_loan_apps_stage already created in 004;
-- IF NOT EXISTS makes these no-ops when they already exist.
CREATE INDEX IF NOT EXISTS idx_loan_apps_stage   ON loan_applications(stage);
-- (idx_loan_apps_status already in 004 — kept here for completeness, safe)

-- ─────────────────────────────────────────────────────────────────────────────
-- 18. Prevent duplicate active CIF assignments
-- ─────────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS idx_collection_assignments_active_cif
  ON collection_assignments(cif_number) WHERE status = 'active';

-- ─────────────────────────────────────────────────────────────────────────────
-- 19. Default partition for audit_logs (catches rows with timestamps outside
--     the explicitly-defined monthly partitions)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs_default PARTITION OF audit_logs DEFAULT;

-- ─────────────────────────────────────────────────────────────────────────────
-- 20. Missing FKs for notifications and documents
--     notifications.user_id and documents.uploaded_by have no FK in 002/003.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  ALTER TABLE notifications ADD CONSTRAINT fk_notifications_user
    FOREIGN KEY (user_id) REFERENCES o3c_users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE documents ADD CONSTRAINT fk_documents_uploaded_by
    FOREIGN KEY (uploaded_by) REFERENCES o3c_users(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 21. Add threshold_unit to alert_rules (needed to distinguish pct vs hours
--     vs count thresholds when evaluating rules programmatically)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS metric TEXT;
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS threshold_unit TEXT NOT NULL DEFAULT 'pct';

-- Backfill metric from condition_type so alert workers have a clean lookup key
UPDATE alert_rules SET metric = condition_type WHERE metric IS NULL OR metric = '';

UPDATE alert_rules SET threshold_unit = 'hours' WHERE metric = 'sar_draft_aging_hours';
UPDATE alert_rules SET threshold_unit = 'count' WHERE metric = 'compliance_overdue';

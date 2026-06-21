-- Migration 017: Helpdesk module, Notifications, Campaign tracking events
-- Idempotent — safe to run multiple times
-- Date: 2026-06-21
--
-- Pre-run audit notes (migrations 001–016):
--
--  • notifications          — EXISTS (002): columns id, user_id, type, title, body,
--                             entity_type, entity_id (BIGINT), is_read, created_at.
--                             This migration EXTENDS it: adds read_at, action_url,
--                             entity_id as TEXT alias, FK to o3c_users, type CHECK,
--                             and new indexes. Does NOT drop existing columns.
--
--  • campaign_events        — EXISTS (013): columns id, campaign_id, recipient_email,
--                             recipient_phone, event_type, event_data, occurred_at.
--                             This migration adds the richer tracking columns
--                             (contact_id, tracking_id, channel, url, user_agent,
--                             ip_address, provider_msg_id, raw_payload, ts) and the
--                             missing indexes. Table is NOT recreated.
--
--  • campaign_contacts      — EXISTS (015): tracking_id column is new here.
--
--  • contact_list_members   — EXISTS (015): dedup partial indexes are new here.
--
--  • campaigns              — EXISTS (015).
--
--  • o3c_users              — EXISTS (014): correct user table.
--
--  • helpdesk_tickets,      — DO NOT EXIST anywhere: created fresh here.
--    helpdesk_messages,
--    helpdesk_events,
--    helpdesk_canned_responses,
--    helpdesk_sla_policies,
--    sse_tokens,
--    campaign_uploads

-- =============================================================================
-- SECTION 1 — Campaign tracking
-- =============================================================================

-- 1a. Add tracking_id to campaign_contacts (table exists from 015)
ALTER TABLE campaign_contacts ADD COLUMN IF NOT EXISTS tracking_id TEXT;

-- Make unique only if the constraint does not already exist
DO $$ BEGIN
    ALTER TABLE campaign_contacts ADD CONSTRAINT campaign_contacts_tracking_id_key UNIQUE (tracking_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Set a default expression so future inserts get an auto-generated value
DO $$ BEGIN
    ALTER TABLE campaign_contacts ALTER COLUMN tracking_id SET DEFAULT gen_random_uuid()::text;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- Backfill tracking_id for existing rows that have none
UPDATE campaign_contacts SET tracking_id = gen_random_uuid()::text WHERE tracking_id IS NULL;

-- 1b. Extend campaign_events with richer webhook/tracking columns
--     Table exists from 013 with: id, campaign_id, recipient_email,
--     recipient_phone, event_type, event_data, occurred_at.
--     Allowed event_type values in 013 comment: sent/delivered/opened/clicked/bounced/unsubscribed/failed
--     We add 'spam' to the permitted set via a new named CHECK constraint.
ALTER TABLE campaign_events ADD COLUMN IF NOT EXISTS contact_id      BIGINT REFERENCES campaign_contacts(id);
ALTER TABLE campaign_events ADD COLUMN IF NOT EXISTS tracking_id     TEXT;
ALTER TABLE campaign_events ADD COLUMN IF NOT EXISTS channel         TEXT;   -- 'sms' or 'email'
ALTER TABLE campaign_events ADD COLUMN IF NOT EXISTS url             TEXT;   -- for 'clicked' events only
ALTER TABLE campaign_events ADD COLUMN IF NOT EXISTS user_agent      TEXT;
ALTER TABLE campaign_events ADD COLUMN IF NOT EXISTS ip_address      TEXT;
ALTER TABLE campaign_events ADD COLUMN IF NOT EXISTS provider_msg_id TEXT;
ALTER TABLE campaign_events ADD COLUMN IF NOT EXISTS raw_payload     JSONB;
ALTER TABLE campaign_events ADD COLUMN IF NOT EXISTS ts              TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Add CHECK constraints only if they do not already exist
DO $$ BEGIN
    ALTER TABLE campaign_events ADD CONSTRAINT campaign_events_type_check
        CHECK (event_type IN ('sent','delivered','opened','clicked','bounced','spam','unsubscribed','failed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE campaign_events ADD CONSTRAINT campaign_events_channel_check
        CHECK (channel IN ('sms','email'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Add missing indexes (013 only created campaign_id and event_type)
CREATE INDEX IF NOT EXISTS idx_campaign_events_contact   ON campaign_events(contact_id);
CREATE INDEX IF NOT EXISTS idx_campaign_events_tracking  ON campaign_events(tracking_id);
CREATE INDEX IF NOT EXISTS idx_campaign_events_ts        ON campaign_events(ts DESC);

-- 1c. Campaign uploads table (images for email block editor)
CREATE TABLE IF NOT EXISTS campaign_uploads (
    id            BIGSERIAL PRIMARY KEY,
    original_name TEXT NOT NULL,
    stored_name   TEXT NOT NULL,
    mime_type     TEXT,
    size_bytes    BIGINT,
    url           TEXT NOT NULL,
    uploaded_by   BIGINT REFERENCES o3c_users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 1d. Contact list member deduplication (prevent duplicate sends per list)
--     contact_list_members exists from 015 with columns list_id, cif_number, phone.
CREATE UNIQUE INDEX IF NOT EXISTS idx_clm_list_cif
    ON contact_list_members(list_id, cif_number) WHERE cif_number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_clm_list_phone
    ON contact_list_members(list_id, phone) WHERE phone IS NOT NULL AND phone != '';

-- =============================================================================
-- SECTION 2 — Notifications system
-- =============================================================================

-- The notifications table was created in 002 with a minimal schema.
-- We extend it here with the columns the helpdesk/SSE handlers need.
-- Existing columns (body, is_read, entity_id BIGINT) are left untouched.

-- Add read_at (nullable TIMESTAMPTZ — replaces the boolean is_read pattern
-- but we keep is_read for backward compat with any existing queries in 002)
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS read_at     TIMESTAMPTZ;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS action_url  TEXT;
-- entity_id in 002 is BIGINT; add a separate text-typed column for string IDs
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS entity_ref  TEXT;

-- Add FK to o3c_users if not already present
DO $$ BEGIN
    ALTER TABLE notifications ADD CONSTRAINT fk_notifications_user_o3c
        FOREIGN KEY (user_id) REFERENCES o3c_users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Add type CHECK constraint (015 did not add one; 002 did not add one)
DO $$ BEGIN
    ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (
        type IN ('assignment','approval','ticket_reply','campaign_done','system','mention','sla_breach','info')
    );
EXCEPTION
    WHEN duplicate_object     THEN NULL;
    WHEN check_violation      THEN NULL; -- existing rows violate constraint; skip
END $$;

-- Supplemental indexes (002 has idx_notif_user and idx_notif_entity already)
CREATE INDEX IF NOT EXISTS idx_notifications_unread   ON notifications(user_id) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_created  ON notifications(created_at DESC);

-- SSE tokens: short-lived (2 min) tokens for SSE connections
CREATE TABLE IF NOT EXISTS sse_tokens (
    token       TEXT PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES o3c_users(id) ON DELETE CASCADE,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sse_tokens_expires ON sse_tokens(expires_at);

-- =============================================================================
-- SECTION 3 — Helpdesk (Customer Service)
-- =============================================================================

CREATE SEQUENCE IF NOT EXISTS ticket_ref_seq START WITH 1 INCREMENT BY 1;

CREATE TABLE IF NOT EXISTS helpdesk_tickets (
    id                BIGSERIAL PRIMARY KEY,
    ticket_ref        TEXT NOT NULL UNIQUE DEFAULT 'TKT-' || LPAD(nextval('ticket_ref_seq')::text, 5, '0'),
    channel           TEXT NOT NULL,
    -- 'email','sms','whatsapp','phone','in_app'
    status            TEXT NOT NULL DEFAULT 'open',
    -- 'open','pending','in_progress','resolved','closed'
    priority          TEXT NOT NULL DEFAULT 'normal',
    -- 'low','normal','high','urgent'
    subject           TEXT,
    customer_cif      TEXT,
    customer_name     TEXT,
    customer_email    TEXT,
    customer_phone    TEXT,
    assigned_to       BIGINT REFERENCES o3c_users(id),
    assigned_at       TIMESTAMPTZ,
    department        TEXT,
    -- 'collections','recovery','cards_ops','loans','general','compliance'
    tags              TEXT[] NOT NULL DEFAULT '{}',
    sla_due_at        TIMESTAMPTZ,
    first_response_at TIMESTAMPTZ,
    resolved_at       TIMESTAMPTZ,
    closed_at         TIMESTAMPTZ,
    csat_score        INTEGER CHECK (csat_score BETWEEN 1 AND 5),
    csat_comment      TEXT,
    csat_token        TEXT UNIQUE DEFAULT gen_random_uuid()::text,
    email_thread_id   TEXT,
    campaign_id       BIGINT REFERENCES campaigns(id),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT helpdesk_tickets_channel_check CHECK (
        channel IN ('email','sms','whatsapp','phone','in_app')
    ),
    CONSTRAINT helpdesk_tickets_status_check CHECK (
        status IN ('open','pending','in_progress','resolved','closed')
    ),
    CONSTRAINT helpdesk_tickets_priority_check CHECK (
        priority IN ('low','normal','high','urgent')
    )
);

CREATE INDEX IF NOT EXISTS idx_tickets_status      ON helpdesk_tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_assigned    ON helpdesk_tickets(assigned_to);
CREATE INDEX IF NOT EXISTS idx_tickets_channel     ON helpdesk_tickets(channel);
CREATE INDEX IF NOT EXISTS idx_tickets_cif         ON helpdesk_tickets(customer_cif);
CREATE INDEX IF NOT EXISTS idx_tickets_created     ON helpdesk_tickets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_csat_token  ON helpdesk_tickets(csat_token);
CREATE INDEX IF NOT EXISTS idx_tickets_email_thread ON helpdesk_tickets(email_thread_id) WHERE email_thread_id IS NOT NULL;

-- Full-text search index for tickets
CREATE INDEX IF NOT EXISTS idx_tickets_fts ON helpdesk_tickets
    USING gin(to_tsvector('english',
        coalesce(subject,'') || ' ' || coalesce(customer_name,'') || ' ' || coalesce(customer_cif,'')
    ));

CREATE TABLE IF NOT EXISTS helpdesk_messages (
    id                  BIGSERIAL PRIMARY KEY,
    ticket_id           BIGINT NOT NULL REFERENCES helpdesk_tickets(id) ON DELETE CASCADE,
    direction           TEXT NOT NULL,  -- 'inbound', 'outbound'
    channel             TEXT NOT NULL,
    author_user_id      BIGINT REFERENCES o3c_users(id),
    author_name         TEXT,
    body_text           TEXT,
    body_html           TEXT,
    attachments         JSONB NOT NULL DEFAULT '[]',
    email_message_id    TEXT,
    in_reply_to         TEXT,
    provider_message_id TEXT,
    status              TEXT NOT NULL DEFAULT 'sent',
    -- 'sent','delivered','failed'
    is_internal_note    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT helpdesk_messages_direction_check CHECK (direction IN ('inbound','outbound')),
    CONSTRAINT helpdesk_messages_status_check    CHECK (status IN ('sent','delivered','failed'))
);

CREATE INDEX IF NOT EXISTS idx_hd_messages_ticket  ON helpdesk_messages(ticket_id);
CREATE INDEX IF NOT EXISTS idx_hd_messages_created ON helpdesk_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_hd_messages_email   ON helpdesk_messages(email_message_id) WHERE email_message_id IS NOT NULL;

-- Full-text search index for messages
CREATE INDEX IF NOT EXISTS idx_hd_messages_fts ON helpdesk_messages
    USING gin(to_tsvector('english', coalesce(body_text,'')));

CREATE TABLE IF NOT EXISTS helpdesk_events (
    id          BIGSERIAL PRIMARY KEY,
    ticket_id   BIGINT NOT NULL REFERENCES helpdesk_tickets(id) ON DELETE CASCADE,
    user_id     BIGINT REFERENCES o3c_users(id),
    event_type  TEXT NOT NULL,
    old_value   TEXT,
    new_value   TEXT,
    ts          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hd_events_ticket ON helpdesk_events(ticket_id);

CREATE TABLE IF NOT EXISTS helpdesk_canned_responses (
    id          BIGSERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    channel     TEXT NOT NULL DEFAULT 'both',  -- 'email','sms','both'
    subject     TEXT,
    body_text   TEXT NOT NULL,
    body_html   TEXT,
    category    TEXT,
    created_by  BIGINT REFERENCES o3c_users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS helpdesk_sla_policies (
    id                   BIGSERIAL PRIMARY KEY,
    name                 TEXT    NOT NULL,
    priority             TEXT    NOT NULL UNIQUE,
    first_response_hours INTEGER NOT NULL,
    resolution_hours     INTEGER NOT NULL,
    is_active            BOOLEAN NOT NULL DEFAULT TRUE
);

INSERT INTO helpdesk_sla_policies (name, priority, first_response_hours, resolution_hours) VALUES
    ('Low Priority',    'low',    24, 72),
    ('Normal Priority', 'normal',  8, 24),
    ('High Priority',   'high',    4,  8),
    ('Urgent Priority', 'urgent',  1,  4)
ON CONFLICT (priority) DO NOTHING;

INSERT INTO helpdesk_canned_responses (name, channel, subject, body_text, body_html, category) VALUES
    ('Greeting - General',  'both', NULL,
     'Hello {{customer_name}}, thank you for reaching out to O3C Cards support. How can we help you today?',
     '<p>Hello {{customer_name}},</p><p>Thank you for reaching out to O3C Cards support. How can we help you today?</p>',
     'Greetings'),
    ('Ticket Resolved',     'both', 'Your support request has been resolved',
     'Dear {{customer_name}}, we are pleased to inform you that your support request ({{ticket_ref}}) has been resolved. Please rate your experience by clicking the link sent to you.',
     '<p>Dear {{customer_name}},</p><p>We are pleased to inform you that your support request (<strong>{{ticket_ref}}</strong>) has been resolved. Please rate your experience by clicking the link sent to you.</p>',
     'Closures'),
    ('Need More Info',      'both', 'Additional information needed — {{ticket_ref}}',
     'Dear {{customer_name}}, to resolve your support request ({{ticket_ref}}), we need a few more details. Please reply with your preferred contact time and additional details about the issue.',
     '<p>Dear {{customer_name}},</p><p>To resolve your support request (<strong>{{ticket_ref}}</strong>), we need a few more details.</p><p>Please reply with your preferred contact time and additional details about the issue.</p>',
     'Information'),
    ('Payment Received',    'sms',  NULL,
     'Dear {{customer_name}}, we have received your payment of {{amount}}. Your O3C account has been updated. Ref: {{ticket_ref}}',
     NULL,
     'Payments'),
    ('Account Escalated',   'email', 'Your request has been escalated — {{ticket_ref}}',
     'Dear {{customer_name}}, your support request ({{ticket_ref}}) has been escalated to our senior team. We will resolve this within {{resolution_time}}. We apologise for any inconvenience.',
     '<p>Dear {{customer_name}},</p><p>Your support request (<strong>{{ticket_ref}}</strong>) has been escalated to our senior team. We will resolve this within {{resolution_time}}.</p><p>We apologise for any inconvenience.</p>',
     'Escalations')
ON CONFLICT DO NOTHING;

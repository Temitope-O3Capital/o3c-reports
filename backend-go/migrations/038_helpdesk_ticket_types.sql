-- Migration 038: Helpdesk structured ticket types, queues, SLA breach flag,
--                merge tracking, custom fields, CSAT submitted_at, and
--                routing rules + knowledge base tables.
-- Idempotent — safe to re-run.
-- Date: 2026-07-02

-- ── helpdesk_tickets additions ────────────────────────────────────────────────

ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS ticket_type       TEXT;
-- 'general_inquiry','payment_dispute','card_block_request','statement_request',
-- 'loan_inquiry','account_update','complaint','inbound_call','technical_issue'

ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS queue             TEXT;
-- 'general','collections','cards_ops','loans','compliance','management'

ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS sla_breached      BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS merged_into_ticket_id BIGINT
    REFERENCES helpdesk_tickets(id) ON DELETE SET NULL;

ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS custom_fields     JSONB;

ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS csat_submitted_at TIMESTAMPTZ;

-- linked_call_id ties a ticket to its associated inbound/outbound call
ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS linked_call_id   BIGINT
    REFERENCES helpdesk_calls(id) ON DELETE SET NULL;

-- CHECK constraints (wrap in DO so they are idempotent)
DO $$ BEGIN
    ALTER TABLE helpdesk_tickets ADD CONSTRAINT helpdesk_tickets_type_check CHECK (
        ticket_type IN (
            'general_inquiry','payment_dispute','card_block_request',
            'statement_request','loan_inquiry','account_update',
            'complaint','inbound_call','technical_issue'
        )
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE helpdesk_tickets ADD CONSTRAINT helpdesk_tickets_queue_check CHECK (
        queue IN ('general','collections','cards_ops','loans','compliance','management')
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_tickets_type         ON helpdesk_tickets(ticket_type);
CREATE INDEX IF NOT EXISTS idx_tickets_queue        ON helpdesk_tickets(queue);
CREATE INDEX IF NOT EXISTS idx_tickets_sla_breach   ON helpdesk_tickets(sla_breached) WHERE sla_breached = TRUE;
CREATE INDEX IF NOT EXISTS idx_tickets_merged_into  ON helpdesk_tickets(merged_into_ticket_id) WHERE merged_into_ticket_id IS NOT NULL;

-- ── Default SLA due_at based on ticket_type (function + trigger) ───────────────

CREATE OR REPLACE FUNCTION helpdesk_set_sla_from_type()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.sla_due_at IS NULL AND NEW.ticket_type IS NOT NULL THEN
        NEW.sla_due_at := NEW.created_at + CASE NEW.ticket_type
            WHEN 'inbound_call'       THEN INTERVAL '1 hour'
            WHEN 'complaint'          THEN INTERVAL '4 hours'
            WHEN 'card_block_request' THEN INTERVAL '2 hours'
            WHEN 'payment_dispute'    THEN INTERVAL '8 hours'
            WHEN 'statement_request'  THEN INTERVAL '24 hours'
            ELSE                           INTERVAL '8 hours'
        END;
    END IF;
    RETURN NEW;
END;
$$;

DO $$ BEGIN
    CREATE TRIGGER helpdesk_ticket_sla_trigger
    BEFORE INSERT ON helpdesk_tickets
    FOR EACH ROW EXECUTE FUNCTION helpdesk_set_sla_from_type();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Routing rules ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS helpdesk_routing_rules (
    id            BIGSERIAL PRIMARY KEY,
    ticket_type   TEXT,
    channel       TEXT,
    priority      TEXT,
    queue         TEXT NOT NULL,
    assign_to     BIGINT REFERENCES o3c_users(id),
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed default routing rules
INSERT INTO helpdesk_routing_rules (ticket_type, queue) VALUES
    ('inbound_call',       'general'),
    ('complaint',          'management'),
    ('card_block_request', 'cards_ops'),
    ('payment_dispute',    'collections'),
    ('statement_request',  'general'),
    ('loan_inquiry',       'loans'),
    ('account_update',     'general'),
    ('technical_issue',    'general'),
    ('general_inquiry',    'general')
ON CONFLICT DO NOTHING;

-- ── Knowledge base ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS helpdesk_knowledge_base (
    id          BIGSERIAL PRIMARY KEY,
    title       TEXT NOT NULL,
    slug        TEXT NOT NULL UNIQUE,
    category    TEXT,
    body_html   TEXT,
    body_text   TEXT,
    tags        TEXT[] NOT NULL DEFAULT '{}',
    is_public   BOOLEAN NOT NULL DEFAULT FALSE,
    view_count  INTEGER NOT NULL DEFAULT 0,
    created_by  BIGINT REFERENCES o3c_users(id),
    updated_by  BIGINT REFERENCES o3c_users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kb_category  ON helpdesk_knowledge_base(category);
CREATE INDEX IF NOT EXISTS idx_kb_public    ON helpdesk_knowledge_base(is_public) WHERE is_public = TRUE;
CREATE INDEX IF NOT EXISTS idx_kb_fts       ON helpdesk_knowledge_base
    USING gin(to_tsvector('english', coalesce(title,'') || ' ' || coalesce(body_text,'')));

-- Migration 017b: CRM base tables
-- CREATE TABLE IF NOT EXISTS throughout — idempotent on existing schema.
-- Sorts before 018_task_comments.sql, so on an existing DB this is seeded as
-- applied (without running); on a fresh DB it runs first and creates the tables
-- that migration 018 references via FK.

CREATE TABLE IF NOT EXISTS crm_contacts (
    id             BIGSERIAL   PRIMARY KEY,
    first_name     TEXT        NOT NULL,
    last_name      TEXT        NOT NULL,
    phone          TEXT,
    email          TEXT,
    state          TEXT,
    city           TEXT,
    address        TEXT,
    date_of_birth  DATE,
    gender         TEXT,
    occupation     TEXT,
    employer       TEXT,
    income_range   TEXT,
    id_type        TEXT,
    id_number      TEXT,
    source         TEXT,
    cif_number     TEXT,
    status         TEXT        NOT NULL DEFAULT 'lead',
    assigned_to    BIGINT      REFERENCES o3c_users(id) ON DELETE SET NULL,
    created_by     BIGINT      REFERENCES o3c_users(id) ON DELETE SET NULL,
    tags           TEXT,
    notes          TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crm_contacts_assigned ON crm_contacts(assigned_to);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_status   ON crm_contacts(status);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_source   ON crm_contacts(source);

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS crm_pipeline_stages (
    id          BIGSERIAL PRIMARY KEY,
    name        TEXT      NOT NULL,
    color       TEXT,
    is_won      BOOLEAN   NOT NULL DEFAULT FALSE,
    is_lost     BOOLEAN   NOT NULL DEFAULT FALSE,
    order_index INTEGER   NOT NULL DEFAULT 0
);

-- Seed default pipeline stages only when the table is empty (idempotent).
INSERT INTO crm_pipeline_stages (name, color, is_won, is_lost, order_index)
SELECT name, color, is_won, is_lost, order_index
FROM (VALUES
    ('Lead',        '#3B82F6', FALSE, FALSE, 0),
    ('Qualified',   '#8B5CF6', FALSE, FALSE, 1),
    ('Proposal',    '#F59E0B', FALSE, FALSE, 2),
    ('Negotiation', '#EF4444', FALSE, FALSE, 3),
    ('Won',         '#22C55E', TRUE,  FALSE, 4),
    ('Lost',        '#6B7280', FALSE, TRUE,  5)
) AS v(name, color, is_won, is_lost, order_index)
WHERE NOT EXISTS (SELECT 1 FROM crm_pipeline_stages LIMIT 1);

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS crm_deals (
    id                  BIGSERIAL    PRIMARY KEY,
    contact_id          BIGINT       NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
    title               TEXT         NOT NULL,
    stage_id            BIGINT       REFERENCES crm_pipeline_stages(id) ON DELETE SET NULL,
    product             TEXT,
    expected_value      NUMERIC(18,2),
    probability         INTEGER      NOT NULL DEFAULT 50,
    expected_close_date DATE,
    lost_reason         TEXT,
    assigned_to         BIGINT       REFERENCES o3c_users(id) ON DELETE SET NULL,
    created_by          BIGINT       REFERENCES o3c_users(id) ON DELETE SET NULL,
    notes               TEXT,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crm_deals_contact ON crm_deals(contact_id);
CREATE INDEX IF NOT EXISTS idx_crm_deals_stage   ON crm_deals(stage_id);
CREATE INDEX IF NOT EXISTS idx_crm_deals_owner   ON crm_deals(assigned_to);

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS crm_activities (
    id             BIGSERIAL   PRIMARY KEY,
    contact_id     BIGINT      REFERENCES crm_contacts(id) ON DELETE CASCADE,
    deal_id        BIGINT      REFERENCES crm_deals(id)    ON DELETE SET NULL,
    type           TEXT        NOT NULL,
    direction      TEXT,
    subject        TEXT,
    body           TEXT,
    outcome        TEXT,
    duration_mins  INTEGER,
    next_follow_up TIMESTAMPTZ,
    completed      BOOLEAN     NOT NULL DEFAULT FALSE,
    completed_at   TIMESTAMPTZ,
    created_by     BIGINT      REFERENCES o3c_users(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crm_activities_contact ON crm_activities(contact_id);
CREATE INDEX IF NOT EXISTS idx_crm_activities_deal    ON crm_activities(deal_id);

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS crm_tasks (
    id          BIGSERIAL   PRIMARY KEY,
    contact_id  BIGINT      REFERENCES crm_contacts(id) ON DELETE CASCADE,
    deal_id     BIGINT      REFERENCES crm_deals(id)    ON DELETE SET NULL,
    title       TEXT        NOT NULL,
    description TEXT,
    due_date    TIMESTAMPTZ,
    priority    TEXT        NOT NULL DEFAULT 'medium',
    status      TEXT        NOT NULL DEFAULT 'open',
    assigned_to BIGINT      REFERENCES o3c_users(id) ON DELETE SET NULL,
    created_by  BIGINT      REFERENCES o3c_users(id) ON DELETE SET NULL,
    linked_type TEXT,
    linked_id   BIGINT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crm_tasks_assigned ON crm_tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_crm_tasks_contact  ON crm_tasks(contact_id);
CREATE INDEX IF NOT EXISTS idx_crm_tasks_status   ON crm_tasks(status);

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS crm_requests (
    id           BIGSERIAL   PRIMARY KEY,
    contact_id   BIGINT      REFERENCES crm_contacts(id) ON DELETE SET NULL,
    cif_number   TEXT,
    request_type TEXT        NOT NULL DEFAULT 'general',
    subject      TEXT        NOT NULL,
    description  TEXT,
    priority     TEXT        NOT NULL DEFAULT 'medium',
    status       TEXT        NOT NULL DEFAULT 'open',
    sla_hours    INTEGER     NOT NULL DEFAULT 24,
    assigned_to  BIGINT      REFERENCES o3c_users(id) ON DELETE SET NULL,
    escalated_to BIGINT      REFERENCES o3c_users(id) ON DELETE SET NULL,
    created_by   BIGINT      REFERENCES o3c_users(id) ON DELETE SET NULL,
    resolution   TEXT,
    resolved_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crm_requests_contact ON crm_requests(contact_id);
CREATE INDEX IF NOT EXISTS idx_crm_requests_status  ON crm_requests(status);

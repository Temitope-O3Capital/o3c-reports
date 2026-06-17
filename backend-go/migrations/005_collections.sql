-- Collections module tables

CREATE TABLE IF NOT EXISTS collection_assignments (
    id                 BIGSERIAL PRIMARY KEY,
    cif_number         TEXT   NOT NULL,
    agent_user_id      BIGINT NOT NULL,
    assigned_by        BIGINT NOT NULL,
    dpd_bucket         TEXT   NOT NULL DEFAULT '0-30',
    outstanding_kobo   BIGINT NOT NULL DEFAULT 0,
    target_amount_kobo BIGINT NOT NULL DEFAULT 0,
    status             TEXT   NOT NULL DEFAULT 'active',
    created_at         TIMESTAMPTZ DEFAULT NOW(),
    updated_at         TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_coll_assign_agent ON collection_assignments(agent_user_id, status);
CREATE INDEX IF NOT EXISTS idx_coll_assign_cif   ON collection_assignments(cif_number);

CREATE TABLE IF NOT EXISTS collection_contacts (
    id               BIGSERIAL PRIMARY KEY,
    cif_number       TEXT   NOT NULL,
    agent_user_id    BIGINT NOT NULL,
    contact_type     TEXT   NOT NULL,
    outcome          TEXT   NOT NULL,
    notes            TEXT,
    next_action_date DATE,
    created_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_coll_contacts_cif   ON collection_contacts(cif_number, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_coll_contacts_agent ON collection_contacts(agent_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS collection_promises (
    id                   BIGSERIAL PRIMARY KEY,
    cif_number           TEXT   NOT NULL,
    agent_user_id        BIGINT NOT NULL,
    promised_amount_kobo BIGINT NOT NULL,
    promised_date        DATE   NOT NULL,
    actual_amount_kobo   BIGINT,
    actual_date          DATE,
    is_kept              BOOLEAN,
    created_at           TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_coll_ptp_cif   ON collection_promises(cif_number, promised_date);
CREATE INDEX IF NOT EXISTS idx_coll_ptp_agent ON collection_promises(agent_user_id, promised_date);

CREATE TABLE IF NOT EXISTS collection_targets (
    id                 SERIAL  PRIMARY KEY,
    agent_user_id      BIGINT  NOT NULL,
    target_date        DATE    NOT NULL,
    target_amount_kobo BIGINT  NOT NULL,
    actual_amount_kobo BIGINT  NOT NULL DEFAULT 0,
    created_at         TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (agent_user_id, target_date)
);

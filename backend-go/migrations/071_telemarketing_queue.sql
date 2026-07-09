-- Migration 071: Telemarketing outbound queue tables

CREATE TABLE IF NOT EXISTS telemarketing_contacts (
    id                   BIGSERIAL PRIMARY KEY,
    customer_name        TEXT NOT NULL,
    phone                TEXT NOT NULL,
    cif                  TEXT,
    product_name         TEXT,
    priority             TEXT NOT NULL DEFAULT 'Low' CHECK (priority IN ('High', 'Medium', 'Low')),
    outstanding_kobo     BIGINT NOT NULL DEFAULT 0,
    dpd                  INT NOT NULL DEFAULT 0,
    is_existing_customer BOOLEAN NOT NULL DEFAULT FALSE,
    loan_product         TEXT,
    next_payment_date    DATE,
    last_disposition     TEXT,
    last_called_at       TIMESTAMPTZ,
    status               TEXT NOT NULL DEFAULT 'pending',
    assigned_to          BIGINT REFERENCES o3c_users(id),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tm_contacts_status   ON telemarketing_contacts(status, priority DESC, dpd DESC);
CREATE INDEX IF NOT EXISTS idx_tm_contacts_assigned ON telemarketing_contacts(assigned_to);
CREATE INDEX IF NOT EXISTS idx_tm_contacts_phone    ON telemarketing_contacts(phone);

CREATE TABLE IF NOT EXISTS telemarketing_call_logs (
    id               BIGSERIAL PRIMARY KEY,
    contact_id       BIGINT NOT NULL REFERENCES telemarketing_contacts(id) ON DELETE CASCADE,
    agent_id         BIGINT REFERENCES o3c_users(id),
    agent_name       TEXT,
    disposition      TEXT NOT NULL,
    notes            TEXT,
    ptp_date         DATE,
    ptp_amount_kobo  BIGINT,
    duration_seconds INT NOT NULL DEFAULT 0,
    called_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tm_call_logs_contact ON telemarketing_call_logs(contact_id, called_at DESC);

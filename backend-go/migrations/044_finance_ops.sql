-- Migration 044: Finance ops — GL accounts, manual postings, budget, costs, settlements

CREATE TABLE IF NOT EXISTS gl_accounts (
    id              BIGSERIAL PRIMARY KEY,
    code            TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    class           TEXT NOT NULL CHECK (class IN ('Asset','Liability','Income','Expense','Equity')),
    normal_balance  TEXT NOT NULL DEFAULT 'Dr' CHECK (normal_balance IN ('Dr','Cr')),
    currency        TEXT NOT NULL DEFAULT 'NGN',
    parent_id       BIGINT REFERENCES gl_accounts(id),
    is_active       BOOLEAN DEFAULT TRUE,
    created_by      BIGINT REFERENCES o3c_users(id),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gl_accounts_class ON gl_accounts(class);
CREATE INDEX IF NOT EXISTS idx_gl_accounts_parent ON gl_accounts(parent_id);

CREATE TABLE IF NOT EXISTS manual_postings (
    id               BIGSERIAL PRIMARY KEY,
    initiated_at     TIMESTAMPTZ DEFAULT NOW(),
    initiated_by     BIGINT REFERENCES o3c_users(id),
    initiated_by_name TEXT,
    dr_account       TEXT NOT NULL,
    cr_account       TEXT NOT NULL,
    amount_kobo      BIGINT NOT NULL,
    narrative        TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','approved','rejected')),
    approved_by      BIGINT REFERENCES o3c_users(id),
    approved_by_name TEXT,
    approved_at      TIMESTAMPTZ,
    rejection_reason TEXT,
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_manual_postings_status ON manual_postings(status);
CREATE INDEX IF NOT EXISTS idx_manual_postings_initiated_at ON manual_postings(initiated_at DESC);

CREATE TABLE IF NOT EXISTS budget_lines (
    id               BIGSERIAL PRIMARY KEY,
    cost_centre      TEXT NOT NULL,
    category         TEXT NOT NULL,
    period           TEXT NOT NULL,          -- 'YYYY-MM'
    budget_amount    BIGINT NOT NULL DEFAULT 0,   -- kobo
    committed_amount BIGINT NOT NULL DEFAULT 0,
    notes            TEXT,
    created_by       BIGINT REFERENCES o3c_users(id),
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(cost_centre, category, period)
);

CREATE INDEX IF NOT EXISTS idx_budget_lines_period ON budget_lines(period);

CREATE TABLE IF NOT EXISTS cost_entries (
    id                  BIGSERIAL PRIMARY KEY,
    entry_date          DATE NOT NULL,
    department          TEXT NOT NULL,
    category            TEXT NOT NULL,
    description         TEXT NOT NULL,
    amount_kobo         BIGINT NOT NULL,
    budget_amount_kobo  BIGINT NOT NULL DEFAULT 0,
    recorded_by         BIGINT REFERENCES o3c_users(id),
    recorded_by_name    TEXT,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cost_entries_date ON cost_entries(entry_date DESC);
CREATE INDEX IF NOT EXISTS idx_cost_entries_dept ON cost_entries(department);

CREATE TABLE IF NOT EXISTS settlement_batches (
    id              BIGSERIAL PRIMARY KEY,
    batch_date      DATE NOT NULL,
    batch_ref       TEXT UNIQUE,
    batch_type      TEXT NOT NULL DEFAULT 'NIP',
    total_credits   BIGINT NOT NULL DEFAULT 0,
    total_debits    BIGINT NOT NULL DEFAULT 0,
    txn_count       INT NOT NULL DEFAULT 0,
    exception_count INT NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'pending',
    notes           TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_settlement_batches_date ON settlement_batches(batch_date DESC);

CREATE TABLE IF NOT EXISTS settlement_exceptions (
    id               BIGSERIAL PRIMARY KEY,
    batch_id         BIGINT REFERENCES settlement_batches(id),
    txn_date         DATE NOT NULL,
    txn_ref          TEXT,
    amount_kobo      BIGINT NOT NULL,
    exception_type   TEXT NOT NULL,
    description      TEXT,
    status           TEXT NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open','resolved','escalated')),
    resolved_by      BIGINT REFERENCES o3c_users(id),
    resolved_at      TIMESTAMPTZ,
    resolution_note  TEXT,
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_settlement_exceptions_status ON settlement_exceptions(status);
CREATE INDEX IF NOT EXISTS idx_settlement_exceptions_batch ON settlement_exceptions(batch_id);

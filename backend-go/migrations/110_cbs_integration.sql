-- Udara360 CBS integration: read-back snapshot tables + sync audit.
--
-- Udara360 is the system of record for loan/FD money and account state. The sync
-- worker (backend-go/cbssync) spools the full CBS book into these snapshot tables
-- on a schedule; workspace reports read from here (fast, historical, no live CBS
-- load). These tables are refreshed atomically per sync and are NEVER written by
-- workspace workflows -- only by the sync worker. All monetary columns are in kobo
-- (Udara returns kobo, matching the workspace convention).

-- ── Products (loan / fixed-deposit / savings product catalog) ────────────────
CREATE TABLE IF NOT EXISTS cbs_products (
    code           TEXT PRIMARY KEY,       -- Udara product code (e.g. '401')
    name           TEXT,
    type           TEXT,                   -- 'Loan' | 'FixedDeposit' | 'Savings'
    category       TEXT,                   -- 'MicroLoan' | 'FixedDeposit' | ...
    interest_rate  NUMERIC(9,4),           -- annual %, as returned by CBS
    tenure         INTEGER,                -- days (nullable)
    status         TEXT,                   -- 'Active' | ...
    raw            JSONB,                  -- full CBS payload
    synced_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Loan accounts (credit book) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cbs_loans (
    cbs_id                      TEXT PRIMARY KEY,   -- Udara loan record id (GUID; always present/unique)
    cbs_account_number          TEXT,               -- Udara loan account number (may be blank)
    cbs_customer_id             TEXT,               -- Udara customerID
    linked_account              TEXT,               -- disbursement/linked NUBAN
    product_code                TEXT,
    product_name                TEXT,
    status                      TEXT,               -- Active | Expired | Defaulting | Revoked | Closed
    loan_amount_kobo            BIGINT,             -- original disbursed principal
    outstanding_principal_kobo  BIGINT,
    outstanding_interest_kobo   BIGINT,
    outstanding_fee_kobo        BIGINT,
    interest_rate               NUMERIC(9,4),
    tenor_days                  INTEGER,
    start_date                  TIMESTAMPTZ,
    maturity_date               TIMESTAMPTZ,
    officer_name                TEXT,
    raw                         JSONB,
    synced_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cbs_loans_customer ON cbs_loans (cbs_customer_id);
CREATE INDEX IF NOT EXISTS idx_cbs_loans_account  ON cbs_loans (cbs_account_number);
CREATE INDEX IF NOT EXISTS idx_cbs_loans_status   ON cbs_loans (status);
CREATE INDEX IF NOT EXISTS idx_cbs_loans_product  ON cbs_loans (product_code);

-- ── Fixed-deposit accounts ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cbs_fixed_deposits (
    cbs_id                  TEXT PRIMARY KEY,   -- Udara FD record id (GUID; always present/unique)
    cbs_account_number      TEXT,               -- Udara FD account number (may be blank)
    cbs_customer_id         TEXT,
    product_code            TEXT,
    product_name            TEXT,
    status                  TEXT,               -- Active | Closed | ...
    principal_kobo          BIGINT,
    accrued_interest_kobo   BIGINT,
    ledger_balance_kobo     BIGINT,
    interest_rate           NUMERIC(9,4),
    tenor_days              INTEGER,
    commencement_date       TIMESTAMPTZ,
    maturity_date           TIMESTAMPTZ,
    liquidation_account     TEXT,
    raw                     JSONB,
    synced_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cbs_fd_customer ON cbs_fixed_deposits (cbs_customer_id);
CREATE INDEX IF NOT EXISTS idx_cbs_fd_account  ON cbs_fixed_deposits (cbs_account_number);
CREATE INDEX IF NOT EXISTS idx_cbs_fd_status   ON cbs_fixed_deposits (status);
CREATE INDEX IF NOT EXISTS idx_cbs_fd_maturity ON cbs_fixed_deposits (maturity_date);

-- ── Sync audit (one row per sync run) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cbs_sync_runs (
    id            BIGSERIAL PRIMARY KEY,
    kind          TEXT NOT NULL DEFAULT 'scheduled',  -- 'scheduled' | 'manual'
    started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at   TIMESTAMPTZ,
    status        TEXT NOT NULL DEFAULT 'running',    -- 'running' | 'ok' | 'error'
    products_n    INTEGER NOT NULL DEFAULT 0,
    loans_n       INTEGER NOT NULL DEFAULT 0,
    fds_n         INTEGER NOT NULL DEFAULT 0,
    matched_n     INTEGER NOT NULL DEFAULT 0,         -- cbs accounts linked to a workspace record
    unmatched_n   INTEGER NOT NULL DEFAULT 0,         -- cbs accounts with no workspace match
    error         TEXT,
    triggered_by  BIGINT REFERENCES o3c_users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_cbs_sync_runs_started ON cbs_sync_runs (started_at DESC);

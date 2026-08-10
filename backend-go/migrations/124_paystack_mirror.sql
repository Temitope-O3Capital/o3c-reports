-- Paystack mirror: local snapshot of the busiest settlement rail.
--
-- Paystack is live and carries mobile-app funding (in) and app transfers (out).
-- Until now the workspace held NO local copy — every page called the live API with
-- pagination and threw the result away, so there was no history, no aging, no
-- exception queue that survived a refresh, and nothing local to reconcile against.
--
-- The sync worker (backend-go/paystacksync) upserts into these tables on a
-- schedule. Paystack remains the system of record; these tables are only ever
-- written by the sync worker. All monetary columns are in kobo (Paystack returns
-- kobo, matching the workspace convention).

-- ── Inbound: mobile-app funding (card / bank_transfer / ussd …) ──────────────
CREATE TABLE IF NOT EXISTS paystack_transactions (
    id                BIGINT PRIMARY KEY,        -- Paystack transaction id
    reference         TEXT,
    status            TEXT,                      -- success | failed | abandoned | reversed
    channel           TEXT,                      -- card | bank_transfer | ussd | ...
    currency          TEXT NOT NULL DEFAULT 'NGN',
    amount_kobo       BIGINT NOT NULL DEFAULT 0,
    requested_kobo    BIGINT NOT NULL DEFAULT 0, -- differs from amount when part-funded
    fees_kobo         BIGINT NOT NULL DEFAULT 0,
    gateway_response  TEXT,
    paid_at           TIMESTAMPTZ,
    created_at_ps     TIMESTAMPTZ,               -- Paystack's created_at
    customer_id       BIGINT,
    customer_code     TEXT,
    customer_email    TEXT,
    customer_phone    TEXT,
    auth_bank         TEXT,                      -- authorization.bank
    auth_card_type    TEXT,                      -- authorization.card_type
    auth_last4        TEXT,
    ip_address        TEXT,
    raw               JSONB,
    synced_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ps_txn_created  ON paystack_transactions (created_at_ps DESC);
CREATE INDEX IF NOT EXISTS idx_ps_txn_status   ON paystack_transactions (status, created_at_ps DESC);
CREATE INDEX IF NOT EXISTS idx_ps_txn_email    ON paystack_transactions (LOWER(customer_email));
CREATE INDEX IF NOT EXISTS idx_ps_txn_ref      ON paystack_transactions (reference);

-- ── Outbound: app transfers (payouts to customer bank accounts) ──────────────
-- Transfers ride NIP: session.provider = 'nip' with a NIP session id, which is
-- the only genuine NIP visibility the workspace has (there is no NIBSS feed).
CREATE TABLE IF NOT EXISTS paystack_transfers (
    id                BIGINT PRIMARY KEY,        -- Paystack transfer id
    reference         TEXT,
    transfer_code     TEXT,
    status            TEXT,                      -- success | failed | reversed | pending | otp
    currency          TEXT NOT NULL DEFAULT 'NGN',
    amount_kobo       BIGINT NOT NULL DEFAULT 0,
    fee_kobo          BIGINT NOT NULL DEFAULT 0,
    reason            TEXT,                      -- narration shown to the recipient
    failures          TEXT,                      -- populated on failure/reversal
    source            TEXT,                      -- 'balance'
    created_at_ps     TIMESTAMPTZ,
    updated_at_ps     TIMESTAMPTZ,
    transferred_at    TIMESTAMPTZ,
    recipient_code    TEXT,
    recipient_name    TEXT,
    recipient_account TEXT,                      -- NUBAN
    recipient_bank    TEXT,
    recipient_bank_code TEXT,
    session_provider  TEXT,                      -- 'nip'
    session_id        TEXT,                      -- NIP session id — the bank-side handle
    raw               JSONB,
    synced_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ps_trf_created  ON paystack_transfers (created_at_ps DESC);
CREATE INDEX IF NOT EXISTS idx_ps_trf_status   ON paystack_transfers (status, created_at_ps DESC);
CREATE INDEX IF NOT EXISTS idx_ps_trf_account  ON paystack_transfers (recipient_account);
CREATE INDEX IF NOT EXISTS idx_ps_trf_session  ON paystack_transfers (session_id);

-- ── Settlements: Paystack → O3's bank account ───────────────────────────────
CREATE TABLE IF NOT EXISTS paystack_settlements (
    id                  BIGINT PRIMARY KEY,
    status              TEXT,
    currency            TEXT NOT NULL DEFAULT 'NGN',
    total_amount_kobo   BIGINT NOT NULL DEFAULT 0,
    effective_kobo      BIGINT NOT NULL DEFAULT 0,
    total_fees_kobo     BIGINT NOT NULL DEFAULT 0,
    total_processed_kobo BIGINT NOT NULL DEFAULT 0,
    settlement_date     TIMESTAMPTZ,
    created_at_ps       TIMESTAMPTZ,
    updated_at_ps       TIMESTAMPTZ,
    raw                 JSONB,
    synced_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ps_settle_date ON paystack_settlements (settlement_date DESC);

-- ── Disputes / chargebacks ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS paystack_disputes (
    id                 BIGINT PRIMARY KEY,
    status             TEXT,
    resolution         TEXT,
    category           TEXT,
    currency           TEXT NOT NULL DEFAULT 'NGN',
    refund_amount_kobo BIGINT NOT NULL DEFAULT 0,
    transaction_id     BIGINT,
    customer_email     TEXT,
    due_at             TIMESTAMPTZ,
    resolved_at        TIMESTAMPTZ,
    created_at_ps      TIMESTAMPTZ,
    raw                JSONB,
    synced_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ps_dispute_status ON paystack_disputes (status, created_at_ps DESC);

-- ── Sync audit ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS paystack_sync_runs (
    id             BIGSERIAL PRIMARY KEY,
    kind           TEXT NOT NULL DEFAULT 'scheduled',  -- 'scheduled' | 'manual' | 'backfill'
    started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at    TIMESTAMPTZ,
    status         TEXT NOT NULL DEFAULT 'running',    -- 'running' | 'ok' | 'error'
    watermark      TIMESTAMPTZ,                        -- oldest record this run reached back to
    transactions_n INTEGER NOT NULL DEFAULT 0,
    transfers_n    INTEGER NOT NULL DEFAULT 0,
    settlements_n  INTEGER NOT NULL DEFAULT 0,
    disputes_n     INTEGER NOT NULL DEFAULT 0,
    error          TEXT,
    triggered_by   BIGINT REFERENCES o3c_users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_ps_sync_runs_started ON paystack_sync_runs (started_at DESC);

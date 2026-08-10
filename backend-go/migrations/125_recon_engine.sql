-- Reconciliation engine: runs, matches and exceptions.
--
-- Replaces the settlement_exceptions-serves-four-pages arrangement with a model of
-- what reconciliation actually is: ONE SOURCE reconciled against ONE COUNTERPARTY
-- for ONE PERIOD, producing matches (with the tier and confidence that produced
-- them) and exceptions (with a reason, an owner and an age).
--
-- The source/counterparty pair is deliberately open text so new pairs plug in
-- without schema change — interswitch↔sage_ledger today; paystack↔sage_ledger and
-- paystack↔mobile_wallet when the wallet ledger becomes readable.
--
-- Matching NEVER picks one of several candidates. A source row with more than one
-- candidate becomes an 'ambiguous' exception for a human, because a plausible-looking
-- wrong pairing is worse than an unmatched row.

CREATE TABLE IF NOT EXISTS recon_runs (
    id                   BIGSERIAL PRIMARY KEY,
    source               TEXT NOT NULL,              -- 'interswitch' | 'paystack_transactions' | ...
    counterparty         TEXT NOT NULL,              -- 'sage_ledger' | 'mobile_wallet' | ...
    period_from          DATE NOT NULL,
    period_to            DATE NOT NULL,
    kind                 TEXT NOT NULL DEFAULT 'manual',   -- 'manual' | 'scheduled'
    status               TEXT NOT NULL DEFAULT 'running',  -- 'running' | 'ok' | 'error'
    started_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at          TIMESTAMPTZ,
    error                TEXT,

    source_n             INTEGER NOT NULL DEFAULT 0,
    matched_n            INTEGER NOT NULL DEFAULT 0,
    ambiguous_n          INTEGER NOT NULL DEFAULT 0,
    unmatched_n          INTEGER NOT NULL DEFAULT 0,
    source_value_kobo    BIGINT  NOT NULL DEFAULT 0,
    matched_value_kobo   BIGINT  NOT NULL DEFAULT 0,
    unmatched_value_kobo BIGINT  NOT NULL DEFAULT 0,

    triggered_by         BIGINT REFERENCES o3c_users(id) ON DELETE SET NULL,
    -- Daily sign-off: the artifact that makes a reconciliation defensible.
    signed_off_by        BIGINT REFERENCES o3c_users(id) ON DELETE SET NULL,
    signed_off_at        TIMESTAMPTZ,
    signoff_note         TEXT
);
CREATE INDEX IF NOT EXISTS idx_recon_runs_started ON recon_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_recon_runs_pair    ON recon_runs (source, counterparty, period_from DESC);

CREATE TABLE IF NOT EXISTS recon_matches (
    id               BIGSERIAL PRIMARY KEY,
    run_id           BIGINT NOT NULL REFERENCES recon_runs(id) ON DELETE CASCADE,
    source_key       TEXT NOT NULL,     -- e.g. interswitch_txns.id
    counterparty_key TEXT NOT NULL,     -- e.g. core.transaction.txn_id
    txn_date         DATE,
    amount_kobo      BIGINT NOT NULL DEFAULT 0,
    tier             TEXT NOT NULL,     -- which rule matched (auditable)
    confidence       NUMERIC(4,3) NOT NULL DEFAULT 1.0,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_recon_matches_run  ON recon_matches (run_id);
CREATE INDEX IF NOT EXISTS idx_recon_matches_src  ON recon_matches (source_key);
CREATE INDEX IF NOT EXISTS idx_recon_matches_cpk  ON recon_matches (counterparty_key);
-- A ledger row may be consumed by at most one source row within a run.
CREATE UNIQUE INDEX IF NOT EXISTS uq_recon_matches_run_cpk ON recon_matches (run_id, counterparty_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_recon_matches_run_src ON recon_matches (run_id, source_key);

CREATE TABLE IF NOT EXISTS recon_exceptions (
    id              BIGSERIAL PRIMARY KEY,
    run_id          BIGINT NOT NULL REFERENCES recon_runs(id) ON DELETE CASCADE,
    source          TEXT NOT NULL,
    source_key      TEXT NOT NULL,
    source_ref      TEXT,              -- human handle: trace / reference
    txn_date        DATE,
    amount_kobo     BIGINT NOT NULL DEFAULT 0,
    reason          TEXT NOT NULL,     -- 'no_candidate' | 'ambiguous'
    candidate_n     INTEGER NOT NULL DEFAULT 0,
    detail          TEXT,

    status          TEXT NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open','investigating','resolved','written_off')),
    assigned_to     BIGINT REFERENCES o3c_users(id) ON DELETE SET NULL,
    resolution_code TEXT,              -- reason code, not free text alone
    resolution_note TEXT,
    resolved_by     BIGINT REFERENCES o3c_users(id) ON DELETE SET NULL,
    resolved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_recon_exc_run     ON recon_exceptions (run_id);
CREATE INDEX IF NOT EXISTS idx_recon_exc_open    ON recon_exceptions (status, created_at)
    WHERE status IN ('open','investigating');
CREATE INDEX IF NOT EXISTS idx_recon_exc_assigned ON recon_exceptions (assigned_to, status);

-- Supporting indexes on the Sage ledger for the matcher (created here so a fresh
-- deployment reconciles at speed rather than sequential-scanning 1M rows).
CREATE INDEX IF NOT EXISTS idx_core_txn_trace    ON core.transaction (trace);
CREATE INDEX IF NOT EXISTS idx_core_txn_cif_date ON core.transaction (cif, txn_date);

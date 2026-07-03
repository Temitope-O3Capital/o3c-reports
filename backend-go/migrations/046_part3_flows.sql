-- Migration 046: Part 3 workflow gaps
--   1. collection_assignments: add columns the handler already references
--   2. recovery_cases: add source_assignment_id + dpd_at_handoff for collections hand-off
--   3. fd_early_withdrawal_requests: FD early withdrawal approval workflow

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. collection_assignments — handler (collections_ops.go) reads account_cif,
--    current_stage, assignment_date but the 005 schema only has cif_number.
--    Add alias columns; backfill account_cif from cif_number.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE collection_assignments
  ADD COLUMN IF NOT EXISTS account_cif      TEXT,
  ADD COLUMN IF NOT EXISTS current_stage    TEXT,
  ADD COLUMN IF NOT EXISTS assignment_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  ADD COLUMN IF NOT EXISTS notes            TEXT;

-- Backfill account_cif from existing cif_number where still null
UPDATE collection_assignments SET account_cif = cif_number WHERE account_cif IS NULL;

CREATE INDEX IF NOT EXISTS idx_coll_assign_account_cif ON collection_assignments(account_cif);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. recovery_cases — add source_assignment_id and dpd_at_handoff
--    to track which collection assignment triggered this case
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE recovery_cases
  ADD COLUMN IF NOT EXISTS source_assignment_id BIGINT REFERENCES collection_assignments(id),
  ADD COLUMN IF NOT EXISTS dpd_at_handoff        TEXT;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. fd_transactions — base FD ledger (guard: 044 may have already applied it)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fd_transactions (
  id               BIGSERIAL PRIMARY KEY,
  transaction_date DATE NOT NULL,
  customer_name    TEXT NOT NULL,
  transaction_type TEXT NOT NULL DEFAULT 'inflow'
                       CHECK (transaction_type IN ('inflow','outflow','liquidation','rolled_over')),
  principal        NUMERIC,
  interest_paid    NUMERIC,
  gross_amount     NUMERIC,
  usd_amount       NUMERIC,
  ngn_amount       NUMERIC,
  currency         TEXT NOT NULL DEFAULT 'NGN',
  location         TEXT,
  account_officer  TEXT,
  maturity_date    DATE,
  tenor_days       INT,
  rate             NUMERIC,
  notes            TEXT,
  created_by       BIGINT REFERENCES o3c_users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fd_txn_date     ON fd_transactions(transaction_date DESC);
CREATE INDEX IF NOT EXISTS idx_fd_txn_type     ON fd_transactions(transaction_type);
CREATE INDEX IF NOT EXISTS idx_fd_txn_maturity ON fd_transactions(maturity_date);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. fd_early_withdrawal_requests — early withdrawal approval flow
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fd_early_withdrawal_requests (
  id                  BIGSERIAL PRIMARY KEY,
  fd_transaction_id   BIGINT NOT NULL REFERENCES fd_transactions(id),
  requested_by        BIGINT REFERENCES o3c_users(id),
  approved_by         BIGINT REFERENCES o3c_users(id),
  status              TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','approved','rejected')),
  principal_kobo      BIGINT NOT NULL,
  penalty_kobo        BIGINT NOT NULL DEFAULT 0,
  net_payout_kobo     BIGINT NOT NULL,
  rejection_reason    TEXT,
  approved_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fd_ew_req_fd  ON fd_early_withdrawal_requests(fd_transaction_id);
CREATE INDEX IF NOT EXISTS idx_fd_ew_req_status ON fd_early_withdrawal_requests(status);

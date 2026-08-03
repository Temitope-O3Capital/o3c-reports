-- 115_card_ops_tables.sql
-- Formalize the card-operations tables that were previously created only at runtime
-- by ensureCardOpsSchema() in handlers/card_ops.go. Bringing them under a numbered,
-- idempotent migration gives Cards structural parity with the lending tables
-- (versioned, reviewable, indexed by migration) instead of ad-hoc runtime DDL.
-- All statements are IF NOT EXISTS so this is safe alongside the runtime bootstrap.

CREATE TABLE IF NOT EXISTS card_blocks (
  id BIGSERIAL PRIMARY KEY,
  cif_number TEXT NOT NULL,
  blocked_by BIGINT REFERENCES o3c_users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL DEFAULT '',
  is_blocked BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  unblocked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_card_blocks_cif ON card_blocks(cif_number, is_blocked);

CREATE TABLE IF NOT EXISTS card_issuance_requests (
  id BIGSERIAL PRIMARY KEY,
  cif_number TEXT NOT NULL DEFAULT '',
  customer_name TEXT NOT NULL DEFAULT '',
  card_type TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  submitted_by BIGINT REFERENCES o3c_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_card_iss_status ON card_issuance_requests(status, created_at DESC);

CREATE TABLE IF NOT EXISTS card_disputes (
  id BIGSERIAL PRIMARY KEY,
  cif_number TEXT NOT NULL DEFAULT '',
  customer_name TEXT NOT NULL DEFAULT '',
  card_type TEXT NOT NULL DEFAULT '',
  amount_kobo BIGINT NOT NULL DEFAULT 0,
  dispute_type TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'filed',
  filed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_card_dsp_status ON card_disputes(status, filed_at DESC);

CREATE TABLE IF NOT EXISTS card_credit_limit_reviews (
  id BIGSERIAL PRIMARY KEY,
  cif_number TEXT NOT NULL DEFAULT '',
  customer_name TEXT NOT NULL DEFAULT '',
  card_type TEXT NOT NULL DEFAULT '',
  current_limit_kobo BIGINT NOT NULL DEFAULT 0,
  proposed_limit_kobo BIGINT NOT NULL DEFAULT 0,
  utilization_pct INT NOT NULL DEFAULT 0,
  eye_score INT NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending_review',
  recommended_by TEXT NOT NULL DEFAULT '',
  decided_by BIGINT REFERENCES o3c_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_card_clr_status ON card_credit_limit_reviews(status, created_at DESC);

CREATE TABLE IF NOT EXISTS card_billing_cycles (
  id BIGSERIAL PRIMARY KEY,
  product TEXT NOT NULL,
  cycle_start DATE NOT NULL,
  cycle_end DATE NOT NULL,
  accounts_count INT NOT NULL DEFAULT 0,
  total_balance_kobo BIGINT NOT NULL DEFAULT 0,
  statements_generated INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(product, cycle_start)
);
CREATE INDEX IF NOT EXISTS idx_card_billing ON card_billing_cycles(cycle_start DESC);

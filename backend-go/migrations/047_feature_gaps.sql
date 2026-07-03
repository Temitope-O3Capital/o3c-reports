-- Migration 047: Feature gaps — LOS credit assessment, repayment plans

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. loan_applications: credit assessment fields for Risk Officer input
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE loan_applications
  ADD COLUMN IF NOT EXISTS eye_score         INT,
  ADD COLUMN IF NOT EXISTS eye_rating        TEXT,
  ADD COLUMN IF NOT EXISTS bureau_summary    TEXT,
  ADD COLUMN IF NOT EXISTS dti_pct           NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS monthly_income_kobo BIGINT,
  ADD COLUMN IF NOT EXISTS monthly_obligation_kobo BIGINT;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. repayment_plans — structured multi-instalment arrangements
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS repayment_plans (
  id              BIGSERIAL PRIMARY KEY,
  account_cif     TEXT NOT NULL,
  customer_name   TEXT,
  agent_user_id   BIGINT REFERENCES o3c_users(id),
  total_kobo      BIGINT NOT NULL,
  paid_kobo       BIGINT NOT NULL DEFAULT 0,
  instalment_count INT NOT NULL DEFAULT 1,
  paid_count      INT NOT NULL DEFAULT 0,
  next_payment_date DATE,
  status          TEXT NOT NULL DEFAULT 'Active'
                      CHECK (status IN ('Active','Completed','Defaulted')),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rp_cif    ON repayment_plans(account_cif);
CREATE INDEX IF NOT EXISTS idx_rp_status ON repayment_plans(status);
CREATE INDEX IF NOT EXISTS idx_rp_agent  ON repayment_plans(agent_user_id);

CREATE TABLE IF NOT EXISTS repayment_instalments (
  id                BIGSERIAL PRIMARY KEY,
  plan_id           BIGINT NOT NULL REFERENCES repayment_plans(id) ON DELETE CASCADE,
  instalment_number INT NOT NULL,
  due_date          DATE NOT NULL,
  amount_kobo       BIGINT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'Pending'
                        CHECK (status IN ('Pending','Paid','Missed')),
  paid_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ri_plan ON repayment_instalments(plan_id, instalment_number);

-- Migration 041: Business Development module

CREATE TABLE IF NOT EXISTS employers (
  id                   BIGSERIAL PRIMARY KEY,
  name                 TEXT NOT NULL,
  sector               TEXT,
  staff_count          INT,
  monthly_payroll_kobo BIGINT DEFAULT 0,
  credit_limit_kobo    BIGINT DEFAULT 0,
  mou_status           TEXT DEFAULT 'none', -- none, negotiating, signed, expired
  mou_date             DATE,
  mou_expiry           DATE,
  contact_name         TEXT,
  contact_phone        TEXT,
  contact_email        TEXT,
  address              TEXT,
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  notes                TEXT,
  created_by           BIGINT REFERENCES o3c_users(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bd_leads (
  id                   BIGSERIAL PRIMARY KEY,
  title                TEXT NOT NULL,
  company_name         TEXT,
  employer_id          BIGINT REFERENCES employers(id),
  stage                TEXT NOT NULL DEFAULT 'prospect', -- prospect, qualified, proposal, negotiation, won, lost
  potential_value_kobo BIGINT DEFAULT 0,
  lead_type            TEXT, -- salary_advance, business_loan, card_product, fixed_deposit
  contact_name         TEXT,
  contact_phone        TEXT,
  contact_email        TEXT,
  assigned_to          BIGINT REFERENCES o3c_users(id),
  expected_close_date  DATE,
  notes                TEXT,
  created_by           BIGINT REFERENCES o3c_users(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bd_activities (
  id            BIGSERIAL PRIMARY KEY,
  lead_id       BIGINT NOT NULL REFERENCES bd_leads(id),
  agent_id      BIGINT NOT NULL REFERENCES o3c_users(id),
  activity_type TEXT NOT NULL, -- call, meeting, email, proposal_sent, follow_up
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_employers_mou      ON employers(mou_status);
CREATE INDEX IF NOT EXISTS idx_employers_active   ON employers(is_active);
CREATE INDEX IF NOT EXISTS idx_bd_leads_stage     ON bd_leads(stage);
CREATE INDEX IF NOT EXISTS idx_bd_leads_assigned  ON bd_leads(assigned_to);
CREATE INDEX IF NOT EXISTS idx_bd_activities_lead ON bd_activities(lead_id);

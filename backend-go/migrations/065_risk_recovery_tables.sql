-- Migration 065: Tables for Risk + Recovery completeness
--   1. tpa_agencies — Third-Party Collection Agencies
--   2. legal_milestones — milestone tracking for legal recovery cases
--   3. risk_band + applicant_name aliases on loan_applications

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. tpa_agencies
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tpa_agencies (
  id                    BIGSERIAL PRIMARY KEY,
  name                  TEXT    NOT NULL,
  licence_no            TEXT,
  address               TEXT,
  commission_pct        NUMERIC(5,2) NOT NULL DEFAULT 0,
  contact_name          TEXT,
  contact_phone         TEXT,
  active                BOOLEAN NOT NULL DEFAULT true,
  created_by            BIGINT  REFERENCES o3c_users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tpa_agencies_active ON tpa_agencies(active);

-- Link recovery cases to a TPA agency
ALTER TABLE recovery_cases ADD COLUMN IF NOT EXISTS tpa_agency_id BIGINT REFERENCES tpa_agencies(id);
CREATE INDEX IF NOT EXISTS idx_recovery_cases_tpa ON recovery_cases(tpa_agency_id) WHERE tpa_agency_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. legal_milestones — inline timeline per recovery case
--    (legal_proceedings tracks formal court filings; milestones track progress)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS legal_milestones (
  id             BIGSERIAL PRIMARY KEY,
  case_id        BIGINT  NOT NULL REFERENCES recovery_cases(id) ON DELETE CASCADE,
  milestone      TEXT    NOT NULL,
  milestone_date DATE,
  note           TEXT,
  completed      BOOLEAN NOT NULL DEFAULT true,
  created_by     BIGINT  REFERENCES o3c_users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_legal_milestones_case ON legal_milestones(case_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. loan_applications: add risk_band + applicant_name for risk module
--    (eye_score already added in 047; risk_band is new)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS risk_band       TEXT;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS applicant_name  TEXT;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS submitted_at    TIMESTAMPTZ;

-- Backfill applicant_name from first_name + last_name where available
UPDATE loan_applications
  SET applicant_name = TRIM(first_name || ' ' || last_name)
  WHERE applicant_name IS NULL AND (first_name <> '' OR last_name <> '');

-- Backfill submitted_at from created_at where null
UPDATE loan_applications SET submitted_at = created_at WHERE submitted_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. recovery_cases: add solicitor column for legal tracker display
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE recovery_cases ADD COLUMN IF NOT EXISTS solicitor TEXT;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. debt_sales — bulk portfolio sales to debt buyers
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS debt_sales (
  id                     BIGSERIAL PRIMARY KEY,
  buyer_name             TEXT    NOT NULL,
  sale_date              DATE    NOT NULL,
  account_count          INT     NOT NULL DEFAULT 0,
  face_value_kobo        BIGINT  NOT NULL DEFAULT 0,
  sale_price_kobo        BIGINT  NOT NULL DEFAULT 0,
  recovery_post_sale_kobo BIGINT NOT NULL DEFAULT 0,
  notes                  TEXT,
  created_by             BIGINT  REFERENCES o3c_users(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_debt_sales_date ON debt_sales(sale_date DESC);

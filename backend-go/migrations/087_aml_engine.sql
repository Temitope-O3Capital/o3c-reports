-- R5: AML rule engine — configurable threshold rules that auto-flag transactions.

CREATE TABLE IF NOT EXISTS aml_rules (
  id           BIGSERIAL PRIMARY KEY,
  name         TEXT        NOT NULL,
  rule_type    TEXT        NOT NULL CHECK (rule_type IN ('amount_threshold','velocity_daily','velocity_monthly','counterparty_watchlist')),
  threshold    BIGINT,                     -- kobo for amount rules, count for velocity
  period_days  INT,                        -- rolling window for velocity rules
  severity     TEXT        NOT NULL DEFAULT 'medium' CHECK (severity IN ('low','medium','high','critical')),
  enabled      BOOLEAN     NOT NULL DEFAULT TRUE,
  created_by   BIGINT      REFERENCES o3c_users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS aml_flags (
  id           BIGSERIAL PRIMARY KEY,
  rule_id      BIGINT      NOT NULL REFERENCES aml_rules(id),
  cif          TEXT        NOT NULL,
  customer_name TEXT,
  triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  amount_kobo  BIGINT,
  transaction_ref TEXT,
  details      JSONB       NOT NULL DEFAULT '{}',
  status       TEXT        NOT NULL DEFAULT 'open' CHECK (status IN ('open','under_review','cleared','escalated','sar_filed')),
  reviewed_by  BIGINT      REFERENCES o3c_users(id),
  reviewed_at  TIMESTAMPTZ,
  notes        TEXT
);

CREATE INDEX IF NOT EXISTS idx_aml_flags_cif         ON aml_flags(cif);
CREATE INDEX IF NOT EXISTS idx_aml_flags_status       ON aml_flags(status);
CREATE INDEX IF NOT EXISTS idx_aml_flags_triggered_at ON aml_flags(triggered_at DESC);

-- Default rules matching CBN AML guidelines
INSERT INTO aml_rules (name, rule_type, threshold, period_days, severity, enabled) VALUES
  ('Large cash transaction > ₦5M',  'amount_threshold', 500000000, NULL, 'high',     TRUE),
  ('Daily velocity > 5 transactions','velocity_daily',   5,         1,    'medium',   TRUE),
  ('Monthly cash > ₦50M',           'amount_threshold', 5000000000,NULL, 'critical', TRUE)
ON CONFLICT DO NOTHING;

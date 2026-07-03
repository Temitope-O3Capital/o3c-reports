-- 049: Fee income table for granular fee-type tracking
-- Stores membership, re-issue, maintenance, joining and blink fee income
-- per account per date. Populated from a transaction-level fee report
-- (not available in cyc_chg_rpt which only has aggregate FEES).
-- Re-importable via upsert on (fee_date, account_number, fee_type).

CREATE TABLE IF NOT EXISTS fee_income (
  id             BIGSERIAL   PRIMARY KEY,
  fee_date       DATE        NOT NULL,
  fee_type       TEXT        NOT NULL CHECK (fee_type IN ('membership','reissue','maintenance','joining','blink','other')),
  product_code   VARCHAR(3),
  account_number TEXT        NOT NULL,
  cif            TEXT,
  currency       VARCHAR(3)  NOT NULL DEFAULT 'NGN',
  amount_kobo    BIGINT      NOT NULL DEFAULT 0,
  ref            TEXT,
  imported_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (fee_date, account_number, fee_type)
);

CREATE INDEX IF NOT EXISTS idx_fee_income_date      ON fee_income(fee_date);
CREATE INDEX IF NOT EXISTS idx_fee_income_type      ON fee_income(fee_type);
CREATE INDEX IF NOT EXISTS idx_fee_income_product   ON fee_income(product_code);
CREATE INDEX IF NOT EXISTS idx_fee_income_account   ON fee_income(account_number);

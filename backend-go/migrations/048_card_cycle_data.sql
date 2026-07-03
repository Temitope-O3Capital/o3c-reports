-- 048: Card products reference table + live cycle data feed
-- card_products holds all 37 products (active + inactive); product_code maps to cycle report Apnum
-- card_cycle_data receives monthly cycle files — one row per account per billing cycle, re-importable via upsert

CREATE TABLE IF NOT EXISTS card_products (
  id            SERIAL PRIMARY KEY,
  product_code  VARCHAR(3),                -- cycle system Apnum (NULL for products not yet in cycle system)
  product_name  TEXT        NOT NULL,      -- canonical display name
  system_name   TEXT,                      -- legacy name as it appears in cycle reports
  category      TEXT        NOT NULL CHECK (category IN ('prepaid', 'credit')),
  card_type     TEXT        NOT NULL CHECK (card_type IN ('physical', 'virtual')),
  is_active     BOOLEAN     NOT NULL DEFAULT false,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (product_code),
  UNIQUE (product_name)
);

-- Seed all 37 products (active first, then inactive with cycle codes, then inactive without codes)
INSERT INTO card_products (product_code, product_name, system_name, category, card_type, is_active, notes) VALUES
  -- ── ACTIVE ────────────────────────────────────────────────────────────────────
  ('120', 'BB Classic Card',          'BB Classic Account',             'credit',  'physical', true,  NULL),
  ('160', 'Business Card',            'Business Accounts',              'credit',  'physical', true,  NULL),
  ('100', 'Classic Card',             'Classic Accounts',               'credit',  'physical', true,  NULL),
  ('200', 'Classic Card Contactless', 'Classic Accounts- Contactless',  'credit',  'physical', true,  'Contactless'),
  ('150', 'Corporate Card',           'Corporate Accounts',             'credit',  'physical', true,  NULL),
  ('405', 'Financial Inclusion',      'Financial Inclusion Account',    'prepaid', 'physical', true,  'Pinless'),
  ('105', 'Platinum Card',            'Platinum Accounts',              'credit',  'physical', true,  NULL),
  ('205', 'PREP',                     'PREP',                           'prepaid', 'physical', true,  NULL),
  ('003', 'PREP Temporary Virtual',   'PREP Temporary Virtual',         'prepaid', 'virtual',  true,  'Blink'),
  ('110', 'Prestige Card',            'Prestige Accounts',              'credit',  'physical', true,  NULL),
  -- ── INACTIVE — with cycle codes ───────────────────────────────────────────────
  ('001', 'O3 Green Naira',           'Amex Naira',                     'prepaid', 'physical', false, NULL),
  ('002', 'O3 Green USD',             'Amex USD',                       'prepaid', 'physical', false, NULL),
  ('115', 'AIRTEL',                   'AIRTEL',                         'credit',  'physical', false, NULL),
  ('165', 'Business Card 2',          'Business Account 2',             'credit',  'virtual',  false, 'Loan'),
  ('166', 'Business Instalment 1',    'Business Account  Instalment 1', 'credit',  'virtual',  false, 'Loan'),
  ('167', 'Business Instalment 2',    'Business Account Instalment 2',  'credit',  'virtual',  false, 'Loan'),
  ('168', 'Business Instalment 3',    'Business Account Instalment 3',  'credit',  'virtual',  false, 'Loan'),
  ('101', 'FINTRACK Charge Card',     'Charge Accounts',                'credit',  'physical', false, NULL),
  ('350', 'Fixed Classic Card',       'Fixed Classic Accounts',         'credit',  'physical', false, NULL),
  ('310', 'GAME',                     'GAME',                           'credit',  'physical', false, NULL),
  ('170', 'INSIGHT COOP Card',        'INSIGHT COOP Account',           'credit',  'physical', false, NULL),
  ('410', 'LBIC COOP Credit',         'LBIC COOP ACCOUNT',              'credit',  'physical', false, NULL),
  ('220', 'LIRS COOP Card',           'LIRS COOP Account',              'credit',  'physical', false, NULL),
  ('210', 'MEMCOS',                   'MEMCOS',                         'credit',  'physical', false, NULL),
  ('305', 'NIMCOS',                   'NIMCOS',                         'credit',  'physical', false, NULL),
  ('301', 'NOHIL COOP',               'NOHIL COOP Accounts',            'credit',  'physical', false, NULL),
  ('415', 'SSANU-UI',                 'SSANU-UI Account',               'credit',  'physical', false, NULL),
  -- ── INACTIVE — no cycle code yet ──────────────────────────────────────────────
  (NULL,  'O3 Gold Business Naira',   'Amex gold business naira',       'credit',  'physical', false, NULL),
  (NULL,  'O3 Gold Business USD',     'Amex gold business usd',         'credit',  'physical', false, NULL),
  (NULL,  'O3 Gold Naira',            'Amex gold naira',                'credit',  'physical', false, NULL),
  (NULL,  'O3 Gold USD',              'Amex gold usd',                  'credit',  'physical', false, NULL),
  (NULL,  'O3 Green (legacy)',        'Amex green',                     'prepaid', 'physical', false, NULL),
  (NULL,  'O3 Platinum Naira',        'Amex platinum naira',            'credit',  'physical', false, NULL),
  (NULL,  'O3 Platinum USD',          'Amex platinum usd',              'credit',  'physical', false, NULL),
  (NULL,  'O3 Green Virtual',         'Amex green virtual',             'prepaid', 'virtual',  false, NULL),
  (NULL,  'Business Instalment 4',    'Business instalment 4',          'credit',  'virtual',  false, 'Loan'),
  (NULL,  'Classic Card ABJ',         'Classic Card ABJ',               'credit',  'physical', false, NULL),
  (NULL,  'O3c Gift Card',            'O3c GIFT CARD',                  'credit',  'physical', false, NULL),
  (NULL,  'PREP Pre-Issued',          'PREP Pre Issued',                'prepaid', 'physical', false, 'Pre-issued cards')
ON CONFLICT (product_name) DO NOTHING;

-- ── Live cycle data feed ───────────────────────────────────────────────────────
-- Receives monthly billing cycle files from the card processing system.
-- Unique on (cycle_date, account_number) so re-importing the same month is safe via upsert.

CREATE TABLE IF NOT EXISTS card_cycle_data (
  id                       BIGSERIAL PRIMARY KEY,
  cycle_date               DATE        NOT NULL,
  product_code             VARCHAR(3)  NOT NULL,
  cif                      TEXT        NOT NULL,
  account_number           TEXT        NOT NULL,
  currency                 VARCHAR(3)  NOT NULL DEFAULT 'NGN',
  -- From cyc_bal_rpt
  billed_balance_kobo      BIGINT      NOT NULL DEFAULT 0,
  current_balance_kobo     BIGINT      NOT NULL DEFAULT 0,
  outstanding_balance_kobo BIGINT      NOT NULL DEFAULT 0,
  overdue_amount_kobo      BIGINT      NOT NULL DEFAULT 0,
  minimum_payment_kobo     BIGINT      NOT NULL DEFAULT 0,
  total_payment_kobo       BIGINT      NOT NULL DEFAULT 0,
  -- From cyc_chg_rpt
  fees_kobo                BIGINT      NOT NULL DEFAULT 0,
  interest_charged_kobo    BIGINT      NOT NULL DEFAULT 0,
  penalty_kobo             BIGINT      NOT NULL DEFAULT 0,
  purchase_amount_kobo     BIGINT      NOT NULL DEFAULT 0,
  cash_advance_kobo        BIGINT      NOT NULL DEFAULT 0,
  -- From cyc_int_rpt
  total_interest_kobo      BIGINT      NOT NULL DEFAULT 0,
  -- From cyc_loc_rpt
  credit_limit_kobo        BIGINT      NOT NULL DEFAULT 0,
  loc_change_kobo          BIGINT      NOT NULL DEFAULT 0,
  temp_loc_kobo            BIGINT      NOT NULL DEFAULT 0,
  -- Metadata
  imported_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (cycle_date, account_number)
);

CREATE INDEX IF NOT EXISTS idx_ccd_cycle_date   ON card_cycle_data(cycle_date);
CREATE INDEX IF NOT EXISTS idx_ccd_cif          ON card_cycle_data(cif);
CREATE INDEX IF NOT EXISTS idx_ccd_product      ON card_cycle_data(product_code);
CREATE INDEX IF NOT EXISTS idx_ccd_account      ON card_cycle_data(account_number);
CREATE INDEX IF NOT EXISTS idx_ccd_outstanding  ON card_cycle_data(cycle_date, outstanding_balance_kobo);

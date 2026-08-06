-- feed.* : owned system of record, seeded once from Sage, then fed by the repo.
CREATE SCHEMA IF NOT EXISTS feed;

CREATE TABLE IF NOT EXISTS feed.customers (
  cif               text PRIMARY KEY,
  first_name        text,
  middle_name       text,
  last_name         text,
  full_name         text,
  email             text,
  phone             text,        -- digits-only, normalized
  phone_raw         text,
  address_1         text,
  address_2         text,
  address_3         text,
  city              text,
  state             text,
  country           text,
  gender            text,
  nationality       text,
  bvn               text,
  account_status    text,
  source            text NOT NULL DEFAULT 'sage_backfill',
  source_updated_at timestamptz,
  ingested_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feed.card_products (
  product_name  text PRIMARY KEY,
  product_line  text,           -- credit_card / prepaid / deposit / other
  account_count int
);

CREATE TABLE IF NOT EXISTS feed.accounts (
  account_no           text PRIMARY KEY,
  cif                  text,
  product_name         text,
  product_line         text,
  status               text,
  card_number_masked   text,
  name_on_card         text,
  card_limit_kobo      bigint,
  cycle_balance_kobo   bigint,
  current_balance_kobo bigint,
  card_issue_date      date,
  card_expiry_date     date,
  payment_due_date     date,
  source               text NOT NULL DEFAULT 'sage_backfill',
  source_updated_at    timestamptz,
  ingested_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feed.transactions (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,  -- our own id
  dedup_key     text UNIQUE NOT NULL,                             -- 'sage:<id>' backfill / composite for feed
  sage_txn_id   bigint,                                           -- Transaction_Listing_Id cross-ref
  account_no    text,
  cif           text,
  post_date     date,
  txn_date      date,
  txn_code      text,
  description   text,
  channel       text,           -- interswitch / collection / internal
  amount_kobo   bigint NOT NULL,
  fees_kobo     bigint,
  trace         text,
  merchant_name text,
  mcc           text,
  city          text,
  source        text NOT NULL DEFAULT 'sage_backfill',
  ingested_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_feed_txn_date    ON feed.transactions (txn_date);
CREATE INDEX IF NOT EXISTS ix_feed_txn_cif     ON feed.transactions (cif);
CREATE INDEX IF NOT EXISTS ix_feed_txn_account ON feed.transactions (account_no);
CREATE INDEX IF NOT EXISTS ix_feed_acct_cif    ON feed.accounts (cif);

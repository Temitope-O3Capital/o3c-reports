-- Columns for the feed fields the loaders parse past and drop on the floor.
--
-- Every field below was verified against the retained drops on E:\ before a
-- column was added for it — the decoded column maps in
-- docs/DATA_FEED_INGESTION.md carry "⁇" on most of these, and two of the
-- guesses there are wrong.
--
-- acct_file field 7 is the CURRENCY, not the branch code the doc calls it.
-- Evidence: across a 30-file sample of the 2026 drops the only values are 566
-- (199,521 rows) and 840 (984 rows), plus two junk cells; every single 840 row
-- carries product 'Amex USD'; and 566 appears against account numbers ending
-- 324/342/343/345/347/350/355/368/369 as well as 566, which is what rules the
-- branch-code reading out. 566/840 are the ISO-4217 numeric codes for NGN/USD.
--
-- This matters beyond tidiness: neither app.accounts nor app.transactions has
-- ever carried a currency, so every SUM(amount) in the app has been adding
-- dollars to naira as though they were one unit. currency_code is what lets
-- those totals be split.
--
-- acct_file field 4 is a status code (values 1,2,3,4,6). It is stored RAW and
-- deliberately does NOT feed app.accounts.status: correlating 400 drop files
-- against the live table shows the two do not line up (feed 2 -> Active 246,
-- Open 2, NULL 10; feed 1 -> Open 14, Active 3, NULL 8), so mapping one onto
-- the other would corrupt a column the collections views depend on.
--
-- txn_file field 14 is the processing code, NOT a transaction time. It is
-- named pcc here to stop that mistake being made again: across one large file
-- per year 2021-2026 it is '000000' on essentially every row, and in an
-- 11,880-row sample of the 2026 drops only 70 rows (0.6%) parse as a valid
-- HH24MISS clock. There is no time-of-day signal in this feed.
--
-- txn_file field 8 is a code class, not a channel: it is 1:1 with txn_code
-- (2 = interest 600/601/604, 8 = payments 402/422/472, 1 = 100 membership fee,
-- 7 = 423/303, 5 = 200/202 purchase, 4 = 602 penalty). Kept because it is
-- free to keep and confirms the code map, but app.transactions.channel stays
-- derived from txn_code — field 8 tells us nothing new.
--
-- Nullable throughout: every existing row predates collection, and the
-- backfill fills what the retained drops can support (accounts and customers
-- fully, transactions only for the ~14.7k feed-sourced rows — the 1.01M
-- mssql_baseline rows never carried these fields at all).

ALTER TABLE app.accounts
  ADD COLUMN IF NOT EXISTS currency_code   text,
  ADD COLUMN IF NOT EXISTS status_code     text,
  ADD COLUMN IF NOT EXISTS interest_rate   numeric,
  ADD COLUMN IF NOT EXISTS card_issue_date date;

ALTER TABLE app.customers
  ADD COLUMN IF NOT EXISTS address_3 text,
  ADD COLUMN IF NOT EXISTS phone_2   text;

ALTER TABLE app.transactions
  ADD COLUMN IF NOT EXISTS currency_code text,
  ADD COLUMN IF NOT EXISTS pcc           text,
  ADD COLUMN IF NOT EXISTS code_class    text;

-- Partial, and deliberately so: 566 (NGN) is ~99.5% of the book, so an index
-- over the whole column would be a scan of one value. What anyone actually
-- queries is "the non-naira accounts", which is 984 rows in the sample.
CREATE INDEX IF NOT EXISTS idx_accounts_currency_foreign
  ON app.accounts (currency_code)
  WHERE currency_code IS NOT NULL AND currency_code <> '566';

CREATE INDEX IF NOT EXISTS idx_transactions_currency_foreign
  ON app.transactions (currency_code)
  WHERE currency_code IS NOT NULL AND currency_code <> '566';

COMMENT ON COLUMN app.accounts.currency_code IS
  'ISO-4217 numeric currency from acct_file field 7: 566 = NGN, 840 = USD (Amex USD). docs/DATA_FEED_INGESTION.md §3.2 calls field 7 a branch code; that is wrong — see migration 233 for the evidence.';
COMMENT ON COLUMN app.accounts.status_code IS
  'Raw status code from acct_file field 4 (1,2,3,4,6). Does NOT map onto app.accounts.status and must not be used to overwrite it — the two disagree when correlated against the drops.';
COMMENT ON COLUMN app.accounts.interest_rate IS
  'Annual interest rate percent from acct_file field 6 (observed 0, 36, 42, 48, 60, 72).';
COMMENT ON COLUMN app.accounts.card_issue_date IS
  'Card issue date from acct_file field 20 — distinct from opened_date (field 8) and card_expiry_date (field 11).';
COMMENT ON COLUMN app.customers.address_3 IS
  'Third address line from cust_file field 5. custfeed already parsed it and folded it into full_address; it had no column of its own.';
COMMENT ON COLUMN app.customers.phone_2 IS
  'Second phone / cell from cust_file field 11. Often a duplicate of phone, but not always.';
COMMENT ON COLUMN app.transactions.currency_code IS
  'ISO-4217 numeric currency, resolved from the owning account (acct_file field 7). Without this, SUM(amount) mixes NGN and USD.';
COMMENT ON COLUMN app.transactions.pcc IS
  'Processing code from txn_file field 14. NOT a transaction time: it is 000000 on ~99.4% of rows. The feed carries no time-of-day.';
COMMENT ON COLUMN app.transactions.code_class IS
  'Code class from txn_file field 8; 1:1 with txn_code. channel remains derived from txn_code.';

-- Make the currency visible in the income book, without moving any number that
-- finance already reports.
--
-- app.income_daily (migration 157) sums app.transactions.amount into a column
-- named `amount_ngn`. Until migration 233 the ledger had no currency at all, and
-- the join it uses does not exclude foreign-currency accounts — so that column
-- has always included the Amex USD book: 214 accounts, 4,882 transactions, and
-- 14,927,440.78 of fee/interest/penalty by the 2026-09-12 dump.
--
-- Two things are therefore true: the number is mislabelled, and eight handlers
-- plus the finance Income page read it (finance_income.go, finance_eod.go,
-- overview.go, reports.go, assistant.go, export_datasets.go, finance.go,
-- pages/finance/Income.tsx). Filtering income_daily down to naira would make it
-- correct and simultaneously reduce reported revenue — a finance decision, not a
-- migration's. So income_daily is left exactly as it is, and this adds the view
-- that shows the split, so the size of the misstatement is visible rather than
-- argued about.
--
-- The amounts are NOT converted. Whether the feed's USD figures arrive in dollars
-- or pre-converted to naira is undocumented, and nobody on the CCS side has
-- confirmed it. Converting on an assumption would replace a visible problem with
-- an invisible one.
CREATE OR REPLACE VIEW app.income_daily_by_currency AS
 SELECT t.txn_date                                                   AS income_date,
        c.category,
        COALESCE(NULLIF(t.product_name, ''::text), 'Unspecified'::text) AS product_name,
        COALESCE(NULLIF(btrim(t.currency_code), ''), 'unknown')      AS currency_code,
        count(*)                                                     AS txn_count,
        sum(t.amount)                                                AS amount
   FROM app.transactions t
   JOIN app.card_txn_codes c ON c.code = t.txn_code
  WHERE c.category = ANY (ARRAY['fee'::text, 'interest'::text, 'penalty'::text])
    AND c.counts_in_total
  GROUP BY t.txn_date, c.category,
           COALESCE(NULLIF(t.product_name, ''::text), 'Unspecified'::text),
           COALESCE(NULLIF(btrim(t.currency_code), ''), 'unknown');

COMMENT ON VIEW app.income_daily_by_currency IS
  'app.income_daily split by the account currency (ISO-4217 numeric: 566 NGN, 840 USD, ''unknown'' until the currency backfill runs). Amounts are as stored and NOT converted. Use this to see what share of "revenue" is not naira.';

COMMENT ON VIEW app.income_daily IS
  'CAUTION: amount_ngn is a sum over ALL currencies, not naira only — it includes the Amex USD book. See app.income_daily_by_currency for the split, and migration 236 for why this view was deliberately left unchanged.';

COMMENT ON VIEW app.interest_components_daily IS
  'CAUTION: amount_ngn is a sum over ALL currencies, not naira only. See app.income_daily_by_currency and migration 236.';

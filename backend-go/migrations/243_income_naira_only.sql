-- Make the income book naira-only, with currency resolved from data that exists
-- TODAY rather than from columns that are still empty.
--
-- CCS posts USD-card amounts in DOLLARS (confirmed by the business 2026-09-14, and
-- by the data: fixed fees on USD cards are $5 joining / $10 maintenance / $5
-- re-issue against ₦5,000 / ₦15,650 / ₦2,500 on naira cards). So summing them into
-- app.income_daily.amount_ngn is not a labelling quirk — it adds dollars to naira.
--
-- The trap this migration is built around: migration 233 added currency_code to
-- app.transactions and app.accounts, but both stay NULL until the backfill runs.
-- Filtering on `currency_code = '566'` would therefore make the income book EMPTY
-- the moment 233 applied. Currency is instead resolved per row, in order:
--
--   1. transactions.currency_code  — once backfilled / newly ingested
--   2. accounts.currency_code      — once the account feed has touched the account
--   3. the product name            — populated today: every one of the 214 USD
--                                    accounts is product 'Amex USD'
--
-- The ACCOUNT's product name is preferred over the transaction's copy: 99.6% of
-- transactions carry a product_name, but only 85.8% of rows on USD accounts say
-- USD there, so trusting the transaction's copy would leak ~700 dollar rows back
-- into naira.
--
-- Documented, deliberately NOT corrected here: two 2023 interest postings on USD
-- cards (6,113,408.69 and 553,720.86) that are almost certainly naira mis-bookings.
-- See docs/DATA_QUALITY_KNOWN_ISSUES.md §1. Because they are on USD accounts, this
-- migration removes them from the naira income book as a side effect; they remain
-- visible in app.income_daily_by_currency.

CREATE OR REPLACE FUNCTION app.resolve_currency(p_txn text, p_acct text, p_product text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
           NULLIF(btrim(p_txn), ''),
           NULLIF(btrim(p_acct), ''),
           -- ~99.5% of the book is naira, and an unmatched product is far more likely
           -- to be one of the naira products than the single USD one.
           CASE WHEN p_product ILIKE '%USD%' THEN '840' ELSE '566' END)
$$;

COMMENT ON FUNCTION app.resolve_currency(text, text, text) IS
  'ISO-4217 numeric currency for a transaction: its own currency_code, else its account''s, else inferred from product name (Amex USD = 840, otherwise 566). Pass the ACCOUNT product name when available — the transaction copy is wrong on ~14% of USD-account rows. See migration 243.';

-- ── app.income_daily: naira only ────────────────────────────────────────────
-- Columns, names and types are unchanged, so every consumer (finance_income.go,
-- finance_eod.go, overview.go, reports.go, assistant.go, export_datasets.go,
-- pages/finance/Income.tsx) keeps working — the number just becomes correct.
--
-- The account join is guarded on a non-empty account_no: accounts.account_no is
-- unique only where it is non-empty, so a bare join on '' would multiply rows.
CREATE OR REPLACE VIEW app.income_daily AS
 SELECT t.txn_date AS income_date,
        c.category,
        COALESCE(NULLIF(t.product_name, ''::text), 'Unspecified'::text) AS product_name,
        count(*) AS txn_count,
        sum(t.amount) AS amount_ngn
   FROM app.transactions t
   JOIN app.card_txn_codes c ON c.code = t.txn_code
   LEFT JOIN app.accounts a ON a.account_no = t.account_no AND t.account_no <> ''
  WHERE c.category = ANY (ARRAY['fee'::text, 'interest'::text, 'penalty'::text])
    AND c.counts_in_total
    AND app.resolve_currency(t.currency_code, a.currency_code,
                             COALESCE(a.product_name, t.product_name)) = '566'
  GROUP BY t.txn_date, c.category, COALESCE(NULLIF(t.product_name, ''::text), 'Unspecified'::text);

COMMENT ON VIEW app.income_daily IS
  'Card fee / interest / penalty income, NAIRA ONLY (currency resolved per row by app.resolve_currency). USD income is in app.income_daily_by_currency and is not converted. See migration 243.';

CREATE OR REPLACE VIEW app.interest_components_daily AS
 SELECT t.txn_date AS income_date,
        c.description AS component,
        count(*) AS txn_count,
        sum(t.amount) AS amount_ngn
   FROM app.transactions t
   JOIN app.card_txn_codes c ON c.code = t.txn_code
   LEFT JOIN app.accounts a ON a.account_no = t.account_no AND t.account_no <> ''
  WHERE c.category = 'interest'::text
    AND NOT c.counts_in_total
    AND app.resolve_currency(t.currency_code, a.currency_code,
                             COALESCE(a.product_name, t.product_name)) = '566'
  GROUP BY t.txn_date, c.description;

COMMENT ON VIEW app.interest_components_daily IS
  'Interest breakdown components, NAIRA ONLY. See migration 243.';

-- ── app.income_daily_by_currency: same resolver ─────────────────────────────
-- Migration 236 read transactions.currency_code directly, which is NULL for every
-- row until the backfill — so it reported everything as 'unknown'. Same columns.
CREATE OR REPLACE VIEW app.income_daily_by_currency AS
 SELECT t.txn_date                                                       AS income_date,
        c.category,
        COALESCE(NULLIF(t.product_name, ''::text), 'Unspecified'::text)  AS product_name,
        app.resolve_currency(t.currency_code, a.currency_code,
                             COALESCE(a.product_name, t.product_name))   AS currency_code,
        count(*)                                                         AS txn_count,
        sum(t.amount)                                                    AS amount
   FROM app.transactions t
   JOIN app.card_txn_codes c ON c.code = t.txn_code
   LEFT JOIN app.accounts a ON a.account_no = t.account_no AND t.account_no <> ''
  WHERE c.category = ANY (ARRAY['fee'::text, 'interest'::text, 'penalty'::text])
    AND c.counts_in_total
  GROUP BY t.txn_date, c.category,
           COALESCE(NULLIF(t.product_name, ''::text), 'Unspecified'::text),
           app.resolve_currency(t.currency_code, a.currency_code,
                                COALESCE(a.product_name, t.product_name));

COMMENT ON VIEW app.income_daily_by_currency IS
  'app.income_daily split by resolved currency (566 NGN, 840 USD). Amounts as posted, NOT converted: USD rows are dollars. Includes the two documented 2023 USD mis-bookings (docs/DATA_QUALITY_KNOWN_ISSUES.md §1).';

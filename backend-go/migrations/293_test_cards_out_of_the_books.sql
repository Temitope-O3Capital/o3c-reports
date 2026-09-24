-- 293: keep test/vendor cards out of income and out of the balance sheet.
--
-- THE FINDING
--
-- Migration 281 surfaced the non-naira card book and reported 313,340.08 of USD
-- income over the trailing 12 months, deliberately unconverted, with a note that
-- whether those were dollars or naira was a question for the card team.
--
-- Investigated. Two separate answers, and the second one matters far more.
--
-- 1. THE CURRENCY IS GENUINELY USD. Not naira posted against a dollar-flagged
--    account. Three independent confirmations:
--      - the accounts carry currency_code 840, product 'Amex USD', and limits
--        denominated 20 to 5,000, which are dollar limits;
--      - the arithmetic closes. On the real USD accounts, monthly interest over
--        the dollar balance lands at 2.91 / 3.17 / 3.22 percent, which is what a
--        48 percent nominal annual rate produces against an average cycle
--        balance. If the postings were naira sitting on a dollar balance the
--        implied rate would be off by roughly the exchange rate, about 1,600x;
--      - no FX rate is needed, and applying one would have been wrong.
--
-- 2. THE AMOUNT IS NOT REVENUE. 312,304.28 of the 313,340.08 (99.67 percent) is
--    six interest postings on ONE card whose customer is literally named
--    'AMEX TEST CARD' (cif 00032666). That card has a 1,000 limit, no purchase
--    transactions at all, an 'Overdue Interest' posting of 6,113,408.69, and a
--    'Cash Payment Bank' of -97,284,710.28. It is test junk, not a customer.
--    Genuine USD card income for the trailing 12 months is about 1,036.
--
-- The same defect is in the naira book, which is why this migration is not just
-- about currency 840. Trailing 12 months, naira:
--      GAME TEST             1,920,288.96
--      BERKELEY TEST 3         686,644.19
--      BERKELEY TEST CARD 5    312,763.90
--      NFC TEST 1              120,124.42
--      CARD TEST SID            68,775.60
--      AIR COOP TEST            65,298.64
--      AIR COOP TEST 2          22,229.64
--      SUPP TEST 3 / 2             226.50
--      total                 3,196,351.85   of 412,147,282.87  (0.78 percent)
--
-- And on the balance sheet, open test cards carry 3,182,497.71 of receivable that
-- does not exist, 0.243 percent of the 1,309,894,758.04 open naira receivable.
--
-- WHY IT IS STILL HERE
--
-- Both feeds already reject these at ingest: acctfeed.testNameRE and the txnfeed
-- insert filter, both added 2026-09-10. Nothing new arrives. But the filter only
-- stops new rows; the historical rows were never removed. The 2026-08-10 purge
-- (app.customers_testdel_20260810 and siblings) archived 80 customers and 10,529
-- transactions but missed these, and the accounts were refreshed by acct_file
-- feeds dated 15/08/2026, after that purge and before the filter existed.
--
-- WHAT THIS DOES
--
-- Nothing is deleted. The rows stay for audit, exactly as the 2026-08-10 archive
-- kept its evidence. This adds one canonical predicate and excludes the accounts
-- from the three canonical financial views.
--
-- The predicate is the SAME regex both feeds use, kept deliberately identical so
-- ingest and reporting cannot drift apart. It is matched against BOTH the card
-- name and the customer name, because neither alone is complete: 33 accounts match
-- only on name_on_card (the 'Fastest' personas, and cards whose customer record
-- carries a real-looking name), 18 match only on the customer name (for example
-- 'AMEX TEST TWO', embossed 'VINCENT ONYEBUCHI'), and 28 match on both.
--
-- Verified against real Nigerian names that embed the substring: Testimony,
-- Protest, Latest, Ernest, Testman, Ademola and Bademosi all correctly do NOT
-- match, because the word boundaries \m and \M are load-bearing here.

CREATE OR REPLACE FUNCTION app.is_test_card_name(nm text)
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(nm, '') ~* '\m(test|bevertec|dummy|fastest)\M|testcard|questtest'
$$;

COMMENT ON FUNCTION app.is_test_card_name(text) IS
  'True when a cardholder or customer name marks a test/vendor card. This regex is '
  'the SAME one both feeds reject on at ingest (acctfeed.testNameRE and the txnfeed '
  'insert filter). Keep the three in step. The \m and \M word boundaries are '
  'load-bearing: without them Testimony, Protest, Latest and Ernest all match.';

CREATE OR REPLACE VIEW app.test_card_accounts AS
SELECT a.account_no,
       a.cif,
       a.name_on_card,
       cu.full_name AS customer_name,
       app.is_test_card_name(a.name_on_card) AS matched_on_card_name,
       app.is_test_card_name(cu.full_name)   AS matched_on_customer_name
FROM app.accounts a
LEFT JOIN app.customers cu ON cu.cif = a.cif
WHERE app.is_test_card_name(a.name_on_card)
   OR app.is_test_card_name(cu.full_name);

COMMENT ON VIEW app.test_card_accounts IS
  'Test/vendor card accounts, excluded from app.income_daily, app.income_by_currency '
  'and app.card_balances by migration 293. Matched on the card name OR the customer '
  'name, because neither alone catches all of them. Nothing is deleted: query this '
  'view to see exactly what is being held out of the books.';

-- Naira income, now excluding test cards.
CREATE OR REPLACE VIEW app.income_daily AS
SELECT t.txn_date                                          AS income_date,
       c.category,
       COALESCE(NULLIF(t.product_name, ''), 'Unspecified') AS product_name,
       COUNT(*)                                            AS txn_count,
       SUM(t.amount)                                       AS amount_ngn
FROM app.transactions t
JOIN app.card_txn_codes c ON c.code = t.txn_code
LEFT JOIN app.accounts a ON a.account_no = t.account_no AND t.account_no <> ''
WHERE c.category IN ('fee', 'interest', 'penalty')
  AND c.counts_in_total
  AND app.resolve_currency(t.currency_code, a.currency_code,
                           COALESCE(a.product_name, t.product_name)) = '566'
  AND NOT EXISTS (SELECT 1 FROM app.test_card_accounts ta
                   WHERE ta.account_no = t.account_no)
GROUP BY 1, 2, 3;

COMMENT ON VIEW app.income_daily IS
  'Daily card revenue by category (fee / interest / penalty) in NAIRA. Excludes the '
  'interest component codes 600/601/603, which 604 already totals; excludes every '
  'non-naira currency, deliberately, because this view reports one naira column that '
  'a dozen callers sum into naira headlines; and excludes test/vendor cards '
  '(migration 293). The non-naira income is NOT lost: read app.income_by_currency.';

-- Same exclusion on the per-currency view.
CREATE OR REPLACE VIEW app.income_by_currency AS
SELECT t.txn_date                                          AS income_date,
       app.resolve_currency(t.currency_code, a.currency_code,
                            COALESCE(a.product_name, t.product_name)) AS currency_code,
       CASE app.resolve_currency(t.currency_code, a.currency_code,
                                 COALESCE(a.product_name, t.product_name))
           WHEN '566' THEN 'NGN' WHEN '840' THEN 'USD'
           ELSE app.resolve_currency(t.currency_code, a.currency_code,
                                     COALESCE(a.product_name, t.product_name))
       END                                                 AS currency,
       c.category,
       COALESCE(NULLIF(t.product_name, ''), 'Unspecified') AS product_name,
       COUNT(*)                                            AS txn_count,
       SUM(t.amount)                                       AS amount
FROM app.transactions t
JOIN app.card_txn_codes c ON c.code = t.txn_code
LEFT JOIN app.accounts a ON a.account_no = t.account_no AND t.account_no <> ''
WHERE c.category IN ('fee', 'interest', 'penalty')
  AND c.counts_in_total
  AND NOT EXISTS (SELECT 1 FROM app.test_card_accounts ta
                   WHERE ta.account_no = t.account_no)
GROUP BY 1, 2, 3, 4, 5;

COMMENT ON VIEW app.income_by_currency IS
  'Card revenue by category and CURRENCY, in each currency''s own major units. The '
  'amount column is deliberately named `amount`, not `amount_ngn`: group by currency '
  'and never sum across it. Excludes test/vendor cards (migration 293), which were '
  '99.67 percent of what this view previously reported for USD. app.income_daily is '
  'the naira-only slice of this.';

-- Card balances, now excluding test cards.
CREATE OR REPLACE VIEW app.card_balances AS
SELECT b.account_no,
       b.account_id,
       b.cif,
       b.contact_id,
       b.product_name,
       b.status,
       b.card_state,
       b.days_overdue,
       b.opened_date,
       COALESCE(b.product_category, 'unmatched') AS family,
       app.resolve_currency(NULL::text, a.currency_code, b.product_name) AS currency_code,
       CASE app.resolve_currency(NULL::text, a.currency_code, b.product_name)
           WHEN '566' THEN 'NGN' WHEN '840' THEN 'USD'
           ELSE app.resolve_currency(NULL::text, a.currency_code, b.product_name)
       END AS currency,
       COALESCE(b.status, '') IN ('Open', 'Active') AS is_open,
       ROUND(GREATEST(COALESCE(b.current_dr_balance, 0), 0) * 100)::bigint  AS receivable_kobo,
       ROUND(GREATEST(-COALESCE(b.current_dr_balance, 0), 0) * 100)::bigint AS float_kobo,
       ROUND(COALESCE(b.current_dr_balance, 0) * 100)::bigint              AS net_dr_kobo,
       ROUND(COALESCE(b.card_limit, 0) * 100)::bigint                      AS limit_kobo,
       ROUND(COALESCE(b.cycle_balance, 0) * 100)::bigint                   AS cycle_balance_kobo,
       ROUND(COALESCE(b.min_payment_due, 0) * 100)::bigint                 AS min_payment_due_kobo,
       b.last_seen
FROM app.card_book_full b
JOIN app.accounts a ON a.account_no = b.account_no
WHERE NOT EXISTS (SELECT 1 FROM app.test_card_accounts ta
                   WHERE ta.account_no = b.account_no);

COMMENT ON VIEW app.card_balances IS
  'Canonical per-card balance. receivable_kobo and float_kobo are the two SIDES of '
  'the balance and must never be netted against each other; currency_code is a '
  'grouping key, never mix 566 and 840. Excludes test/vendor cards (migration 293), '
  'which carried 3,182,497.71 of phantom open naira receivable.';

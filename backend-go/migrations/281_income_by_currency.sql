-- 281: stop the USD card book's income disappearing.
--
-- THE PROBLEM
--
-- app.income_daily is the workspace's definition of card revenue. A later change
-- added `AND app.resolve_currency(...) = '566'` to it — correctly, because the
-- view reports a single naira column and roughly a dozen call sites sum it
-- straight into naira headlines. But the effect is that income booked on the USD
-- card book is not reported anywhere at all. It is not converted, not shown
-- beside the naira figure, not counted as excluded: it is silently gone.
--
-- Measured over the trailing 12 months to 2026-09-23, currency 840:
--     interest   249 postings    312,601.39
--     fee        222 postings        738.69
-- All of it on the Amex USD product. Whether those amounts are dollars or naira
-- posted against a USD-flagged account is a question for the card team — which is
-- exactly why nothing here converts them. Applying a rate would bury the question
-- inside a number; surfacing them under their own currency asks it.
--
-- WHAT THIS DOES
--
-- app.income_daily is left NAIRA-ONLY and unchanged. Every existing caller stays
-- correct, and no naira headline silently gains dollars. Its comment now says the
-- exclusion is deliberate and where the rest went.
--
-- app.income_by_currency is the same classification with currency carried as a
-- grouping key and no currency filter, so the full book is reportable. Callers
-- MUST group by currency; there is no blended total here by design.

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
  AND c.counts_in_total          -- excludes the 600/601/603 interest components
GROUP BY 1, 2, 3, 4, 5;

COMMENT ON VIEW app.income_by_currency IS
  'Card revenue by category and CURRENCY, in each currency''s own major units. The '
  'amount column is deliberately named `amount`, not `amount_ngn`: group by currency '
  'and never sum across it. app.income_daily is the naira-only slice of this.';

COMMENT ON VIEW app.income_daily IS
  'Daily card revenue by category (fee / interest / penalty) in NAIRA. Excludes the '
  'interest component codes 600/601/603, which 604 already totals, and excludes every '
  'non-naira currency — deliberately, because this view reports one naira column that '
  'a dozen callers sum into naira headlines. The non-naira income is NOT lost: read '
  'app.income_by_currency (migration 281) for the full book, per currency.';

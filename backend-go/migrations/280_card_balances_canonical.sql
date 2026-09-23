-- 280: one canonical definition of "the card balance", split by side and by currency.
--
-- THE PROBLEM
--
-- app.accounts.current_dr_balance is a single signed DEBIT balance covering the
-- whole card book — credit, prepaid, Blink, naira and USD alike. Every headline
-- figure in the workspace reduces it with a bare SUM(), and that one SUM is
-- wrong in two independent ways at once.
--
-- 1. IT NETS AN ASSET AGAINST A LIABILITY. A positive current_dr_balance is a
--    receivable: the customer owes O3 (a revolving credit card's outstanding).
--    A negative one is the opposite — it is the CUSTOMER'S money that O3 is
--    holding: prepaid stored value, Blink float, and credit cards in credit.
--    Summing them cancels one against the other. Measured 2026-09-23 on the
--    live book (app.card_book_full, naira):
--
--        credit   receivable  2,153,200,601.60   float     55,549,305.91
--        prepaid  receivable     11,130,917.71   float    193,179,209.58
--        blink    receivable              0.00   float      2,947,817.02
--        unmatched receivable             0.00   float          1,530.72
--
--    So the true card receivable is ₦2.164bn and O3 holds ₦251.7m of customer
--    money. SUM(current_dr_balance) returns ₦1.912bn — understating the asset by
--    ₦251.7m and never showing the liability at all, which is exactly why "the
--    balance of the prepaid and Blink cards" appears nowhere in the workspace.
--
-- 2. IT ADDS DOLLARS TO NAIRA. 217 accounts carry currency_code 840 and hold
--    $239,026.49 of customer float. A bare SUM() adds that to the naira column
--    as if a dollar were a naira. No conversion is applied here either: this
--    view keeps currency as a GROUPING KEY so the two never merge silently.
--    Converting to a single presentation currency needs an FX rate and a
--    business decision about which one; that belongs above this view, not in it.
--
-- Anything that filters `current_dr_balance > 0` (collections, recovery, the
-- repayment queue) is unaffected and stays correct — those surfaces genuinely
-- want the receivable side only. What this view fixes is every surface that
-- claims to report "the card book balance" in total.
--
-- WHAT THIS ADDS
--
-- app.card_balances          — one row per card account, balance decomposed.
-- app.card_balance_summary   — the rollup, by currency x family x open/closed.
--
-- Money is kobo/cents (bigint), matching the rest of the workspace. app.accounts
-- is the one table that stores naira as numeric, so it is multiplied out here
-- and callers never have to remember the exception again.

CREATE OR REPLACE VIEW app.card_balances AS
SELECT
    b.account_no,
    b.account_id,
    b.cif,
    b.contact_id,
    b.product_name,
    b.status,
    b.card_state,
    b.days_overdue,
    -- Carried so the Cards KPI strip can apply its own product/opened-date filter
    -- to the balances and have them reconcile with the counts beside them.
    b.opened_date,

    -- Funding family from the product catalogue (migration 239). 'unmatched'
    -- rather than NULL so a grouping never drops the row.
    COALESCE(b.product_category, 'unmatched')                AS family,

    -- Currency as a grouping key, never as an assumption. The account's own ISO
    -- numeric wins; app.resolve_currency supplies the same product-name fallback
    -- app.income_daily already uses, so the two agree on any given account.
    app.resolve_currency(NULL, a.currency_code, b.product_name) AS currency_code,
    CASE app.resolve_currency(NULL, a.currency_code, b.product_name)
        WHEN '566' THEN 'NGN' WHEN '840' THEN 'USD'
        ELSE app.resolve_currency(NULL, a.currency_code, b.product_name)
    END                                                       AS currency,

    -- COALESCE, not a bare IN: 55 accounts carry a NULL status, and NULL IN (...)
    -- is NULL, which would make is_open a third value and split every rollup
    -- into three groups instead of two.
    COALESCE(b.status, '') IN ('Open', 'Active')              AS is_open,

    -- The two sides, each non-negative, in the account's OWN currency.
    ROUND(GREATEST(COALESCE(b.current_dr_balance, 0), 0) * 100)::bigint AS receivable_kobo,
    ROUND(GREATEST(-COALESCE(b.current_dr_balance, 0), 0) * 100)::bigint AS float_kobo,
    -- The signed original, so a caller reconciling against the old figure can.
    ROUND(COALESCE(b.current_dr_balance, 0) * 100)::bigint              AS net_dr_kobo,

    ROUND(COALESCE(b.card_limit, 0) * 100)::bigint            AS limit_kobo,
    ROUND(COALESCE(b.cycle_balance, 0) * 100)::bigint         AS cycle_balance_kobo,
    ROUND(COALESCE(b.min_payment_due, 0) * 100)::bigint       AS min_payment_due_kobo,
    b.last_seen
FROM app.card_book_full b
JOIN app.accounts a ON a.account_no = b.account_no;

COMMENT ON VIEW app.card_balances IS
  'Canonical per-account card balance. receivable_kobo (customer owes O3, an asset) '
  'and float_kobo (O3 holds customer money — prepaid/Blink stored value and credit '
  'cards in credit, a liability) are separate and both non-negative. Amounts are in '
  'the account''s OWN currency: group by currency, never SUM across it.';

CREATE OR REPLACE VIEW app.card_balance_summary AS
SELECT
    currency,
    currency_code,
    family,
    is_open,
    COUNT(*)                                                 AS accounts,
    COUNT(*) FILTER (WHERE receivable_kobo > 0)              AS accounts_owing,
    COUNT(*) FILTER (WHERE float_kobo > 0)                   AS accounts_in_credit,
    COALESCE(SUM(receivable_kobo), 0)::bigint                AS receivable_kobo,
    COALESCE(SUM(float_kobo), 0)::bigint                     AS float_kobo,
    COALESCE(SUM(net_dr_kobo), 0)::bigint                    AS net_dr_kobo,
    COALESCE(SUM(limit_kobo), 0)::bigint                     AS limit_kobo
FROM app.card_balances
GROUP BY currency, currency_code, family, is_open;

COMMENT ON VIEW app.card_balance_summary IS
  'Card book rolled up by currency x funding family x open/closed. The asset side is '
  'receivable_kobo and the liability side is float_kobo; net_dr_kobo is the legacy '
  'SUM(current_dr_balance) figure, kept only so the difference can be reconciled.';

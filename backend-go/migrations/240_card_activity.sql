-- Cards get a second axis: how the card is BEING USED, separate from what
-- state it is in.
--
-- WHY A SECOND AXIS
--
-- app.card_book.card_state (migration 177) answers "is this card alive?" —
-- Terminated / Legal action / Suspended / Hot listed / Expired / Inactive /
-- Unknown / Live. It is a lifecycle verdict built from status and expiry, and
-- it has no usage input at all. Cross-tabbing it against real transactions
-- shows the two axes are independent:
--
--   card_state    cards   transacted in 90d   paid in 90d
--   Expired       16,373              579            116
--   Live           2,409              613            587
--   Unknown          173               62             51
--
-- 579 cards the book calls Expired are still being spent on, and 1,796 Live
-- cards have done nothing. Neither column can stand in for the other, so this
-- adds activity alongside card_state rather than folding them together.
--
-- PER CARD, NOT PER CUSTOMER
--
-- Every dormancy figure in the app today is computed at CIF or party grain
-- (growth.go:79-118, overview.go:843, executive.go:2210, customer360.go:229,
-- sales.go:1341). contacts.go:143 is billed as per-account but joins on cif, so
-- every card a customer holds is stamped with the same last-activity date — a
-- customer with a live Classic card and a dead PREP card shows both as active.
-- This view keys on account_no, which is what txn_file actually points at
-- (docs/DATA_FEED_INGESTION.md §4) and the only true per-card key.
--
-- THE WINDOWS
--
-- Cards turn over far faster than loans, so the platform's existing 90/365 cut
-- is too coarse: a card that stopped being used four months ago still reads
-- "lapsing" on a loan-shaped scale. Tiers are 30 / 90 / 365 days:
--
--   Active      spent in the last 30 days
--   Light       31-90 days
--   Dormant     91-365 days
--   Inactive    over a year
--   Never used  no transaction has ever been seen for this card
--
-- "Never used" is 12,181 of 20,693 accounts (59%) — the majority of the book,
-- so it is a first-class bucket, not an edge case. Only 41% of accounts have
-- any ledger row at all.
--
-- ACTIVITY MEANS SPEND, NOT REPAYMENT
--
-- last_payment_date is carried alongside but deliberately does NOT feed the
-- classification, even though it covers 97% of the book against transactions'
-- 41%. It is payment-only: a cooperative card serviced by a standing salary
-- deduction would read "Active" while the cardholder has not touched it in two
-- years. The column is exposed so a caller can apply that judgement itself.

-- ── Index: the per-card rollup this view depends on ─────────────────────────
-- app.transactions has idx_transactions_account_no and transaction_txn_date_idx
-- separately, but no composite — so MAX(txn_date) GROUP BY account_no over 1.03m
-- rows has no index to walk.
CREATE INDEX IF NOT EXISTS idx_transactions_account_no_date
  ON app.transactions (account_no, txn_date DESC);

-- ── The view ────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW app.card_activity AS
WITH last_txn AS (
    SELECT account_no,
           MAX(txn_date) AS last_txn_date,
           COUNT(*)      AS txn_count
      FROM app.transactions
     WHERE account_no IS NOT NULL AND account_no <> ''
     GROUP BY account_no
)
SELECT a.account_no,
       a.cif,
       t.last_txn_date,
       COALESCE(t.txn_count, 0) AS txn_count,
       a.last_payment_date,
       -- Negative for the future-dated rows the source claims (max txn_date is
       -- 2026-09-23, ahead of today — see 238_pipeline_freshness.sql:33-36).
       -- Those land in Active, which is the honest reading of "the source says
       -- this card transacted"; the alternative is to silently discard them.
       (CURRENT_DATE - t.last_txn_date) AS days_since_txn,
       CASE
         WHEN t.last_txn_date IS NULL                        THEN 'Never used'
         WHEN CURRENT_DATE - t.last_txn_date <= 30           THEN 'Active'
         WHEN CURRENT_DATE - t.last_txn_date <= 90           THEN 'Light'
         WHEN CURRENT_DATE - t.last_txn_date <= 365          THEN 'Dormant'
         ELSE                                                     'Inactive'
       END AS activity_class
  FROM app.accounts a
  LEFT JOIN last_txn t ON t.account_no = a.account_no;

COMMENT ON VIEW app.card_activity IS
  'Per-card usage: last transaction, count, and an activity_class of Active (<=30d) | Light (31-90d) | Dormant (91-365d) | Inactive (>365d) | Never used. Keyed on account_no — the true per-card key — unlike the CIF-grain dormancy computed elsewhere in the app. Orthogonal to app.card_book.card_state, which is lifecycle only: 579 Expired cards transacted in the last 90 days and 1,796 Live cards did not.';

-- ── Card book + both axes, which is what the pages should read ──────────────
CREATE OR REPLACE VIEW app.card_book_full AS
SELECT b.*,
       act.last_txn_date,
       act.txn_count,
       act.days_since_txn,
       act.activity_class,
       p.category        AS product_category,
       p.product_name    AS catalogue_product_name,
       p.is_cooperative,
       p.is_temporary,
       p.fx_funded,
       p.currency        AS product_currency,
       p.scheme          AS product_scheme
  FROM app.card_book b
  LEFT JOIN app.card_activity act ON act.account_no = b.account_no
  -- The book carries the legacy system_name in product_name, so the catalogue
  -- joins on system_name first and falls back to its display name. product_id
  -- cannot be used: it points at core.product's id space, not this catalogue's
  -- (see migration 239's core_product_id bridge).
  LEFT JOIN app.card_products p
         ON p.system_name = b.product_name OR p.product_name = b.product_name;

COMMENT ON VIEW app.card_book_full IS
  'The card book with both axes and the product catalogue attached: card_state (lifecycle), activity_class (usage), and the funding family from app.card_products. Read this instead of joining app.accounts to the catalogue by hand — the name join is subtle (the book stores system_name) and getting it wrong is what produced eight competing definitions of "what kind of card is this".';

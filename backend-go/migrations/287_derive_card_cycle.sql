-- 287 — Derive a card cycle from the transaction feed.
--
-- WHY. The cycle arrives as four uploaded reports (CYCBAL, CYCCHG, CYCINT, CYCLOC)
-- that somebody has to remember to upload. The last one landed on 14 July 2026 and
-- nothing has arrived since, so every card figure in the management reports is 71
-- days stale. Those four reports are a summary of the transaction feed, which is
-- current to today, so the cycle can be computed instead of waiting for it.
--
-- WHAT WAS CHECKED. Derived against the uploaded 14 July cycle, 884 accounts with
-- activity:
--
--     Purchases          98.9% of the uploaded total, 870 of 884 exact to the kobo
--     Payments           98.2%, 868 exact
--     Cash advance       97.7%, 860 exact
--     Fees               92.3%, 882 exact
--     Interest charged   65.1%, 775 exact
--
-- The 17,616 accounts with no transactions in the window had no purchases in the
-- uploaded cycle either, so the feed is not missing active accounts.
--
-- THE CYCLE WINDOW is the 15th of the prior month to the 14th. Established by
-- testing three candidates: 15 Jun–14 Jul reproduced purchases at 98.9%, while
-- 1 Jul–14 Jul reached only 48%.
--
-- INTEREST NEEDS CODE-LEVEL MAPPING, NOT CLASS. code_class 2 carries three codes,
-- and 604 "Total Interest" is the processor's own summary of 600 and 601 arriving
-- in the same feed. Summing the class counts that money twice: it gave ₦47.2m
-- against an uploaded ₦10.1m. 600+601 alone gives ₦6.60m, and 604 alone reproduces
-- total_interest_kobo exactly.
--
-- WHY INTEREST STILL FALLS SHORT. ₦3.5m of charged interest has no matching 600 or
-- 601 transaction at any window end, so it is not a cut-off effect. The transaction
-- feed has a hole: May 2026 holds 7 rows where neighbouring months hold 4,000 to
-- 6,000, and June holds 1,511. The feed moved to daily files in August (1,102 files
-- that month), so a cycle derived from August onward should not carry this gap.
-- That is the test worth running before anyone trusts this over the uploads.
--
-- WHAT THIS DOES NOT DO. Balances (billed, current, outstanding, overdue) and the
-- minimum payment are left out. The uploaded cycle shows minimum payment equal to
-- the full outstanding wherever an account is overdue, and around 25% otherwise,
-- but every account carrying a balance on 14 July was also overdue, so the 25%
-- branch could not be verified against anything. Guessing it here would put a
-- number in front of a customer that nobody has checked.

CREATE OR REPLACE FUNCTION app.derive_card_cycle(p_cycle_date date)
RETURNS TABLE (
    cycle_date              date,
    account_number          text,
    cif                     text,
    currency                text,
    purchase_amount_kobo    bigint,
    cash_advance_kobo       bigint,
    fees_kobo               bigint,
    penalty_kobo            bigint,
    interest_charged_kobo   bigint,
    total_interest_kobo     bigint,
    total_payment_kobo      bigint,
    credit_limit_kobo       bigint,
    txn_count               integer
)
LANGUAGE sql
STABLE
AS $$
    WITH bounds AS (
        -- The 15th of the prior month through the cycle date itself.
        SELECT (p_cycle_date - INTERVAL '1 month')::date + (15 - EXTRACT(DAY FROM p_cycle_date))::int AS d_from,
               p_cycle_date AS d_to
    ),
    -- code_class is 1:1 with txn_code, but the mssql_baseline bulk load carries
    -- only the code. Recovering the class from the code is what makes the whole
    -- history usable rather than just what the daily feed brought in.
    code_map AS (
        SELECT DISTINCT txn_code, code_class
          FROM app.transactions
         WHERE txn_code IS NOT NULL AND code_class IS NOT NULL
    ),
    tx AS (
        SELECT t.account_no, t.cif, t.currency_code, t.txn_code, t.amount,
               COALESCE(t.code_class, m.code_class) AS cls
          FROM app.transactions t
          CROSS JOIN bounds b
          LEFT JOIN code_map m ON m.txn_code = t.txn_code
         WHERE t.account_no IS NOT NULL
           AND t.txn_date BETWEEN b.d_from AND b.d_to
    )
    SELECT p_cycle_date,
           tx.account_no,
           MAX(tx.cif),
           CASE MAX(tx.currency_code) WHEN '840' THEN 'USD' ELSE 'NGN' END,
           COALESCE(SUM(tx.amount * 100) FILTER (WHERE tx.cls = '5'), 0)::bigint,
           COALESCE(SUM(tx.amount * 100) FILTER (WHERE tx.cls = '7'), 0)::bigint,
           COALESCE(SUM(tx.amount * 100) FILTER (WHERE tx.cls = '1'), 0)::bigint,
           COALESCE(SUM(tx.amount * 100) FILTER (WHERE tx.txn_code = '602'), 0)::bigint,
           COALESCE(SUM(tx.amount * 100) FILTER (WHERE tx.txn_code IN ('600','601')), 0)::bigint,
           COALESCE(SUM(tx.amount * 100) FILTER (WHERE tx.txn_code = '604'), 0)::bigint,
           COALESCE(SUM(-tx.amount * 100) FILTER (WHERE tx.cls = '8'), 0)::bigint,
           COALESCE(MAX(a.card_limit) * 100, 0)::bigint,
           COUNT(*)::int
      FROM tx
      LEFT JOIN app.accounts a ON a.account_no = tx.account_no
     GROUP BY tx.account_no;
$$;

COMMENT ON FUNCTION app.derive_card_cycle(date) IS
  'Computes a card cycle from app.transactions for the 15th-to-14th window ending on '
  'the given date. Reconciled at 92-99% against the uploaded 14 July 2026 cycle on every '
  'transactional field. Balances and minimum payment are deliberately absent: they could '
  'not be verified against the one cycle we hold. See the migration for the workings.';

-- 282: give the ledger a liability side, and give the business a position
-- statement that is honest about where it comes from.
--
-- WHAT WAS THERE
--
-- gl_accounts held FOUR accounts: 1001 Cash/Bank and 1100 Loan Receivable
-- (Asset), 4000 Interest Income (Income), 5200 Loan Loss Provision (Expense).
-- No Liability class. No Equity class. The CHECK constraint allowed both;
-- nothing had ever been seeded.
--
-- gl_journal_entries held 1,802 rows and every one of them was a collections
-- payment (Dr 1001 / Cr 1100) plus a single ₦1 write-off. Nothing else has ever
-- posted. Meanwhile the fixed-deposit and card-dispute handlers post to
-- 'fixed_deposits_liability', 'card_liability', 'dispute_suspense' and 'cash' —
-- free-text account keys that exist in NO chart of accounts, on TEXT columns
-- with no foreign key. Those paths have never fired; if one ever had, it would
-- have written a journal row referencing an account that does not exist.
--
-- So: the ₦19.61bn deposit book has never touched the ledger, and there is no
-- account it could have touched.
--
-- WHAT THIS DOES, AND WHAT IT DELIBERATELY DOES NOT
--
-- It does NOT back-post the books into the GL. Udara/CBS is the book of record
-- (migration 268); manufacturing 20,000 journal entries to make a ledger that
-- has never been used look populated would create a second, worse set of
-- numbers. The GL stays the record of what the workspace itself posts.
--
-- It DOES:
--   1. Seed the missing chart of accounts, including the Liability and Equity
--      classes, so the accounts the code already references exist and resolve.
--   2. Add app.financial_position — assets and liabilities per currency, drawn
--      from the same books of record every other figure on the platform uses.
--      It reports net position, NOT equity, and says so: there is no capital or
--      reserves source anywhere in this database, so anything calling itself
--      equity here would be invented.

-- ── 1. Chart of accounts ─────────────────────────────────────────────────────
--
-- Codes follow the existing scheme: 1xxx Asset, 2xxx Liability, 3xxx Equity,
-- 4xxx Income, 5xxx Expense. The four original accounts are left untouched.
INSERT INTO gl_accounts (code, name, class, normal_balance, currency) VALUES
    ('1200', 'Card Receivable',                  'Asset',     'Dr', 'NGN'),
    ('1210', 'Card Receivable (USD)',            'Asset',     'Dr', 'USD'),
    ('2100', 'Fixed Deposit Liability',          'Liability', 'Cr', 'NGN'),
    ('2110', 'Fixed Deposit Interest Payable',   'Liability', 'Cr', 'NGN'),
    ('2200', 'Card Liability - Customer Float',  'Liability', 'Cr', 'NGN'),
    ('2210', 'Card Liability - Customer Float (USD)', 'Liability', 'Cr', 'USD'),
    ('2300', 'Card Dispute Suspense',            'Liability', 'Cr', 'NGN'),
    ('3000', 'Retained Earnings',                'Equity',    'Cr', 'NGN'),
    ('3100', 'Share Capital',                    'Equity',    'Cr', 'NGN'),
    ('4100', 'Card Fee Income',                  'Income',    'Cr', 'NGN'),
    ('4200', 'Penalty Income',                   'Income',    'Cr', 'NGN'),
    ('5100', 'Interest Expense - Deposits',      'Expense',   'Dr', 'NGN')
ON CONFLICT (code) DO NOTHING;

COMMENT ON TABLE gl_accounts IS
  'Chart of accounts. 1xxx Asset, 2xxx Liability, 3xxx Equity, 4xxx Income, 5xxx Expense. '
  'Post by CODE — the free-text keys some handlers used (cash, card_liability, '
  'dispute_suspense, fixed_deposits_liability) resolve to 1001, 2200, 2300 and 2100 and '
  'were replaced in migration 282. The GL records what the WORKSPACE posts; Udara/CBS is '
  'the book of record for the loan, deposit and card books (migration 268), and those are '
  'NOT mirrored here. Read app.financial_position for the whole-business position.';

-- Any journal row already written against a free-text key is repointed, so the
-- ledger has one naming scheme. (Expected to match zero rows today — those paths
-- have never fired — but it must not be left to chance.)
UPDATE gl_journal_entries SET debit_account = CASE debit_account
        WHEN 'cash' THEN '1001' WHEN 'card_liability' THEN '2200'
        WHEN 'dispute_suspense' THEN '2300' WHEN 'fixed_deposits_liability' THEN '2100'
        ELSE debit_account END,
    credit_account = CASE credit_account
        WHEN 'cash' THEN '1001' WHEN 'card_liability' THEN '2200'
        WHEN 'dispute_suspense' THEN '2300' WHEN 'fixed_deposits_liability' THEN '2100'
        ELSE credit_account END
WHERE debit_account  IN ('cash','card_liability','dispute_suspense','fixed_deposits_liability')
   OR credit_account IN ('cash','card_liability','dispute_suspense','fixed_deposits_liability');

-- ── 2. Financial position ────────────────────────────────────────────────────
--
-- One row per (currency, side, line). Everything is kobo/cents in the line's own
-- currency — currency is a grouping key here for the same reason it is in
-- app.card_balances: there is no FX rate policy, so nothing is blended.
--
-- Sources are the live books of record, which is what every other figure on the
-- platform already reads:
--   Loan receivable  cbs_loans, open loans (NOT Closed/Revoked)
--   Card receivable  app.card_balances (migration 280), receivable side
--   FD principal     cbs_fixed_deposits, Active AND funded (the hasDisbursed
--                    flag — 17 Active rows are unfunded shells carrying no money)
--   FD interest      the same register's accrued_interest_kobo
--   Card float       app.card_balances, float side — prepaid and Blink stored
--                    value and cards sitting in credit
CREATE OR REPLACE VIEW app.financial_position AS
WITH lines AS (
    SELECT 'NGN'::text AS currency, 'Asset'::text AS side, 1 AS sort,
           'Loan Receivable'::text AS line, '1100'::text AS gl_code,
           COALESCE(SUM(outstanding_principal_kobo), 0)::bigint AS amount_kobo,
           COUNT(*)::bigint AS items
      FROM cbs_loans WHERE status NOT IN ('Closed', 'Revoked')

    UNION ALL
    SELECT currency, 'Asset', 2,
           'Card Receivable', CASE WHEN currency = 'USD' THEN '1210' ELSE '1200' END,
           COALESCE(SUM(receivable_kobo), 0)::bigint,
           COUNT(*) FILTER (WHERE receivable_kobo > 0)::bigint
      FROM app.card_balances GROUP BY currency

    UNION ALL
    SELECT 'NGN', 'Liability', 1,
           'Fixed Deposit Principal', '2100',
           COALESCE(SUM(principal_kobo), 0)::bigint, COUNT(*)::bigint
      FROM cbs_fixed_deposits
     WHERE status = 'Active' AND raw->>'hasDisbursed' IS DISTINCT FROM 'false'

    UNION ALL
    SELECT 'NGN', 'Liability', 2,
           'Fixed Deposit Interest Payable', '2110',
           COALESCE(SUM(accrued_interest_kobo), 0)::bigint, COUNT(*)::bigint
      FROM cbs_fixed_deposits
     WHERE status = 'Active' AND raw->>'hasDisbursed' IS DISTINCT FROM 'false'

    UNION ALL
    SELECT currency, 'Liability', 3,
           'Card Customer Float', CASE WHEN currency = 'USD' THEN '2210' ELSE '2200' END,
           COALESCE(SUM(float_kobo), 0)::bigint,
           COUNT(*) FILTER (WHERE float_kobo > 0)::bigint
      FROM app.card_balances GROUP BY currency
)
SELECT currency, side, sort, line, gl_code, amount_kobo, items
  FROM lines
 WHERE amount_kobo <> 0;

COMMENT ON VIEW app.financial_position IS
  'Assets and liabilities per currency, from the live books of record (cbs_loans, '
  'cbs_fixed_deposits, app.card_balances) — NOT from gl_journal_entries, which only '
  'records workspace-originated postings. Amounts are kobo/cents in each line''s own '
  'currency: group by currency, never sum across it. Assets minus liabilities is a NET '
  'POSITION, not equity — this database holds no capital, reserves or retained-earnings '
  'source, so any equity figure would be invented.';

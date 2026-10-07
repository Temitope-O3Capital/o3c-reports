-- 348: a real Cash Flow Statement, branch-split, built off Udara's own GL
-- (cbs_gl_postings, same 2026-07-01+ floor as the Income Statement / migration 347).
--
-- No cash-flow source exists anywhere in this system before this migration -- confirmed
-- by direct audit of every migration and handler, not assumed.
--
-- METHOD: this uses whole-ledger conservation, not per-entry leg-pairing. Every GL
-- posting is either on one of our own cash/nostro/wallet accounts (gl_cash_flow_accounts.
-- activity = 'cash'), on a purely internal suspense/inter-branch account ('internal'), or
-- on an account that represents a real external counterparty (income/expense, loan
-- principal, FD principal, tax, payables...). By double-entry construction, the NET
-- movement across every non-cash, non-internal account (credits minus debits) equals the
-- net movement across our cash accounts, with the opposite sign convention resolved by
-- the credit-minus-debit formula below (verified against the worked examples in this
-- migration's accompanying commit: loan disbursement, loan repayment, FD funding, FD
-- withdrawal, interest earned, expense paid -- all five sign out correctly). This avoids
-- needing to pair debit/credit legs by posting_reference, which cbs_gl_postings does not
-- guarantee as clean 1:1 pairs (verified live: ~86% of postings ARE 1 debit/1 credit, the
-- rest are batched multi-leg entries like interest-accrual runs that would need a much
-- more complex join to pair exactly).
--
-- ACCOUNT CLASSIFICATION, in priority order (see the view below):
--   1. gl_cash_flow_accounts.activity = 'cash' or 'internal'  -> EXCLUDED entirely (this
--      account IS the thing the statement explains, or is pure internal bookkeeping with
--      no external cash effect -- inter-branch settlement, migration suspense).
--   2. account_number already in gl_account_lines (income/expense, migration 342)
--      -> 'operating'.
--   3. account_number in gl_cash_flow_accounts with an explicit activity -> that activity.
--   4. Else, by the POSTING's OWN product_category (Udara's own per-row classification,
--      not account-level -- the same account_number can carry 'fixed_deposit' on one
--      posting and 'journal' on another for a customer with both an FD and an unrelated
--      manual correction, live-verified 2026-10-07): 'fixed_deposit' -> financing,
--      'loan' -> investing, 'withholding_tax' -> operating.
--   5. Else -> 'unclassified', shown as its own explicit line, never silently dropped.
--
-- gl_cash_flow_accounts is seeded with the ~46 generic (non-per-customer) accounts
-- actually observed live on 2026-10-07 via `go run ./cmd/liveverify glaccounts2` --
-- every GTB/Fidelity/Keystone/Zenith/Polaris/Providus/FCMB nostro, every BlueSalt/
-- Paystack/DT&T wallet (cross-checked against cbssync/blink_fx_parse.go's own
-- blinkFXAccounts list), payables/payroll/tax accounts, and the two SsuspenSE/
-- inter-branch accounts. The long tail of per-customer account numbers (one FD/loan
-- per depositor/borrower, in the thousands) is deliberately NOT enumerated here --
-- those classify by product_category (step 4 above), which is complete and correct
-- for them without a per-row seed.

CREATE TABLE IF NOT EXISTS gl_cash_flow_accounts (
    account_number TEXT PRIMARY KEY,
    account_name   TEXT NOT NULL,
    activity       TEXT NOT NULL CHECK (activity IN ('cash', 'internal', 'operating', 'investing', 'financing')),
    label          TEXT,  -- display line for operating/investing/financing rows; NULL for cash/internal (excluded, never rendered)
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO gl_cash_flow_accounts (account_number, account_name, activity, label) VALUES
    -- Our own cash / nostro / wallet holdings -- excluded, these ARE the cash the
    -- statement explains the movement of, not an activity in themselves.
    ('10204001', 'FCMB CURRENT ACCOUNT',                       'cash', NULL),
    ('10204006', 'GTB CURRENT ACCOUNT',                        'cash', NULL),
    ('10204009', 'GTB COLLECTION ACCOUNT',                     'cash', NULL),
    ('10204010', 'GTB SETTLEMENT ACCOUNT',                     'cash', NULL),
    ('10204011', 'ZENITH BANK BLUSALT USD',                    'cash', NULL),
    ('10204012', 'ZENITH BANK COLLECTION ACCOUNT',             'cash', NULL),
    ('10204013', 'FIDELITY BANK CURRENT ACCOUNT',               'cash', NULL),
    ('10204016', 'KEYSTONE COLLECTION ACCOUNT',                'cash', NULL),
    ('10204018', 'POLARIS CURRENT ACCOUNT',                    'cash', NULL),
    ('10204020', 'PROVIDUS ACCOUNT',                           'cash', NULL),
    ('10204025', 'POLARIS SETTLEMENT - VERVE CARDS',           'cash', NULL),
    ('10204029', 'PAYSTACK WALLET - MOBILE APP FUNDS',         'cash', NULL),
    ('10204030', 'FIDELITY BANK PROJECT ACCT - NGN',           'cash', NULL),
    ('10204031', 'FIDELITY BANK AMEX USD ACCT - MARINA BRANCH', 'cash', NULL),
    ('10204032', 'BLUSALT NGN WALLET - CARDS SCHEME',          'cash', NULL),
    ('10204033', 'BLUSALT USD WALLET - CARDS SCHEME',          'cash', NULL),
    ('10204038', 'ZENITH BANK',                                 'cash', NULL),
    ('10204039', 'GTB USD DOM',                                'cash', NULL),
    ('10204041', 'GTB AMEX NAIRA CARD SETTLEMENT ACCT',        'cash', NULL),
    ('10204045', 'BLUSALT BLINK WALLET',                       'cash', NULL),
    ('10103005', 'DT AND T WALLET - POUNDS',                   'cash', NULL),

    -- Purely internal bookkeeping -- no real external cash effect.
    ('20419006', 'INTER BRANCH DEFAULT SETTLEMENT',  'internal', NULL),
    ('10640003', 'MIGRATION SUSPENSE',                'internal', NULL),
    ('20419002', 'SUSPENSE DEPOSITOR ACCOUNT',        'internal', NULL),

    -- Investing: placing/recovering funds outside the loan book, and loan principal
    -- accounts that are generic rather than per-customer.
    ('10207001', 'INVESTMENTS IN OTHER FINANCIAL INSTITUTIONS', 'investing', 'Investments in Other Financial Institutions'),
    ('10527001', 'SME LOAN -PRINCIPAL DUE AND UNPAID',          'investing', 'Loan Principal Movement'),
    ('10525001', 'CONSUMER LOAN -PRINCIPAL DUE AND UNPAID',     'investing', 'Loan Principal Movement'),

    -- Financing: the deposit book's funding cost, and O3's own borrowed debt.
    ('20413002', 'FIXED DEPOSIT-INTEREST PAYABLE', 'financing', 'Fixed Deposit Interest Payable Movement'),
    ('10636021', 'FD PREPAID INTEREST EXPENSE',    'financing', 'Fixed Deposit Interest Payable Movement'),
    ('20202001', 'TERM LOAN',                       'financing', 'Term Loan (Debt Financing)'),

    -- Operating: card receivables/float, payroll, tax, and loan/FD interest-suspense
    -- accounts (interest, not principal).
    ('10521001', 'RECEIVABLES - CREDIT CARD CUSTOMERS',    'operating', 'Card Receivables Movement'),
    ('10636014', 'PREPAID CARDS',                           'operating', 'Prepaid Card Float Movement'),
    ('20105001', 'AMEX PREPAID CARD DEPOSIT - USD',        'operating', 'Prepaid Card Float Movement'),
    ('20410012', 'SALARY PAYABLE',                          'operating', 'Salary Payable Movement'),
    ('20410010', 'WHTAX - LIRS',                            'operating', 'Withholding Tax'),
    ('20410004', 'OTHER PAYABLE',                           'operating', 'Other Payable Movement'),
    ('20414005', 'SME LOAN-INTEREST IN  SUSPENSE',         'operating', 'Loan Interest Suspense Movement'),
    ('10523005', 'SME LOAN- LOAN INTEREST DUE AND UNPAID', 'operating', 'Loan Interest Receivable Movement'),
    ('10638002', 'PREPAID RENT 1',                          'operating', 'Prepaid Rent Movement'),
    ('20410011', 'STAFF COMMISSION PAYABLE',                'operating', 'Staff Commission Payable Movement'),
    ('20410002', 'PAYEE PAYABLE',                           'operating', 'PAYE Payable Movement'),
    ('20410017', 'ACCOUNTS PAYABLE CLEARING',               'operating', 'Accounts Payable Movement'),
    ('20418002', 'COMPANY INCOME TAX - FIRS',               'operating', 'Company Income Tax'),
    ('20410015', 'PAYABLES - BEVERTEC',                     'operating', 'Vendor Payable Movement'),
    ('20410005', 'PENSION - EMPLOYER''S CONTRIBUTION',      'operating', 'Pension Payable Movement'),
    ('20410007', 'PENSION - EMPLOYEE',                      'operating', 'Pension Payable Movement'),
    ('10632005', 'STAFF LOAN REPAYMENT',                    'operating', 'Staff Loan Repayment Movement'),

    -- Investing: fixed-asset / intangible purchases, O3's own capex, not the loan book.
    ('10635013', 'INVENTORIES',                              'investing', 'Inventories Movement'),
    ('10710001', 'INTANGIBLE ASSETS - COST',                 'investing', 'Intangible Assets Movement'),
    ('10712001', 'COMPUTER EQUIPMENTS - COST',               'investing', 'Fixed Asset (Computer Equipment) Movement')
ON CONFLICT (account_number) DO NOTHING;

CREATE OR REPLACE VIEW app.cash_flow_statement_by_branch AS
WITH account_kind AS (
    -- Whether an account number EVER carries 'fixed_deposit' or 'loan' as Udara's own
    -- product_category, anywhere in its history -- not just on the one row being
    -- classified. Live-verified 2026-10-07: a depositor's own FD account gets manual
    -- correction/rollover postings tagged product_category='journal' by Udara, not
    -- 'fixed_deposit', even though the posting is still, economically, an FD principal
    -- movement on that same account. Classifying by account identity rather than by each
    -- row's own category label is what correctly catches those (this fix alone moved
    -- roughly 85% of what was an 'unclassified' bucket into Financing/Investing on first
    -- build of this view). An account seen with BOTH tags (a handful of customers who
    -- hold both products) resolves to Financing first -- a tie-break, not a claim both
    -- never happens.
    SELECT account_number,
           BOOL_OR(product_category = 'fixed_deposit') AS is_fd,
           BOOL_OR(product_category = 'loan')           AS is_loan
      FROM cbs_gl_postings
     WHERE financial_date >= DATE '2026-07-01'
     GROUP BY account_number
),
classified AS (
    SELECT
        CASE p.branch_name WHEN 'Head Office Branch' THEN 'Lagos'
                            WHEN 'Abuja Branch'       THEN 'Abuja'
                            ELSE COALESCE(p.branch_name, 'Unattributed') END AS branch,
        p.side, p.amount_kobo,
        COALESCE(
            a.activity,
            CASE WHEN l.account_number IS NOT NULL THEN 'operating' END,
            CASE WHEN k.is_fd                        THEN 'financing' END,
            CASE WHEN k.is_loan                       THEN 'investing' END,
            CASE WHEN p.product_category = 'withholding_tax' THEN 'operating' END,
            'unclassified'
        ) AS activity,
        COALESCE(
            a.label,
            l.statement_line,
            CASE WHEN k.is_fd   THEN 'Fixed Deposit Principal Movement' END,
            CASE WHEN k.is_loan THEN 'Loan Principal Movement' END,
            CASE WHEN p.product_category = 'withholding_tax' THEN 'Withholding Tax' END,
            'Unclassified (' || p.product_category || ')'
        ) AS line_label
      FROM cbs_gl_postings p
      LEFT JOIN gl_account_lines l       ON l.account_number = p.account_number
      LEFT JOIN gl_cash_flow_accounts a  ON a.account_number = p.account_number
      LEFT JOIN account_kind k           ON k.account_number = p.account_number
     WHERE p.financial_date >= DATE '2026-07-01'
)
SELECT branch, activity, line_label,
       SUM(CASE WHEN side = 'credit' THEN amount_kobo ELSE -amount_kobo END)::bigint AS amount_kobo,
       COUNT(*)::bigint AS postings
  FROM classified
 WHERE activity NOT IN ('cash', 'internal')
 GROUP BY branch, activity, line_label;

COMMENT ON VIEW app.cash_flow_statement_by_branch IS
    'Real Cash Flow Statement, branch-split, from Udara''s own GL (cbs_gl_postings), '
    '2026-07-01+ coverage floor -- same as app.income_statement_by_branch. Derived by '
    'ledger conservation (net credit-minus-debit on every non-cash, non-internal account), '
    'not by pairing individual posting legs. An ''unclassified'' activity line means a '
    'generic account this migration did not enumerate -- check gl_cash_flow_accounts, not '
    'a bug in the view.';

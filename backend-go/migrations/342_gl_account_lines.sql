-- 342: a lookup from Udara's real GL account numbers to the statement line a report
-- groups them under, so Finance can see (and later adjust) the categorisation without a
-- redeploy -- same pattern as app.cbn_sector_codes.
--
-- Seeded from the 90 real Income (4xxxx) and Expense (5xxxx) accounts observed live in
-- app.cbs_gl_postings as of 2026-10-06. Deliberately excludes the 1xxxx/2xxxx (Asset/
-- Liability) accounts: those are the balance-sheet side, already read directly by
-- app.financial_position_by_branch (migration 339) without needing a label -- this table
-- exists for the Income Statement and the Total Revenue drill-down, both of which only
-- read Income/Expense accounts.
--
-- product_label carries the per-product/per-category split the drill-down needs (e.g.
-- 'Platinum', 'SME', 'Prepaid'); it is NULL where the account is already generic (e.g.
-- 'OTHER INCOME').
--
-- Rent is a special case, flagged rather than solved here: 'RENT - HEAD OFFICE' (Rent 1)
-- and 'RENT 3 - ABUJA OFFICE' already carry the right branch via
-- cbs_gl_postings.branch_name directly (whoever posts to Udara books them at the right
-- branch already). 'RENT 2 - DIRECTORS HOUSE' does NOT get a branch override in this
-- table -- the decision that it attributes to Lagos/HQ regardless of which branch posted
-- it is applied in the Phase 9 income-statement query, not baked into this lookup, so the
-- override stays visible at the one place it actually changes behaviour.
CREATE TABLE IF NOT EXISTS gl_account_lines (
    account_number   TEXT PRIMARY KEY,
    account_name     TEXT NOT NULL,
    statement_line   TEXT NOT NULL,
    product_label    TEXT,
    statement        TEXT NOT NULL CHECK (statement IN ('income','expense')),
    sort_order       INT NOT NULL DEFAULT 0
);

COMMENT ON TABLE gl_account_lines IS
    'Udara GL account number -> Income Statement line + product label. Income/Expense '
    'accounts only (4xxxx/5xxxx) -- Asset/Liability accounts are read directly by '
    'app.financial_position_by_branch and need no label. Editable by Finance without a '
    'redeploy; a new GL account that appears in app.cbs_gl_postings with no row here '
    'falls back to an ''Unclassified'' bucket rather than being silently dropped (see '
    'revenue_breakdown.go / finance_income_statement.go).';

INSERT INTO gl_account_lines (account_number, account_name, statement_line, product_label, statement, sort_order) VALUES
    -- Income: card fees
    ('40102004', 'ACCOUNT MAINTENANCE',                    'Card Fee Income',          'Maintenance',  'income', 10),
    ('40102015', 'PENALTIES - PREPAID CARDS',               'Card Penalty Income',      'Prepaid',      'income', 11),
    ('40102025', 'FEES - PREPAID CARDS',                     'Card Fee Income',          'Prepaid',      'income', 10),
    ('40102026', 'FEES - PLATINUM CARDS',                    'Card Fee Income',          'Platinum',     'income', 10),
    ('40102028', 'FEES - CLASSIC CARDS',                     'Card Fee Income',          'Classic',      'income', 10),
    ('40102032', 'FEES - PRESTIGE CARDS',                    'Card Fee Income',          'Prestige',     'income', 10),
    ('40102040', 'JOINING FEES',                             'Card Joining Fee Income',  NULL,           'income', 12),
    ('40102044', 'FEES INCOME - AMEX NGN CARDS',             'Card Fee Income',          'Amex NGN',     'income', 10),
    ('40102049', 'JOINING FEES - AMEX CARDS',                'Card Joining Fee Income',  'Amex',         'income', 12),
    -- Income: loan fees
    ('40102007', 'CONSUMER LOAN- FEE INCOME',                'Loan Fee Income',          'Individual',   'income', 20),
    -- Income: interest on investments
    ('40203001', 'INTEREST ON INVESTMENT WITH OTHER FINANCIAL INSTITUTIONS', 'Interest on Investments', NULL, 'income', 30),
    -- Income: loan interest
    ('40304003', 'CONSUMER LOAN-INTEREST INCOME',           'Loan Interest Income',     'Individual',   'income', 1),
    ('40304005', 'SME LOAN-INTEREST INCOME',                 'Loan Interest Income',     'SME',          'income', 1),
    ('40304012', 'INTEREST ON LOAN',                         'Loan Interest Income',     'Unspecified',  'income', 1),
    ('40304024', 'INTEREST INCOME - LOANS & CARDS',          'Other Interest Income',    NULL,           'income', 40),
    -- Income: card interest, by product
    ('40304007', 'INTEREST - PLATINUM CARDS',                'Card Interest Income',     'Platinum',     'income', 2),
    ('40304008', 'INTEREST - BUSINESS CARDS',                'Card Interest Income',     'Business',     'income', 2),
    ('40304009', 'INTEREST - CLASSIC CARDS',                 'Card Interest Income',     'Classic',      'income', 2),
    ('40304010', 'INTEREST - GAMES CARDS',                    'Card Interest Income',     'Games',        'income', 2),
    ('40304013', 'INTEREST - PRESTIGE CARDS',                 'Card Interest Income',     'Prestige',     'income', 2),
    ('40304014', 'INTEREST - MEMCOS CARDS',                   'Card Interest Income',     'Memcos Coop',  'income', 2),
    ('40304015', 'INTEREST - NOHIL COOP',                     'Card Interest Income',     'Nohil Coop',   'income', 2),
    ('40304016', 'INTEREST - AIRTEL COOP',                    'Card Interest Income',     'Airtel Coop',  'income', 2),
    ('40304017', 'INTEREST - LIRS COOP',                      'Card Interest Income',     'Lirs Coop',    'income', 2),
    ('40304018', 'INTEREST - LBIC COOP',                      'Card Interest Income',     'Lbic Coop',    'income', 2),
    ('40304020', 'INTEREST - SENIOR STAFF ASSOCIATION OF NIGERIA -UI', 'Card Interest Income', 'Senior Staff Association (UI)', 'income', 2),
    ('40304021', 'INTEREST - BB CLASSIC',                     'Card Interest Income',     'BB Classic',   'income', 2),
    ('40304022', 'INTEREST - INSIGHT',                        'Card Interest Income',     'Insight',      'income', 2),
    ('40304023', 'AMEX USD CREDIT CARD - INTEREST INCOME',    'Card Interest Income',     'Amex USD',     'income', 2),
    -- Income: other
    ('40405001', 'OTHER INCOME',                              'Other Income',             NULL,           'income', 90),

    -- Expense
    ('50101003', 'INTEREST EXPENSE ON FIXED DEPOSIT',         'Interest Expense - Deposits', NULL,        'expense', 1),
    ('50204001', 'DIRECTORS EXPENSES',                        'Directors Expenses',       NULL,           'expense', 50),
    ('50205001', 'CONNECTIVITY',                               'Connectivity',             NULL,           'expense', 50),
    ('50205004', 'CALL CENTRE COSTS',                          'Call Centre Costs',        NULL,           'expense', 50),
    ('50205008', 'BUSINESS DEVELOPMENT',                       'Business Development',     NULL,           'expense', 50),
    ('50205009', 'CREDIT BUREAU EXPENSE',                       'Credit Bureau Expense',    NULL,           'expense', 50),
    ('50205010', 'STAFF COMMISSION',                           'Staff Commission',         NULL,           'expense', 50),
    ('50205011', 'COMMISSION - FIXED DEPOSIT FINDERS',         'FD Finder Commission',     NULL,           'expense', 50),
    ('50205015', 'DIGITAL CHANNEL CHARGES',                     'Digital Channel Charges',  NULL,           'expense', 50),
    ('50205016', 'BANK CHARGES - AMEX SETTLEMENT TRANSACTIONS', 'Bank Charges',             'Amex Settlement', 'expense', 50),
    ('50205017', 'CARRIAGE COST',                               'Carriage Cost',            NULL,           'expense', 50),
    ('50205018', 'TELEPHONE',                                   'Telephone',                NULL,           'expense', 50),
    ('50205019', 'OFFICE EXPENSES',                             'Office Expenses',          NULL,           'expense', 50),
    ('50205020', 'RENT - HEAD OFFICE',                          'Rent',                     'Rent 1 - Head Office',    'expense', 5),
    ('50205021', 'RENT 2 - DIRECTORS HOUSE',                    'Rent',                     'Rent 2 - Directors House','expense', 5),
    ('50205022', 'RENT 3 - ABUJA OFFICE',                       'Rent',                     'Rent 3 - Abuja Office',   'expense', 5),
    ('50205023', 'BANK CHARGES',                                'Bank Charges',             NULL,           'expense', 50),
    ('50205025', 'TRAVELLING & ACCOMMODATION',                  'Travel & Accommodation',   NULL,           'expense', 50),
    ('50205028', 'WATER EXPENSES',                              'Utilities',                'Water',        'expense', 50),
    ('50205029', 'LOCAL TRANSPORT',                             'Transport',                NULL,           'expense', 50),
    ('50205030', 'TOLL GATE/CAR PARK FEE',                      'Transport',                'Toll/Parking', 'expense', 50),
    ('50205032', 'FUEL EXPENSES',                                'Motor Vehicle Expenses',   'Fuel (general)', 'expense', 50),
    ('50205033', 'OFFICE PROVISION',                            'Office Expenses',          'Provision',    'expense', 50),
    ('50205034', 'IT EXPENSES',                                 'IT Expenses',              NULL,           'expense', 50),
    ('50205036', 'PRINTING & STATIONERIES',                     'Office Expenses',          'Printing & Stationery', 'expense', 50),
    ('50205039', 'PUBLICITY AND PUBLIC RELATIONS',              'Marketing & PR',           'Publicity/PR', 'expense', 50),
    ('50205041', 'ADVERTISEMENT & SOCIAL MEDIA',                'Marketing & PR',           'Advertising/Social', 'expense', 50),
    ('50205043', 'SUBSCRIPTION',                                'Subscriptions',            NULL,           'expense', 50),
    ('50205044', 'TRANSPORT',                                   'Transport',                NULL,           'expense', 50),
    ('50205045', 'MAINTENANCE & REPAIRS OFFICE EQUIPMENT',      'Maintenance & Repairs',     'Office Equipment', 'expense', 50),
    ('50205048', 'ELECTRICITY BILL - PHCN',                      'Utilities',                'Electricity',  'expense', 50),
    ('50205049', 'FEES & PENALTIES',                             'Fees & Penalties',          NULL,           'expense', 50),
    ('50205050', 'PROFESSIONAL FEES',                            'Professional Fees',        NULL,           'expense', 50),
    ('50205051', 'RATES & OCCUPANCY EXPENSES',                   'Rates & Occupancy',        NULL,           'expense', 50),
    ('50205052', 'DEBT RECOVERY EXPENSE',                        'Debt Recovery Expense',     NULL,           'expense', 50),
    ('50205053', 'ENTERTAINMENT',                                'Entertainment',             NULL,           'expense', 50),
    ('50205054', 'AUDITOR''S FEES',                              'Professional Fees',        'Audit',        'expense', 50),
    ('50205067', 'FST 138 GH MOTOR VEHICLE EXPENSES ASH TOYOTA COROLLA',   'Motor Vehicle Expenses', 'FST 138 GH', 'expense', 50),
    ('50205068', 'APP 680 GF MOTOR VEHICLE EXPENSES BLACK TOYOTA COROLLA', 'Motor Vehicle Expenses', 'APP 680 GF', 'expense', 50),
    ('50205070', 'SMK 592 GT MOTOR VEHICLE EXPENSES',            'Motor Vehicle Expenses',    'SMK 592 GT',   'expense', 50),
    ('50205071', 'AGL 741 GU MOTOR VEHICLES EXPENSES',           'Motor Vehicle Expenses',    'AGL 741 GU',   'expense', 50),
    ('50205072', 'AKD 245 HA MOTOR VEHICLE EXPENSES',            'Motor Vehicle Expenses',    'AKD 245 HA',   'expense', 50),
    ('50205073', 'AAA 534 HB MOTOR VEHICLE EXPENSES',            'Motor Vehicle Expenses',    'AAA 534 HB',   'expense', 50),
    ('50205074', 'KJA 734 JS - FUEL & REPAIRS',                  'Motor Vehicle Expenses',    'KJA 734 JS',   'expense', 50),
    ('50205075', 'EKY 726 JS - FUEL & REPAIRS',                  'Motor Vehicle Expenses',    'EKY 726 JS',   'expense', 50),
    ('50205076', 'LND 504 JS - FUEL & REPAIRS',                  'Motor Vehicle Expenses',    'LND 504 JS',   'expense', 50),
    ('50205077', 'EKY 727 JS - FUEL & REPAIRS',                  'Motor Vehicle Expenses',    'EKY 727 JS',   'expense', 50),
    ('50205078', 'LND 519 JS - FUEL & REPAIRS',                  'Motor Vehicle Expenses',    'LND 519 JS',   'expense', 50),
    ('50205079', 'KJA 36 HM MOTOR VEHICLE EXPENSES',             'Motor Vehicle Expenses',    'KJA 36 HM',    'expense', 50),
    ('50205080', 'LND 767 HN MOTOR VEHICLE EXPENSES',            'Motor Vehicle Expenses',    'LND 767 HN',   'expense', 50),
    ('50205086', 'FST 138 GH FUEL EXPENSES ASH TOYOTA COROLLA',  'Motor Vehicle Expenses',    'FST 138 GH',   'expense', 50),
    ('50205087', 'APP 680 GF FUEL EXPENSES BLACK TOYOTA COROLLA','Motor Vehicle Expenses',    'APP 680 GF',   'expense', 50),
    ('50205089', 'SMK 592 GT FUEL EXPENSES',                     'Motor Vehicle Expenses',    'SMK 592 GT',   'expense', 50),
    ('50205090', 'AGL 741 GU FUEL EXPENSES',                     'Motor Vehicle Expenses',    'AGL 741 GU',   'expense', 50),
    ('50205091', 'AKD 245 HA FUEL EXPENSES',                     'Motor Vehicle Expenses',    'AKD 245 HA',   'expense', 50),
    ('50205092', 'AAA 534 HB FUEL EXPENSES',                     'Motor Vehicle Expenses',    'AAA 534 HB',   'expense', 50),
    ('50205093', 'LND 767 HN FUEL EXPENSES',                     'Motor Vehicle Expenses',    'LND 767 HN',   'expense', 50),
    ('50205094', 'KJA 36 HM FUEL EXPENSES',                      'Motor Vehicle Expenses',    'KJA 36 HM',    'expense', 50),
    ('50205096', 'FST 823 KL - FUEL',                            'Motor Vehicle Expenses',    'FST 823 KL',   'expense', 50),
    ('50205097', 'FST 823 KL - REPAIRS',                         'Motor Vehicle Expenses',    'FST 823 KL',   'expense', 50),
    ('50205099', 'FST 965 KK - REPAIRS',                         'Motor Vehicle Expenses',    'FST 965 KK',   'expense', 50),
    ('50205100', 'FST 823 KL - FUEL & REPAIRS',                  'Motor Vehicle Expenses',    'FST 823 KL',   'expense', 50),
    ('50205101', 'FST 965 KK - FUEL & REPAIRS',                  'Motor Vehicle Expenses',    'FST 965 KK',   'expense', 50),
    ('50208001', 'TRAINING AND DEVELOPMENT',                     'Training & Development',   NULL,           'expense', 50),
    ('50208003', 'STAFF ALLOWANCES',                             'Staff Costs',              'Allowances',   'expense', 51),
    ('50208005', 'PENSION B',                                    'Staff Costs',              'Pension',      'expense', 51),
    ('50208007', 'STAFF WELFARE',                                'Staff Costs',              'Welfare',      'expense', 51),
    ('50208008', 'MD''S SALARIES',                               'Staff Costs',              'MD Salary',    'expense', 51),
    ('50208009', 'SALARIES AND WAGES',                           'Staff Costs',              'Salaries & Wages', 'expense', 51),
    ('50208010', 'MEDICAL EXPENSES',                             'Staff Costs',              'Medical',      'expense', 51),
    ('50211001', 'COMPANY INCOME TAX',                           'Company Income Tax',       NULL,           'expense', 99)
ON CONFLICT (account_number) DO NOTHING;

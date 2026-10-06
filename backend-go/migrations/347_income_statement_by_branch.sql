-- 344: a real Income Statement, split by branch, off Udara's own GL accounts
-- (app.cbs_gl_postings joined to app.gl_account_lines, migration 342) rather than the
-- narrower product_category bucketing the original finance-model plan used.
--
-- Branch is read from the POSTING's own branch_name (Lagos/Abuja) for every line
-- EXCEPT Rent, where live data forced an exception: "RENT 3 - ABUJA OFFICE" postings
-- are split across BOTH branch tags today (₦3,833,333.32 recorded under 'Head Office
-- Branch', ₦1,916,666.66 under 'Abuja Branch', for the same Abuja-named expense) —
-- confirmed live 2026-10-06. The posting's branch tag reflects which branch's books the
-- entry went through, not necessarily which office the cost is FOR, and for Rent the
-- account name already says which office that is, more reliably than the tag. So Rent
-- is attributed by its own product_label (Rent 1/2 -> Lagos, Rent 3 -> Abuja — Rent 2,
-- Director's House, decided with the user to sit with Lagos/HQ overhead) regardless of
-- which branch happened to post it. No other line gets this override without the same
-- kind of evidence.
--
-- Coverage ceiling: 2026-07-01 forward only (Udara's own ledger history floor, same as
-- every other Phase-1/7 figure) — carried in the view as a constant the handler surfaces
-- explicitly rather than let an earlier date range render as a silent zero.
CREATE OR REPLACE VIEW app.income_statement_by_branch AS
WITH rent AS (
    SELECT CASE WHEN l.product_label LIKE 'Rent 3%' THEN 'Abuja' ELSE 'Lagos' END AS branch,
           l.statement_line, l.product_label, l.statement,
           SUM(CASE WHEN p.side = 'debit' THEN p.amount_kobo ELSE -p.amount_kobo END) AS amount_kobo,
           COUNT(*) AS postings
      FROM cbs_gl_postings p
      JOIN gl_account_lines l ON l.account_number = p.account_number
     WHERE l.statement_line = 'Rent'
     GROUP BY 1, l.statement_line, l.product_label, l.statement
),
income AS (
    SELECT CASE p.branch_name WHEN 'Head Office Branch' THEN 'Lagos'
                               WHEN 'Abuja Branch'       THEN 'Abuja'
                               ELSE COALESCE(p.branch_name, 'Unattributed') END AS branch,
           l.statement_line, l.product_label, l.statement,
           SUM(CASE WHEN p.side = 'credit' THEN p.amount_kobo ELSE -p.amount_kobo END) AS amount_kobo,
           COUNT(*) AS postings
      FROM cbs_gl_postings p
      JOIN gl_account_lines l ON l.account_number = p.account_number
     WHERE l.statement = 'income'
     GROUP BY 1, l.statement_line, l.product_label, l.statement
),
expense_ex_rent AS (
    SELECT CASE p.branch_name WHEN 'Head Office Branch' THEN 'Lagos'
                               WHEN 'Abuja Branch'       THEN 'Abuja'
                               ELSE COALESCE(p.branch_name, 'Unattributed') END AS branch,
           l.statement_line, l.product_label, l.statement,
           SUM(CASE WHEN p.side = 'debit' THEN p.amount_kobo ELSE -p.amount_kobo END) AS amount_kobo,
           COUNT(*) AS postings
      FROM cbs_gl_postings p
      JOIN gl_account_lines l ON l.account_number = p.account_number
     WHERE l.statement = 'expense' AND l.statement_line <> 'Rent'
     GROUP BY 1, l.statement_line, l.product_label, l.statement
)
SELECT branch, statement_line, product_label, statement, amount_kobo, postings FROM income
UNION ALL
SELECT branch, statement_line, product_label, statement, amount_kobo, postings FROM expense_ex_rent
UNION ALL
SELECT branch, statement_line, product_label, statement, amount_kobo, postings FROM rent;

COMMENT ON VIEW app.income_statement_by_branch IS
    'Real Income Statement, branch-split, from Udara''s own GL (app.cbs_gl_postings via '
    'app.gl_account_lines, migration 342). Covers 2026-07-01 forward only. Card/other loan '
    'fee lines here are GL-sourced only (sparse where that''s all that exists) — '
    'handlers/revenue_breakdown.go folds in app.fee_income/app.loan_fee_income manual '
    'entries on top for the drill-down; this view deliberately does not, so it stays a '
    'pure read of what Udara''s ledger says.';

-- 339: app.financial_position, split by branch (Lagos/Abuja) rather than the whole
-- company at once.
--
-- SAME SOURCES AS app.financial_position (migration 282), same NET POSITION framing --
-- this is not a second source of truth, it is the same books of record grouped by one
-- more dimension. Read that view's own comment for why "net position" and not "equity":
-- nothing here changes that; it still holds.
--
-- BRANCH, PER LINE:
--   Loan Receivable, Fixed Deposit Principal/Interest Payable: cbs_loans.branch_name /
--     cbs_fixed_deposits.branch_name directly -- Udara gives this on every record,
--     already 100% populated (migration 133), live-verified 2026-10-06. Exactly two
--     values company-wide: 'Head Office Branch' (= Lagos, the HQ) and 'Abuja Branch'.
--     Displayed as such -- translation happens HERE, at the one view every branch report
--     reads, not re-derived in every handler.
--   Card Receivable, Card Customer Float: Udara has no branch concept for cards at all
--     (a separate Interswitch/Providus feed entirely). The only attribution path is
--     app.v_card_sale_officer -> o3c_users.office_location, which resolves close to
--     0 of today's ~18,400 card accounts (card_issuance_requests/card_sale_attributions
--     are both empty) -- so almost the entire card book reports as 'Unattributed' today,
--     by construction, not by bug. It self-heals as the existing (built, unused) card
--     Issuance flow sees real use: once sales_officer_id is actually recorded on a sale,
--     that specific card resolves to a branch on its next read of this view, no further
--     migration required.
--
-- OPENING EQUITY per branch rolls in migration 338's frozen 2026-01-01 seed. Retained
-- earnings (net income accumulated since then) is DELIBERATELY NOT added here -- that
-- requires migration 340's income statement, and keeping it out keeps this view a pure
-- balance snapshot; the Go handler that serves a point-in-time Balance Sheet adds
-- retained earnings on top as one documented step, rather than duplicating that logic
-- in SQL.
CREATE OR REPLACE VIEW app.financial_position_by_branch AS
WITH lines AS (
    SELECT CASE branch_name WHEN 'Head Office Branch' THEN 'Lagos'
                             WHEN 'Abuja Branch'       THEN 'Abuja'
                             ELSE COALESCE(branch_name, 'Unattributed') END AS branch,
           'NGN'::text AS currency, 'Asset'::text AS side, 1 AS sort,
           'Loan Receivable'::text AS line, '1100'::text AS gl_code,
           COALESCE(SUM(outstanding_principal_kobo), 0)::bigint AS amount_kobo,
           COUNT(*)::bigint AS items
      FROM cbs_loans WHERE status NOT IN ('Closed', 'Revoked')
     GROUP BY branch_name

    UNION ALL
    SELECT CASE branch_name WHEN 'Head Office Branch' THEN 'Lagos'
                             WHEN 'Abuja Branch'       THEN 'Abuja'
                             ELSE COALESCE(branch_name, 'Unattributed') END,
           'NGN', 'Liability', 1,
           'Fixed Deposit Principal', '2100',
           COALESCE(SUM(principal_kobo), 0)::bigint, COUNT(*)::bigint
      FROM cbs_fixed_deposits
     WHERE status = 'Active' AND raw->>'hasDisbursed' IS DISTINCT FROM 'false'
     GROUP BY branch_name

    UNION ALL
    SELECT CASE branch_name WHEN 'Head Office Branch' THEN 'Lagos'
                             WHEN 'Abuja Branch'       THEN 'Abuja'
                             ELSE COALESCE(branch_name, 'Unattributed') END,
           'NGN', 'Liability', 2,
           'Fixed Deposit Interest Payable', '2110',
           COALESCE(SUM(accrued_interest_kobo), 0)::bigint, COUNT(*)::bigint
      FROM cbs_fixed_deposits
     WHERE status = 'Active' AND raw->>'hasDisbursed' IS DISTINCT FROM 'false'
     GROUP BY branch_name

    -- Cards: resolved via the officer-attribution join where one exists, 'Unattributed'
    -- otherwise. Udara itself carries no branch field for a card account.
    UNION ALL
    SELECT COALESCE(
               CASE u.office_location WHEN 'Lagos (Head Quarter)' THEN 'Lagos'
                                       WHEN 'Abuja'                THEN 'Abuja'
                                       ELSE NULL END,
               'Unattributed'),
           b.currency, 'Asset', 2, 'Card Receivable',
           CASE WHEN b.currency = 'USD' THEN '1210' ELSE '1200' END,
           COALESCE(SUM(b.receivable_kobo), 0)::bigint,
           COUNT(*) FILTER (WHERE b.receivable_kobo > 0)::bigint
      FROM app.card_balances b
      LEFT JOIN app.v_card_sale_officer o ON o.account_no = b.account_no
      LEFT JOIN o3c_users u ON u.id = o.officer_id
     GROUP BY 1, b.currency

    UNION ALL
    SELECT COALESCE(
               CASE u.office_location WHEN 'Lagos (Head Quarter)' THEN 'Lagos'
                                       WHEN 'Abuja'                THEN 'Abuja'
                                       ELSE NULL END,
               'Unattributed'),
           b.currency, 'Liability', 3, 'Card Customer Float',
           CASE WHEN b.currency = 'USD' THEN '2210' ELSE '2200' END,
           COALESCE(SUM(b.float_kobo), 0)::bigint,
           COUNT(*) FILTER (WHERE b.float_kobo > 0)::bigint
      FROM app.card_balances b
      LEFT JOIN app.v_card_sale_officer o ON o.account_no = b.account_no
      LEFT JOIN o3c_users u ON u.id = o.officer_id
     GROUP BY 1, b.currency

    -- Opening Equity, frozen at 2026-01-01 (migration 338) -- NOT retained earnings since;
    -- see header.
    UNION ALL
    SELECT CASE branch_name WHEN 'Head Office Branch' THEN 'Lagos'
                             WHEN 'Abuja Branch'       THEN 'Abuja'
                             ELSE branch_name END,
           'NGN', 'Equity', 9, 'Opening Equity (2026-01-01)', '3000',
           amount_kobo, 1
      FROM gl_opening_balances
     WHERE as_of_date = DATE '2026-01-01' AND line = 'Opening Equity'
)
SELECT branch, currency, side, sort, line, gl_code, amount_kobo, items
  FROM lines
 WHERE amount_kobo <> 0;

COMMENT ON VIEW app.financial_position_by_branch IS
    'app.financial_position split by branch (Lagos/Abuja/Unattributed). Same sources, '
    'same net-position framing -- NOT equity, no capital/reserves figure exists anywhere '
    'in this system except the frozen, flagged-estimate plug in gl_opening_balances. '
    'Cards report mostly Unattributed today: Udara has no branch concept for them, and '
    'the officer-attribution tables behind the only available join are empty until the '
    'existing card Issuance flow sees real use. Consolidated = SUM across branch, done by '
    'the caller, not duplicated as a second view.';

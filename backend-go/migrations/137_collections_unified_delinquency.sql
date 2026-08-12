-- 137_collections_unified_delinquency.sql
-- Collections go-live: a single unified delinquency source spanning BOTH books —
-- the card/customer arrears book (app.accounts) and the Udara loan book
-- (app.cbs_loans) — keyed by CIF (cbs_loans.cbs_customer_id = app.accounts.cif).
-- This view feeds the assignment-generation job and the collections dashboard so
-- the module runs on real data instead of the near-empty native loan tables.

-- Assignments carry the customer name for display (queue/promises reference it).
ALTER TABLE app.collection_assignments ADD COLUMN IF NOT EXISTS customer_name text;

-- Generated assignments start UNASSIGNED (a head distributes them), so the agent
-- must be nullable.
ALTER TABLE app.collection_assignments ALTER COLUMN agent_user_id DROP NOT NULL;

CREATE OR REPLACE VIEW app.collections_delinquent_unified AS
SELECT u.*,
  CASE
    WHEN u.dpd <= 0   THEN '0'
    WHEN u.dpd <= 30  THEN '1-30'
    WHEN u.dpd <= 60  THEN '31-60'
    WHEN u.dpd <= 90  THEN '61-90'
    WHEN u.dpd <= 180 THEN '91-180'
    WHEN u.dpd <= 360 THEN '181-360'
    ELSE '360+'
  END AS dpd_bucket
FROM (
  -- Card / customer arrears (real, ~1,200 actionable accounts)
  SELECT
    a.cif::text                                                        AS cif,
    COALESCE(NULLIF(c.full_name,''), NULLIF(a.name_on_card,''), a.cif) AS customer_name,
    COALESCE(NULLIF(a.product_name,''), NULLIF(a.card_product,''), 'Card') AS product_name,
    'card'::text                                                       AS source,
    GREATEST(0, COALESCE(a.days_overdue,0))::int                       AS dpd,
    ROUND(COALESCE(a.current_dr_balance,0) * 100)::bigint              AS outstanding_kobo
  FROM app.accounts a
  LEFT JOIN app.customers c ON c.cif = a.cif
  WHERE COALESCE(a.days_overdue,0) > 0
    AND COALESCE(a.current_dr_balance,0) > 0
  UNION ALL
  -- Udara loan book. DPD = days past maturity; a 'Defaulting' loan not yet past
  -- maturity is floored to 1 day so it still surfaces as delinquent.
  SELECT
    l.cbs_customer_id::text                                            AS cif,
    COALESCE(NULLIF(c.full_name,''), l.cbs_customer_id)                AS customer_name,
    COALESCE(NULLIF(l.product_name,''), 'Loan')                        AS product_name,
    'loan'::text                                                       AS source,
    GREATEST(
      GREATEST(0, (CURRENT_DATE - l.maturity_date::date))::int,
      CASE WHEN l.status = 'Defaulting' THEN 1 ELSE 0 END
    )                                                                  AS dpd,
    (COALESCE(l.outstanding_principal_kobo,0)
     + COALESCE(l.outstanding_interest_kobo,0)
     + COALESCE(l.outstanding_fee_kobo,0))::bigint                     AS outstanding_kobo
  FROM app.cbs_loans l
  LEFT JOIN app.customers c ON c.cif = l.cbs_customer_id
  WHERE l.status NOT IN ('Closed','Revoked')
    AND (GREATEST(0,(CURRENT_DATE - l.maturity_date::date)) > 0 OR l.status = 'Defaulting')
    AND (COALESCE(l.outstanding_principal_kobo,0)
         + COALESCE(l.outstanding_interest_kobo,0)
         + COALESCE(l.outstanding_fee_kobo,0)) > 0
) u;

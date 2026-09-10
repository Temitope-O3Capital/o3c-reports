-- 198_card_dpd_from_due_date.sql
--
-- The card book's app.accounts.days_overdue field is unreliable — the feed ships values
-- in the thousands of days (median ~681, max 3077) that do not match the account's own
-- payment_due_date (e.g. days_overdue=3077 on a card whose statement fell due 2 days ago).
-- It inflated the collections book and buried real cases behind junk-high-DPD rows.
--
-- payment_due_date is 100% populated and trustworthy, so card DPD is recomputed from it:
--   dpd = days since the statement due date (past due only), floored at 0.
-- A card is delinquent when it carries a debit balance AND its due date has passed. Cards
-- with a future due date (paid up to the current cycle) correctly drop out of the book.
-- Falls back to the (capped) feed value only if a due date is somehow missing.
--
-- Recreating the view fixes every consumer at once: the collections portfolio KPIs, the
-- assignment-generation job and anything else reading collections_delinquent_unified. The
-- loan arm is unchanged (its DPD is schedule/maturity-derived and already correct).

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
  -- Card / customer arrears. DPD = days since payment_due_date (past due), NOT the
  -- unreliable feed days_overdue.
  SELECT
    a.cif::text                                                        AS cif,
    COALESCE(NULLIF(c.full_name,''), NULLIF(a.name_on_card,''), a.cif) AS customer_name,
    COALESCE(NULLIF(a.product_name,''), NULLIF(a.card_product,''), 'Card') AS product_name,
    'card'::text                                                       AS source,
    CASE
      WHEN a.payment_due_date IS NOT NULL
        THEN GREATEST(0, (CURRENT_DATE - a.payment_due_date::date))::int
      ELSE LEAST(GREATEST(0, COALESCE(a.days_overdue,0)), 360)::int
    END                                                                AS dpd,
    ROUND(COALESCE(a.current_dr_balance,0) * 100)::bigint              AS outstanding_kobo
  FROM app.accounts a
  LEFT JOIN app.customers c ON c.cif = a.cif
  WHERE COALESCE(a.current_dr_balance,0) > 0
    AND (
      (a.payment_due_date IS NOT NULL AND a.payment_due_date::date < CURRENT_DATE)
      OR (a.payment_due_date IS NULL AND COALESCE(a.days_overdue,0) > 0)
    )
  UNION ALL
  -- Udara loan book. DPD = days past maturity; a 'Defaulting' loan not yet past
  -- maturity is floored to 1 day so it still surfaces as delinquent. (Unchanged.)
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

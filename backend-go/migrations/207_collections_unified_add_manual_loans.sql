-- 207: the unified delinquency view must include the manually-uploaded loans, and
-- its card/loan DPD must match the Portfolio account list so KPIs reconcile with rows.
--
-- Three arms now: (1) card arrears from app.accounts, DPD from the statement due date
-- (migration 198 basis — same as the Portfolio list), (2) Udara loans via
-- app.cbs_loan_dpd() (same as the list), (3) the manually-uploaded loans held in
-- collection_assignments (product_type='loan', data_source='manual') — previously
-- invisible to every Portfolio/Overview KPI and PAR band. Output columns unchanged.
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
  -- (1) Card / customer arrears — DPD from the statement due date (falls back to a
  -- capped feed value), matching the Portfolio account list.
  SELECT
    a.cif::text                                                        AS cif,
    COALESCE(NULLIF(TRIM(c.first_name||' '||COALESCE(c.last_name,'')),''),
             NULLIF(a.name_on_card,''), a.cif)                         AS customer_name,
    COALESCE(NULLIF(a.product_name,''), NULLIF(a.card_product,''), 'Card') AS product_name,
    'card'::text                                                       AS source,
    CASE WHEN a.payment_due_date IS NOT NULL
         THEN GREATEST(0, (CURRENT_DATE - a.payment_due_date::date))::int
         ELSE LEAST(GREATEST(0, COALESCE(a.days_overdue,0)), 360)::int END AS dpd,
    GREATEST(ROUND(COALESCE(a.current_dr_balance,0) * 100), 0)::bigint  AS outstanding_kobo
  FROM app.accounts a
  LEFT JOIN app.customers c ON c.cif = a.cif
  WHERE COALESCE(a.current_dr_balance,0) > 0
    AND ((a.payment_due_date IS NOT NULL AND a.payment_due_date::date < CURRENT_DATE)
      OR (a.payment_due_date IS NULL AND COALESCE(a.days_overdue,0) > 0))

  UNION ALL

  -- (2) Udara loan book — DPD via the shared cbs_loan_dpd() so it matches the list.
  SELECT
    cl.cbs_customer_id::text                                           AS cif,
    COALESCE(NULLIF(TRIM(c.first_name||' '||COALESCE(c.last_name,'')),''), cl.cbs_customer_id) AS customer_name,
    COALESCE(NULLIF(cl.product_name,''), 'Loan')                       AS product_name,
    'loan'::text                                                       AS source,
    app.cbs_loan_dpd(cl.status, cl.start_date, cl.maturity_date,
                     cl.first_installment_date, cl.loan_amount_kobo,
                     cl.outstanding_principal_kobo)                    AS dpd,
    (COALESCE(cl.outstanding_principal_kobo,0)
     + COALESCE(cl.outstanding_interest_kobo,0)
     + COALESCE(cl.outstanding_fee_kobo,0))::bigint                    AS outstanding_kobo
  FROM app.cbs_loans cl
  LEFT JOIN app.customers c ON c.cif = cl.cbs_customer_id
  WHERE cl.status NOT IN ('Closed','Revoked')
    AND app.cbs_loan_dpd(cl.status, cl.start_date, cl.maturity_date,
                         cl.first_installment_date, cl.loan_amount_kobo,
                         cl.outstanding_principal_kobo) > 0
    AND (COALESCE(cl.outstanding_principal_kobo,0)
         + COALESCE(cl.outstanding_interest_kobo,0)
         + COALESCE(cl.outstanding_fee_kobo,0)) > 0

  UNION ALL

  -- (3) Manually-uploaded loans (Loan Repayment CRM). DPD from maturity date, else the
  -- bucket recorded at import. Keyed by the assignment's customer key (account_cif).
  SELECT
    ca.account_cif::text                                               AS cif,
    COALESCE(NULLIF(TRIM(ca.customer_name),''), ca.account_cif)        AS customer_name,
    'Loan (uploaded)'::text                                            AS product_name,
    'loan'::text                                                       AS source,
    CASE WHEN ca.maturity_date IS NOT NULL
         THEN GREATEST(0, (CURRENT_DATE - ca.maturity_date))::int
         ELSE CASE ca.dpd_bucket
                WHEN '1-30' THEN 15 WHEN '31-60' THEN 45 WHEN '61-90' THEN 75
                WHEN '91-180' THEN 135 WHEN '181-360' THEN 270 WHEN '360+' THEN 400
                ELSE 0 END
         END                                                           AS dpd,
    COALESCE(ca.outstanding_kobo,0)::bigint                            AS outstanding_kobo
  FROM app.collection_assignments ca
  WHERE ca.product_type = 'loan' AND ca.data_source = 'manual' AND ca.status = 'active'
) u;

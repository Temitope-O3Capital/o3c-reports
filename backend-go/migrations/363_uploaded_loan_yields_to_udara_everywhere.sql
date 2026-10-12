-- Only an uploaded loan that is NOT on Udara belongs in the delinquency book.
--
-- Udara is the book of record (migration 268). An uploaded spreadsheet row whose
-- facility also exists on Udara is a MIRROR of it, not a second loan, and migrations
-- 268/287/288/289 already stamp the mirrors they could prove -- 8 of the 13 live
-- uploaded loans carry duplicate_of_cbs_id today.
--
-- app.collections_delinquent_unified ignored those stamps. Its uploaded arm filtered
-- only on product_type, data_source and status, so every proven mirror was counted a
-- second time alongside the Udara facility it mirrors:
--
--     uploaded arm            13 rows   152,205,835.34
--     of which proven mirrors  8 rows   125,644,167.33   <- counted twice
--
-- That is 83% of the arm, and NINE handlers read this view: the portfolio KPIs
-- (PAR30/60/90 and total outstanding), dunning, contact lists, recovery, batch and
-- the call-centre outbound queue all inflated the delinquency book by 125.6m and
-- would have dunned the same borrower twice for the same facility.
--
-- handlers/collections_portfolio.go already excluded them on its own list endpoint,
-- which is why the Credit Portfolio TABLE looked right while every figure derived
-- from this view did not -- the dedup lived in one of the two places that needed it.
--
-- The rule now has a single home: app.uploaded_loans_live. Any future consumer that
-- reads uploaded loans through it gets the dedup for free, and there is one place to
-- change when the matching improves.

-- Live uploaded loans: the spreadsheet rows that are NOT a Udara mirror and have not
-- been superseded. No status filter -- a closed facility is still credit history and
-- callers choose which statuses they want, exactly as the portfolio handler does.
CREATE OR REPLACE VIEW app.uploaded_loans_live AS
SELECT ca.*
  FROM app.collection_assignments ca
 WHERE ca.product_type = 'loan'
   AND ca.data_source  = 'manual'
   AND ca.duplicate_of_cbs_id IS NULL
   AND ca.superseded_by_id    IS NULL;

COMMENT ON VIEW app.uploaded_loans_live IS
  'Uploaded (spreadsheet) loans that are not a proven Udara mirror and not superseded. Read this rather than collection_assignments directly, or the delinquency book double-counts facilities that exist on Udara.';

CREATE OR REPLACE VIEW app.collections_delinquent_unified AS
 SELECT arm,
    raw_cif,
        CASE
            WHEN arm = 'udara'::text THEN 'UD-'::text || raw_cif
            ELSE raw_cif
        END AS key_cif,
    customer_name,
    product_name,
    source,
    dpd,
    outstanding_kobo,
        CASE
            WHEN dpd <= 0 THEN '0'::text
            WHEN dpd <= 30 THEN '1-30'::text
            WHEN dpd <= 60 THEN '31-60'::text
            WHEN dpd <= 90 THEN '61-90'::text
            WHEN dpd <= 180 THEN '91-180'::text
            WHEN dpd <= 360 THEN '181-360'::text
            ELSE '360+'::text
        END AS dpd_bucket,
    party_id
   FROM ( SELECT 'cards'::text AS arm,
            a.cif AS raw_cif,
            COALESCE(NULLIF(TRIM(BOTH FROM (c.first_name || ' '::text) || COALESCE(c.last_name, ''::text)), ''::text), NULLIF(a.name_on_card, ''::text), a.cif) AS customer_name,
            COALESCE(NULLIF(a.product_name, ''::text), NULLIF(a.card_product, ''::text), 'Card'::text) AS product_name,
            'card'::text AS source,
                CASE
                    WHEN a.payment_due_date IS NOT NULL THEN GREATEST(0, CURRENT_DATE - a.payment_due_date)
                    ELSE LEAST(GREATEST(0, COALESCE(a.days_overdue, 0)), 360)
                END AS dpd,
            GREATEST(round(COALESCE(a.current_dr_balance, 0::numeric) * 100::numeric), 0::numeric)::bigint AS outstanding_kobo,
            c.party_id
           FROM accounts a
             LEFT JOIN customers c ON c.cif = a.cif
          WHERE COALESCE(a.current_dr_balance, 0::numeric) > 0::numeric AND (a.payment_due_date IS NOT NULL AND a.payment_due_date < CURRENT_DATE OR a.payment_due_date IS NULL AND COALESCE(a.days_overdue, 0) > 0)
        UNION ALL
         SELECT 'udara'::text AS arm,
            cl.cbs_customer_id AS raw_cif,
            COALESCE(NULLIF(TRIM(BOTH FROM p.full_name), ''::text), NULLIF(TRIM(BOTH FROM cc.name), ''::text), cl.cbs_customer_id) AS customer_name,
            COALESCE(NULLIF(cl.product_name, ''::text), 'Loan'::text) AS product_name,
            'loan'::text AS source,
            cbs_loan_dpd(cl.status, cl.start_date, cl.maturity_date, cl.first_installment_date, cl.loan_amount_kobo, cl.outstanding_principal_kobo) AS dpd,
            COALESCE(cl.outstanding_principal_kobo, 0::bigint) + COALESCE(cl.outstanding_interest_kobo, 0::bigint) + COALESCE(cl.outstanding_fee_kobo, 0::bigint) AS outstanding_kobo,
            lnk.entity_id AS party_id
           FROM cbs_loans cl
             LEFT JOIN cbs_links lnk ON lnk.cbs_customer_id = cl.cbs_customer_id AND lnk.entity_type = 'party'::text
             LEFT JOIN parties p ON p.party_id = lnk.entity_id
             LEFT JOIN cbs_customers cc ON cc.cbs_customer_id = cl.cbs_customer_id
          WHERE (cl.status <> ALL (ARRAY['Closed'::text, 'Revoked'::text])) AND cbs_loan_dpd(cl.status, cl.start_date, cl.maturity_date, cl.first_installment_date, cl.loan_amount_kobo, cl.outstanding_principal_kobo) > 0 AND (COALESCE(cl.outstanding_principal_kobo, 0::bigint) + COALESCE(cl.outstanding_interest_kobo, 0::bigint) + COALESCE(cl.outstanding_fee_kobo, 0::bigint)) > 0
        UNION ALL
         SELECT 'uploaded'::text AS arm,
            ca.account_cif AS raw_cif,
            COALESCE(NULLIF(TRIM(BOTH FROM ca.customer_name), ''::text), ca.account_cif) AS customer_name,
            'Loan (uploaded)'::text AS product_name,
            'loan'::text AS source,
                CASE
                    WHEN ca.maturity_date IS NOT NULL THEN GREATEST(0, CURRENT_DATE - ca.maturity_date)
                    ELSE
                    CASE ca.dpd_bucket
                        WHEN '1-30'::text THEN 15
                        WHEN '31-60'::text THEN 45
                        WHEN '61-90'::text THEN 75
                        WHEN '91-180'::text THEN 135
                        WHEN '181-360'::text THEN 270
                        WHEN '360+'::text THEN 400
                        ELSE 0
                    END
                END AS dpd,
            COALESCE(ca.outstanding_kobo, 0::bigint) AS outstanding_kobo,
            ca.party_id
           FROM app.uploaded_loans_live ca
          WHERE ca.status = 'active'::text) u;

-- 257: carry party identity through the delinquency book, and stop the loan arm
-- resolving a CBS customer id against the card CIF namespace.
--
-- THE BUG. The loan arm joined `customers c ON c.cif = cl.cbs_customer_id`, treating
-- the core-banking customer id as if it were a card CIF. Those two namespaces overlap:
-- 39 identifiers exist in both, and in ALL 39 cases they are DIFFERENT customers —
-- limited companies on the loan side against individuals on the card side
-- (00000420 = THIERRY TECHNOLOGY vs Eno Umoh; 00000421 = HYCUBE PLUS LIMITED vs
-- Abimbola Lasaki; 00000422 = EDFLO ENERGY SERVICE LIMITED vs Modupe Thani).
-- ₦751,336,600 across 29 rows sat on those ids. The consequence was not merely a wrong
-- label: everything downstream keys on this view, so a card customer could be placed in
-- the collections book, queued for dialling and pursued for a company's overdue loan.
--
-- THE FIX. Resolve the loan arm's identity the way collections_portfolio.go already
-- does — through app.cbs_links (entity_type='party') to app.parties — and expose
-- party_id on every arm so downstream code can converge on one customer key instead of
-- a per-source string. `cif` is retained unchanged so existing readers keep working;
-- party_id is added at the end, which CREATE OR REPLACE VIEW permits.
--
-- Non-destructive: no row is written, no column dropped. Readers opt in to party_id.

CREATE OR REPLACE VIEW app.collections_delinquent_unified AS
SELECT cif,
       customer_name,
       product_name,
       source,
       dpd,
       outstanding_kobo,
       CASE
           WHEN dpd <= 0   THEN '0'
           WHEN dpd <= 30  THEN '1-30'
           WHEN dpd <= 60  THEN '31-60'
           WHEN dpd <= 90  THEN '61-90'
           WHEN dpd <= 180 THEN '91-180'
           WHEN dpd <= 360 THEN '181-360'
           ELSE '360+'
       END AS dpd_bucket,
       party_id
  FROM (
        -- ── Cards ────────────────────────────────────────────────────────────────
        -- customers.cif IS the card CIF here, so this join was always correct.
        SELECT a.cif,
               COALESCE(NULLIF(TRIM(BOTH FROM (c.first_name || ' ') || COALESCE(c.last_name, '')), ''),
                        NULLIF(a.name_on_card, ''),
                        a.cif)                                                  AS customer_name,
               COALESCE(NULLIF(a.product_name, ''), NULLIF(a.card_product, ''), 'Card') AS product_name,
               'card'::text                                                     AS source,
               CASE WHEN a.payment_due_date IS NOT NULL
                    THEN GREATEST(0, CURRENT_DATE - a.payment_due_date)
                    ELSE LEAST(GREATEST(0, COALESCE(a.days_overdue, 0)), 360)
               END                                                              AS dpd,
               GREATEST(round(COALESCE(a.current_dr_balance, 0::numeric) * 100::numeric), 0::numeric)::bigint
                                                                                AS outstanding_kobo,
               c.party_id                                                       AS party_id
          FROM accounts a
          LEFT JOIN customers c ON c.cif = a.cif
         WHERE COALESCE(a.current_dr_balance, 0::numeric) > 0::numeric
           AND (a.payment_due_date IS NOT NULL AND a.payment_due_date < CURRENT_DATE
                OR a.payment_due_date IS NULL AND COALESCE(a.days_overdue, 0) > 0)

        UNION ALL

        -- ── Core-banking (Udara) loans ───────────────────────────────────────────
        -- Identity resolves cbs_customer_id -> cbs_links -> parties. The old
        -- `customers c ON c.cif = cl.cbs_customer_id` join is gone: it silently
        -- borrowed an unrelated card customer's name whenever the ids collided.
        SELECT cl.cbs_customer_id                                               AS cif,
               COALESCE(NULLIF(TRIM(BOTH FROM p.full_name), ''),
                        NULLIF(TRIM(BOTH FROM cc.name), ''),
                        cl.cbs_customer_id)                                     AS customer_name,
               COALESCE(NULLIF(cl.product_name, ''), 'Loan')                    AS product_name,
               'loan'::text                                                     AS source,
               cbs_loan_dpd(cl.status, cl.start_date, cl.maturity_date, cl.first_installment_date,
                            cl.loan_amount_kobo, cl.outstanding_principal_kobo) AS dpd,
               COALESCE(cl.outstanding_principal_kobo, 0::bigint)
             + COALESCE(cl.outstanding_interest_kobo, 0::bigint)
             + COALESCE(cl.outstanding_fee_kobo, 0::bigint)                     AS outstanding_kobo,
               lnk.entity_id                                                    AS party_id
          FROM cbs_loans cl
          LEFT JOIN app.cbs_links lnk ON lnk.cbs_customer_id = cl.cbs_customer_id
                                     AND lnk.entity_type = 'party'
          LEFT JOIN app.parties p     ON p.party_id = lnk.entity_id
          LEFT JOIN app.cbs_customers cc ON cc.cbs_customer_id = cl.cbs_customer_id
         WHERE (cl.status <> ALL (ARRAY['Closed'::text, 'Revoked'::text]))
           AND cbs_loan_dpd(cl.status, cl.start_date, cl.maturity_date, cl.first_installment_date,
                            cl.loan_amount_kobo, cl.outstanding_principal_kobo) > 0
           AND (COALESCE(cl.outstanding_principal_kobo, 0::bigint)
              + COALESCE(cl.outstanding_interest_kobo, 0::bigint)
              + COALESCE(cl.outstanding_fee_kobo, 0::bigint)) > 0

        UNION ALL

        -- ── Manually uploaded loan book ──────────────────────────────────────────
        -- NOTE: this arm reads collection_assignments, so anything that writes back to
        -- collection_assignments from this view must exclude it or it feeds on itself
        -- (see collectionsGenerateAssignments).
        SELECT ca.account_cif                                                   AS cif,
               COALESCE(NULLIF(TRIM(BOTH FROM ca.customer_name), ''), ca.account_cif) AS customer_name,
               'Loan (uploaded)'::text                                          AS product_name,
               'loan'::text                                                     AS source,
               CASE WHEN ca.maturity_date IS NOT NULL
                    THEN GREATEST(0, CURRENT_DATE - ca.maturity_date)
                    ELSE CASE ca.dpd_bucket
                           WHEN '1-30'    THEN 15
                           WHEN '31-60'   THEN 45
                           WHEN '61-90'   THEN 75
                           WHEN '91-180'  THEN 135
                           WHEN '181-360' THEN 270
                           WHEN '360+'    THEN 400
                           ELSE 0
                         END
               END                                                              AS dpd,
               COALESCE(ca.outstanding_kobo, 0::bigint)                         AS outstanding_kobo,
               ca.party_id                                                      AS party_id
          FROM collection_assignments ca
         WHERE ca.product_type = 'loan'
           AND ca.data_source  = 'manual'
           AND ca.status       = 'active'
       ) u;

COMMENT ON VIEW app.collections_delinquent_unified IS
  'Every delinquent facility across cards, core-banking loans and the uploaded loan book. cif is the source-system key and is NOT unique across sources; party_id is the customer key and should be preferred for identity, contact and de-duplication. Loan identity resolves via cbs_links -> parties (migration 257).';

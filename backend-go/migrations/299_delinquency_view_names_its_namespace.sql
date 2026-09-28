-- 299 — The delinquency book stops calling a Udara id a CIF.
--
-- THE DEFECT, AND WHY IT KEPT COMING BACK. app.collections_delinquent_unified UNIONs a
-- cards branch keyed by app.customers.cif with a Udara branch keyed by
-- cbs_loans.cbs_customer_id, and published BOTH under one column named `cif`. The two key
-- spaces collide: 271 of 295 Udara ids also exist as a cards CIF, and every one of them is
-- a different real person (Udara 00000432 is GLISTER HOME APPLIANCES; card CIF 00000432 is
-- Onafowokan Olayiwola). Measured on this view today: 31 of its 35 Udara-loan rows carry a
-- `cif` that is a live cards CIF belonging to somebody else.
--
-- The identity plumbing INSIDE the view was already correct — the loan arm resolves
-- party_id through app.cbs_links and takes its name from cbs_customers/parties. The lie was
-- purely the COLUMN NAME, and a name is what callers trust. Three readers believed it and
-- joined `app.customers c ON c.cif = d.cif`, which silently reaches a stranger:
--
--   * handlers/batch.go — the nightly dialler feed. Takes COALESCE(v.phone, c.phone), so
--     when the borrower's own party has no phone it queues the STRANGER'S NUMBER under the
--     BORROWER'S NAME. 20 such rows were pending: an agent would have called Olabode Sanusi
--     about FOLTI TECHNOLOGIES' N154,300,000. That is third-party debt disclosure.
--   * handlers/call_center_outbound.go — the same query behind the manual "Sync now".
--   * handlers/collections_dunning.go — same join, but the field taken is EMAIL, so the
--     demand letter goes to the wrong mailbox. 9 rows were pending.
--
-- Nothing had gone out yet: call_center_contacts held 0 rows whose phone belongs to another
-- party, and dunning_sends held 0 Udara ids. The dedupe on 'pending' was masking it, and it
-- would have fired as soon as those card rows were worked and closed.
--
-- A fourth reader merged the two namespaces arithmetically: collectionsPortfolioKPIs did
-- `GROUP BY cif` over the raw view, which is the exact statement collections.go:86-100
-- forbids. Id 00000656 is live on BOTH branches (card: Obinna Ubani, 1,943 DPD; loan:
-- BENLAD MULTILINKS LTD, 22 DPD), so MAX(dpd) put BENLAD's N29,166,666.67 into PAR30, PAR60
-- AND PAR90. Every PAR figure on the collections dashboard was overstated by exactly that,
-- and total_accounts was one short. PAR is a CBN-definition number.
--
-- THE FIX. Delete the column called `cif` and make every reader say which namespace it
-- means. The view now publishes three honest columns:
--
--     arm      'cards' | 'udara' | 'uploaded'  — which book the row came from
--     raw_cif  the id in ITS OWN namespace: a cards CIF, or a bare cbs_customer_id
--     key_cif  the id as it is safe to STORE and to JOIN between tables:
--              'UD-'||cbs_customer_id for the Udara arm, unchanged otherwise
--
-- `key_cif` is the same convention migration 267 gave collection_assignments and
-- recovery_cases, so `v.key_cif = ca.account_cif` now matches correctly for Udara rows —
-- which also repairs two latent defects in recovery_ops.go where a 'UD-' key could never
-- match the bare `cif` (the queue-exit sweep never fired, and the "cured" sweep would have
-- closed every Udara recovery case the moment it ran).
--
-- Dropping the column rather than redefining it is deliberate. A CREATE OR REPLACE that
-- merely changed the VALUE would fix the joins silently and leave the next author free to
-- write `c.cif = d.cif` again. Removing the name makes that statement fail at query time
-- instead of returning a stranger — the difference between a bug someone reports and a bug
-- nobody sees. Verified before writing: nothing in the database depends on this view, so
-- the DROP cascades to nothing.
--
-- The three arms' own logic (DPD, outstanding, name resolution, filters) is carried across
-- UNCHANGED. The only differences are the identity columns.

BEGIN;

DROP VIEW IF EXISTS app.collections_delinquent_unified;

CREATE VIEW app.collections_delinquent_unified AS
SELECT
    u.arm,
    u.raw_cif,
    -- The storable/joinable key. Prefixing is what makes a Udara id structurally unable to
    -- be mistaken for a cards CIF: every cards CIF is exactly 8 digits, so 'UD-' can never
    -- collide with one.
    CASE WHEN u.arm = 'udara' THEN 'UD-' || u.raw_cif ELSE u.raw_cif END AS key_cif,
    u.customer_name,
    u.product_name,
    u.source,
    u.dpd,
    u.outstanding_kobo,
    CASE
        WHEN u.dpd <= 0   THEN '0'
        WHEN u.dpd <= 30  THEN '1-30'
        WHEN u.dpd <= 60  THEN '31-60'
        WHEN u.dpd <= 90  THEN '61-90'
        WHEN u.dpd <= 180 THEN '91-180'
        WHEN u.dpd <= 360 THEN '181-360'
        ELSE '360+'
    END AS dpd_bucket,
    u.party_id
FROM (
    -- ── cards ──────────────────────────────────────────────────────────────
    SELECT 'cards'::text AS arm,
           a.cif AS raw_cif,
           COALESCE(NULLIF(TRIM(BOTH FROM (c.first_name || ' '::text) || COALESCE(c.last_name, ''::text)), ''::text),
                    NULLIF(a.name_on_card, ''::text), a.cif) AS customer_name,
           COALESCE(NULLIF(a.product_name, ''::text), NULLIF(a.card_product, ''::text), 'Card'::text) AS product_name,
           'card'::text AS source,
           CASE WHEN a.payment_due_date IS NOT NULL THEN GREATEST(0, CURRENT_DATE - a.payment_due_date)
                ELSE LEAST(GREATEST(0, COALESCE(a.days_overdue, 0)), 360) END AS dpd,
           GREATEST(round(COALESCE(a.current_dr_balance, 0::numeric) * 100::numeric), 0::numeric)::bigint AS outstanding_kobo,
           c.party_id
      FROM app.accounts a
      LEFT JOIN app.customers c ON c.cif = a.cif
     WHERE COALESCE(a.current_dr_balance, 0::numeric) > 0::numeric
       AND (a.payment_due_date IS NOT NULL AND a.payment_due_date < CURRENT_DATE
            OR a.payment_due_date IS NULL AND COALESCE(a.days_overdue, 0) > 0)

    UNION ALL

    -- ── Udara core banking ─────────────────────────────────────────────────
    -- party_id comes from the curated crosswalk, never from matching the Udara id against
    -- a cards CIF. NULL here means the bridge is missing and every write path must refuse
    -- the row rather than guess.
    SELECT 'udara'::text AS arm,
           cl.cbs_customer_id AS raw_cif,
           COALESCE(NULLIF(TRIM(BOTH FROM p.full_name), ''::text),
                    NULLIF(TRIM(BOTH FROM cc.name), ''::text), cl.cbs_customer_id) AS customer_name,
           COALESCE(NULLIF(cl.product_name, ''::text), 'Loan'::text) AS product_name,
           'loan'::text AS source,
           app.cbs_loan_dpd(cl.status, cl.start_date, cl.maturity_date, cl.first_installment_date,
                            cl.loan_amount_kobo, cl.outstanding_principal_kobo) AS dpd,
           COALESCE(cl.outstanding_principal_kobo, 0::bigint)
             + COALESCE(cl.outstanding_interest_kobo, 0::bigint)
             + COALESCE(cl.outstanding_fee_kobo, 0::bigint) AS outstanding_kobo,
           lnk.entity_id AS party_id
      FROM app.cbs_loans cl
      LEFT JOIN app.cbs_links lnk ON lnk.cbs_customer_id = cl.cbs_customer_id AND lnk.entity_type = 'party'::text
      LEFT JOIN app.parties p ON p.party_id = lnk.entity_id
      LEFT JOIN app.cbs_customers cc ON cc.cbs_customer_id = cl.cbs_customer_id
     WHERE (cl.status <> ALL (ARRAY['Closed'::text, 'Revoked'::text]))
       AND app.cbs_loan_dpd(cl.status, cl.start_date, cl.maturity_date, cl.first_installment_date,
                            cl.loan_amount_kobo, cl.outstanding_principal_kobo) > 0
       AND (COALESCE(cl.outstanding_principal_kobo, 0::bigint)
            + COALESCE(cl.outstanding_interest_kobo, 0::bigint)
            + COALESCE(cl.outstanding_fee_kobo, 0::bigint)) > 0

    UNION ALL

    -- ── uploaded sheet ─────────────────────────────────────────────────────
    -- This arm IS app.collection_assignments, so raw_cif is already the stored key and
    -- key_cif must leave it alone. Six of these rows still hold a BARE Udara id in
    -- account_cif (they escaped migration 267 because data_source='manual'); the view
    -- reports what is stored rather than pretending otherwise.
    SELECT 'uploaded'::text AS arm,
           ca.account_cif AS raw_cif,
           COALESCE(NULLIF(TRIM(BOTH FROM ca.customer_name), ''::text), ca.account_cif) AS customer_name,
           'Loan (uploaded)'::text AS product_name,
           'loan'::text AS source,
           CASE WHEN ca.maturity_date IS NOT NULL THEN GREATEST(0, CURRENT_DATE - ca.maturity_date)
                ELSE CASE ca.dpd_bucket
                        WHEN '1-30'::text    THEN 15
                        WHEN '31-60'::text   THEN 45
                        WHEN '61-90'::text   THEN 75
                        WHEN '91-180'::text  THEN 135
                        WHEN '181-360'::text THEN 270
                        WHEN '360+'::text    THEN 400
                        ELSE 0
                     END
           END AS dpd,
           COALESCE(ca.outstanding_kobo, 0::bigint) AS outstanding_kobo,
           ca.party_id
      FROM app.collection_assignments ca
     WHERE ca.product_type = 'loan'::text AND ca.data_source = 'manual'::text AND ca.status = 'active'::text
) u;

COMMENT ON VIEW app.collections_delinquent_unified IS
  'The delinquency book, three arms unioned. IDENTITY RULE: there is deliberately no column '
  'called "cif", because a Udara customer id is NOT a CIF and publishing both under that name '
  'sent collections calls and dunning emails to the wrong people (migration 299). Use raw_cif '
  'ONLY inside its own arm (join it to app.customers only where arm=''cards''), and key_cif to '
  'store or to join against collection_assignments.account_cif / recovery_cases.account_cif, '
  'which carry the same UD- convention from migration 267.';

DO $m299$
DECLARE n_udara int; n_bad int; n_collide int;
BEGIN
    SELECT COUNT(*) INTO n_udara FROM app.collections_delinquent_unified WHERE arm = 'udara';

    -- Every Udara row must now carry a prefixed key, and no key may be ambiguous.
    SELECT COUNT(*) INTO n_bad FROM app.collections_delinquent_unified
     WHERE arm = 'udara' AND key_cif NOT LIKE 'UD-%';
    IF n_bad > 0 THEN
        RAISE EXCEPTION '299: % Udara row(s) still publish an unprefixed key — refusing', n_bad;
    END IF;

    -- The point of the change: a cards join on the Udara arm must now find nothing.
    SELECT COUNT(*) INTO n_collide
      FROM app.collections_delinquent_unified v
      JOIN app.customers c ON c.cif = v.key_cif
     WHERE v.arm = 'udara';
    IF n_collide > 0 THEN
        RAISE EXCEPTION '299: % Udara row(s) can still reach a cards customer by key — refusing', n_collide;
    END IF;

    RAISE NOTICE '299: delinquency view re-published with arm/raw_cif/key_cif; % Udara row(s) now unreachable from the cards namespace', n_udara;
END $m299$;

COMMIT;

-- Rollback for 306_card_stock_is_not_a_customer
--
-- Restores app.customer_acquisition to its pre-306 definition, which puts the 1,127
-- unissued Blink card-stock placeholders back into the customer book — so My Book,
-- Contacts and Cohort will show "BLINK 506" as a customer again, and customer counts go
-- back up by 1,127.
--
-- The function is dropped last, after nothing references it. It is left behind only if
-- something else has started using it, in which case DROP FUNCTION will fail loudly
-- rather than break that caller — run the DROP separately if you actually want it gone.

CREATE OR REPLACE VIEW app.customer_acquisition AS
 SELECT c.contact_id,
    c.cif,
    c.full_name,
    c.first_name,
    c.last_name,
    c.email,
    c.phone,
    c.state,
    c.city,
    c.account_status,
    c.source,
    c.first_seen_at,
    c.last_seen,
    c.account_created,
    a.first_account_opened,
    a.account_count,
    COALESCE(c.account_created::timestamp with time zone, a.first_account_opened::timestamp with time zone, c.first_seen_at) AS acquired_on,
        CASE
            WHEN c.account_created IS NOT NULL THEN 'account_created'::text
            WHEN a.first_account_opened IS NOT NULL THEN 'first_account'::text
            WHEN c.first_seen_at IS NOT NULL THEN 'first_seen'::text
            ELSE 'unknown'::text
        END AS acquired_on_source,
    o.officer_id,
    o.assigned_at AS officer_assigned_at,
    c.party_id,
    COALESCE('p'::text || c.party_id, 'c'::text || c.contact_id) AS person_key
   FROM customers c
     LEFT JOIN ( SELECT accounts.cif,
            min(accounts.opened_date) AS first_account_opened,
            count(*) AS account_count
           FROM accounts
          WHERE accounts.opened_date IS NOT NULL AND accounts.cif IS NOT NULL AND accounts.cif <> ''::text AND accounts.opened_date <= CURRENT_DATE
          GROUP BY accounts.cif) a ON a.cif = c.cif
     LEFT JOIN customer_officers o ON o.cif = c.cif
  WHERE c.cif IS NOT NULL AND c.cif <> ''::text;

DROP FUNCTION IF EXISTS app.is_card_stock_name(text);

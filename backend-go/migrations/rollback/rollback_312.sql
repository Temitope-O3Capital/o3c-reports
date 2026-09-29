-- Rollback 312: put 'fastest' back in the test pattern and stop excluding test cards
-- from the customer view.
--
-- Restoring 'fastest' re-hides six real customers (CIFs 00003294-00003300) from the
-- customer view, from customer360 and from both ingest feeds. Only run this if the
-- evidence in 312 turns out to be wrong about them.
--
-- The Go copies of the regex must be reverted in step, or the function and the feeds
-- disagree: acctfeed/acctfeed.go, custfeed/ingest.go, handlers/customer360.go and
-- txnfeed/txnfeed.go.

CREATE OR REPLACE FUNCTION app.is_test_card_name(nm text)
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(nm, '') ~* '\m(test|bevertec|dummy|fastest)\M|testcard|questtest'
$$;

-- Back to 306's definition: card stock excluded, test cards present.
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
   WHERE c.cif IS NOT NULL AND c.cif <> ''::text
     AND NOT app.is_card_stock_name(c.full_name);

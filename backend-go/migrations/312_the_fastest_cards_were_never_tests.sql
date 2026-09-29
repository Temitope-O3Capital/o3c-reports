-- 312: drop 'fastest' from the test-card pattern, then take the real test cards out of
-- the customer view.
--
-- Two changes that have to happen in this order, because doing the second alone would
-- have quietly deleted six real customers from every acquisition number in the platform.
--
-- ---------------------------------------------------------------------------
-- PART 1 — 'fastest' matches six REAL cards, not test personas.
-- ---------------------------------------------------------------------------
--
-- Migration 293 built app.is_test_card_name around the tokens test | bevertec | dummy |
-- fastest, and called the fastest rows "the 'Fastest' personas". They are not personas.
-- They are prize cards from a road race, and the evidence is not ambiguous:
--
--   FASTEST FEMALE / FEMALE JNR / FEMALE SNR / MALE / MALE JNR / MALE SNR
--   -- six cards, CIFs 00003294-00003300, opened 9 and 12 March 2018, Lagos
--   -- each loaded with exactly NGN 3,000 on 2018-03-23 ("Cash Payment Bank")
--   -- and on 2018-03-29 the Jnr cardholder drew NGN 1,000 then NGN 2,000
--      at ATM2_ALONG CHEVRON DR, with a NGN 3,000 repayment on 2018-04-14.
--
-- A test card is not walked to an ATM on Chevron Drive three weeks later. Male/Female x
-- Jnr/Snr is a race's award categories, each prize card preloaded with NGN 3,000, and at
-- least one winner spent theirs. These are customers.
--
-- The cost of the mistake is larger than six rows: per migration 293 this same pattern is
-- what BOTH feeds reject on at ingest, so the account feed and the transaction feed have
-- been discarding these cards' rows, and customer360 hides them. They have been excluded
-- from the books as test data since 293.
--
-- Checked before removing the token: 'fastest' matches exactly 6 customers and 7 account
-- rows (6 distinct embossed names) in the whole database, and NOT ONE of them is caught by
-- any other token in the pattern. So dropping it releases precisely these six real cards
-- and lets through no test card at all.
--
-- The four Go copies of this regex are changed in the same commit — acctfeed/acctfeed.go,
-- custfeed/ingest.go, handlers/customer360.go and txnfeed/txnfeed.go. 293's comment says
-- there are three; there are five including this function. Keep all five in step.

CREATE OR REPLACE FUNCTION app.is_test_card_name(nm text)
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(nm, '') ~* '\m(test|bevertec|dummy)\M|testcard|questtest'
$$;

COMMENT ON FUNCTION app.is_test_card_name(text) IS
  'True when a cardholder or customer name marks a test/vendor card. This regex is '
  'the SAME one both feeds reject on at ingest (acctfeed.testNameRE and the txnfeed '
  'insert filter) and that customer360 hides on. Keep all five in step. The \m and \M '
  'word boundaries are load-bearing: Testimony, Protest, Latest, Ernest, Testman, '
  'Ademola and Bademosi are real Nigerian names that embed a token and must not match. '
  'The token ''fastest'' was removed in migration 312: it matched six real 2018 race '
  'prize cards (FASTEST MALE/FEMALE, JNR/SNR) that carry balances and ATM withdrawals, '
  'and no genuine test card.';

-- ---------------------------------------------------------------------------
-- PART 2 — test cards leave the customer view.
-- ---------------------------------------------------------------------------
--
-- Same treatment migration 306 gave card stock, and for the same reason: a test card is
-- not a customer, and every acquisition count, cohort and officer book that reads this
-- view has been carrying them. 52 rows once 'fastest' is out of the pattern (58 before).
--
-- This is an EXCLUSION FROM A VIEW, not a deletion. The rows stay in app.customers, and
-- app.test_card_accounts still lists every test card with its CIF and embossed name, so
-- Finance can still reconcile against the vendor's own records. That view is the escape
-- hatch; nothing else needs one.
--
-- Definition below is 306's, with a second NOT added. Column list is unchanged, so
-- CREATE OR REPLACE is sufficient and no dependent object has to be rebuilt (checked:
-- nothing depends on this view).

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
     AND NOT app.is_card_stock_name(c.full_name)
     AND NOT app.is_test_card_name(c.full_name);

-- ---------------------------------------------------------------------------
-- Guards.
-- ---------------------------------------------------------------------------

DO $m312$
DECLARE
    v_fastest_in_view bigint;
    v_tests_left      bigint;
    v_tests_in_cust   bigint;
    v_total           bigint;
BEGIN
    -- The six race cards must now be VISIBLE. This is the point of part 1, and the
    -- check that stops part 2 from silently re-hiding them.
    SELECT count(*) INTO v_fastest_in_view
      FROM app.customer_acquisition WHERE full_name ~* '\mfastest\M';
    IF v_fastest_in_view <> 6 THEN
        RAISE EXCEPTION '312: expected the 6 Fastest prize cards to be visible in the '
                        'customer view, found %.', v_fastest_in_view;
    END IF;

    -- And the function must no longer call them tests.
    IF app.is_test_card_name('FASTEST MALE JNR') THEN
        RAISE EXCEPTION '312: is_test_card_name still matches the Fastest prize cards.';
    END IF;

    -- Real test cards must be gone from the view.
    SELECT count(*) INTO v_tests_left
      FROM app.customer_acquisition WHERE app.is_test_card_name(full_name);
    IF v_tests_left > 0 THEN
        RAISE EXCEPTION '312: % test-card rows are still in the customer view.', v_tests_left;
    END IF;

    -- Exclusion, not deletion: they must still be in app.customers.
    SELECT count(*) INTO v_tests_in_cust
      FROM app.customers WHERE app.is_test_card_name(full_name);
    IF v_tests_in_cust = 0 THEN
        RAISE EXCEPTION '312: test cards have been removed from app.customers. They should '
                        'only have been excluded from the customer view.';
    END IF;

    -- The pattern must not be eating real people.
    SELECT count(*) INTO v_total FROM app.customer_acquisition;
    IF v_total < 20000 THEN
        RAISE EXCEPTION '312: only % customers left in the view — the test pattern is '
                        'matching real people.', v_total;
    END IF;

    -- Still reachable for reconciliation.
    IF (SELECT count(*) FROM app.test_card_accounts) = 0 THEN
        RAISE EXCEPTION '312: app.test_card_accounts is empty — Finance has lost its '
                        'reconciliation view of the test cards.';
    END IF;

    RAISE NOTICE '312: % test-card rows excluded from the customer view (% remain in '
                 'app.customers); 6 Fastest prize cards released back as real customers; '
                 '% customers in the view.', v_tests_in_cust, v_tests_in_cust, v_total;
END
$m312$;

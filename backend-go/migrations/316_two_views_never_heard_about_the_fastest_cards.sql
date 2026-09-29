-- 316: app."Accounts" and app."Products" call app.is_test_card_name instead of inlining it.
--
-- Migration 312 removed 'fastest' from the test-card pattern because it matched six real
-- 2018 race-prize cards, and its header says "Keep all five in step". There were SEVEN.
--
-- These two views were created with the pattern inlined (migrations 213 and 214, the
-- second of which is literally named ..._test_filter_fastest) and 312 never touched them.
-- So since 312 the function has said FASTEST MALE is a customer while these two views
-- still said it was test data:
--
--   app."Accounts"  ... !~* '\m(test|bevertec|dummy|fastest)\M|testcard|questtest'
--   app."Products"  ... !~* '\m(test|bevertec|dummy|fastest)\M|testcard|questtest'
--
-- Measured 2026-09-29, before this migration: 6 customer rows and 7 account rows are
-- hidden from these two views by the 'fastest' token alone, and NOT ONE of them is caught
-- by any other token — the same six prize cards (CIFs 00003294-00003301) and their seven
-- accounts, six of which still carry a NGN 3,000 credit balance. These are the very rows
-- 312 was written to release.
--
-- Nothing in Go reads rows from either view (checked: handlers/contacts.go and
-- customer360.go name "Accounts" only in comments and query app.customers directly;
-- cbssync/reconcile.go only calls to_regclass on it to test for its presence). They are
-- the hand-query and reporting surface, which is exactly why a wrong answer in them is
-- hard to notice.
--
-- The fix is not to retype the pattern correctly a seventh time. Both views now CALL
-- app.is_test_card_name, so the function is the only place in the database the pattern
-- exists, and the next change to it reaches them. The Go side was collapsed to one copy in
-- the same commit (backend-go/core/testcards.go, which renders both the Go regexp and the
-- SQL predicate from one token list, replacing the four copies in acctfeed, custfeed,
-- txnfeed and handlers/customer360.go).
--
-- Column lists are unchanged, so CREATE OR REPLACE suffices; checked that no database
-- object depends on either view.

CREATE OR REPLACE VIEW app."Accounts" AS
  SELECT cif             AS "CIF Number",
         account_created AS "Account Created Date",
         first_name      AS "First Name",
         last_name       AS "Last Name",
         full_address    AS "Full Address",
         birthday        AS "Birthday",
         email           AS "Email",
         phone           AS "Phone Number",
         job_title       AS "Job Title",
         state           AS "State",
         city            AS "City"
    FROM app.customers
   WHERE cif IS NOT NULL
     AND NOT app.is_test_card_name(
           COALESCE(full_name,'') || ' ' || COALESCE(first_name,'') || ' ' || COALESCE(last_name,''));

CREATE OR REPLACE VIEW app."Products" AS
  SELECT cif                                  AS "CIF Number",
         name_on_card                         AS "Name On Card",
         NULL::text                           AS "Account Manager",
         product_name                         AS "Product Name",
         status                               AS "Account Status",
         COALESCE(card_product, card_program) AS "Card Product",
         opened_date                          AS "Account Created Date"
    FROM app.accounts
   WHERE cif IS NOT NULL
     AND NOT app.is_test_card_name(name_on_card);

-- ---------------------------------------------------------------------------
-- Guards.
-- ---------------------------------------------------------------------------

DO $m316$
DECLARE
    v_fastest_cust bigint;
    v_fastest_acct bigint;
    v_tests_cust   bigint;
    v_tests_acct   bigint;
    v_total_cust   bigint;
    v_total_acct   bigint;
    v_inlined      text;
BEGIN
    -- The six prize cards and their seven accounts must now be VISIBLE. This is the whole
    -- point, and 312's equivalent guard is what proved the same thing for
    -- app.customer_acquisition.
    SELECT count(*) INTO v_fastest_cust
      FROM app."Accounts"
     WHERE (COALESCE("First Name",'') || ' ' || COALESCE("Last Name",'')) ~* '\mfastest\M';
    IF v_fastest_cust <> 6 THEN
        RAISE EXCEPTION '316: expected the 6 Fastest prize cards visible in app."Accounts", found %.',
                        v_fastest_cust;
    END IF;

    SELECT count(*) INTO v_fastest_acct
      FROM app."Products" WHERE "Name On Card" ~* '\mfastest\M';
    IF v_fastest_acct <> 7 THEN
        RAISE EXCEPTION '316: expected the 7 Fastest prize accounts visible in app."Products", found %.',
                        v_fastest_acct;
    END IF;

    -- Real test cards must still be excluded. Releasing six customers is not a licence to
    -- let the vendor's test cards back into the reporting surface.
    SELECT count(*) INTO v_tests_cust
      FROM app."Accounts"
     WHERE app.is_test_card_name(COALESCE("First Name",'') || ' ' || COALESCE("Last Name",''));
    IF v_tests_cust > 0 THEN
        RAISE EXCEPTION '316: % test-card rows are visible in app."Accounts".', v_tests_cust;
    END IF;

    SELECT count(*) INTO v_tests_acct
      FROM app."Products" WHERE app.is_test_card_name("Name On Card");
    IF v_tests_acct > 0 THEN
        RAISE EXCEPTION '316: % test-card rows are visible in app."Products".', v_tests_acct;
    END IF;

    -- And the views must still hold the book. A predicate that matches real people would
    -- show up here long before anyone noticed a missing customer.
    SELECT count(*) INTO v_total_cust FROM app."Accounts";
    SELECT count(*) INTO v_total_acct FROM app."Products";
    IF v_total_cust < 20000 OR v_total_acct < 20000 THEN
        RAISE EXCEPTION '316: only % customer and % product rows left — the test pattern is '
                        'matching real people.', v_total_cust, v_total_acct;
    END IF;

    -- The guard that stops this recurring for an eighth time. After this migration the
    -- pattern exists in exactly ONE database object: app.is_test_card_name. If a later
    -- migration inlines it into a view or function again, this fails the deploy the way
    -- migration 308's disposition-label guard does, and it names the culprit.
    SELECT string_agg(obj, ', ' ORDER BY obj) INTO v_inlined FROM (
        SELECT n.nspname || '.' || c.relname AS obj
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('v','m')
           AND lower(pg_get_viewdef(c.oid)) LIKE '%bevertec%'
        UNION ALL
        SELECT n.nspname || '.' || p.proname
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE p.prokind = 'f'
           AND lower(p.prosrc) LIKE '%bevertec%'
           AND NOT (n.nspname = 'app' AND p.proname = 'is_test_card_name')
    ) s;
    IF v_inlined IS NOT NULL THEN
        RAISE EXCEPTION '316: the test-card pattern is inlined in % — call '
                        'app.is_test_card_name(col) instead. Seven copies of this regex '
                        'have already disagreed once (migration 312 fixed five of them).',
                        v_inlined;
    END IF;

    RAISE NOTICE '316: app."Accounts" and app."Products" now call app.is_test_card_name. '
                 '6 Fastest prize customers and their 7 accounts released (% customers, '
                 '% products visible). The pattern now exists in exactly one database object.',
                 v_total_cust, v_total_acct;
END
$m316$;

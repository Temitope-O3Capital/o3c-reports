-- 306 — "BLINK 506" is not a customer, and should not be on anybody's book.
--
-- RENUMBERED FROM 305, which was already taken by 305_the_last_six_bare_udara_ids.sql.
-- Both were written on 28 Sept 2026 and both were applied, so app.schema_migrations
-- carries this one under its OLD name and will apply it again under the new one. That is
-- safe and expected here: every statement below is CREATE OR REPLACE plus read-only
-- guards, with no DML at all, so a second application re-asserts the same definitions and
-- re-checks the same invariants. The schema_migrations row was deliberately left alone
-- rather than rewritten, so the history records what actually ran.
--
-- WHY. My Book lists rows named BLINK 10, BLINK 1000, BLINK 1001 … instead of people.
-- Measured 28 Sept 2026 there are 1,127 of them in app.customer_acquisition, out of
-- 21,854 rows — 5% of what the workspace calls its customer book.
--
-- They are unissued Blink card stock: inventory records pre-loaded into the customer
-- file, named after the card rather than a person. The evidence is unanimous:
--
--     rows matching ^blink\s*[0-9]+$      1,127
--     with a BVN                              0
--     with a date of birth                    0
--     with a credit limit                     0
--     with a balance                          0
--     with an account status                  0   (blank on every row)
--     distinct phone numbers                  2   — 8000000000 (1,083) and 0000000000 (11)
--     on an officer's book                    0
--
-- No person, no money, no status, and two obvious dummy phone numbers between them.
--
-- A WRONG TURN WORTH RECORDING, because the next person to look at this will find the
-- same thing and it is convincing. Matching those phones against the rest of the
-- customer file appears to show that all 1,094 stock rows with a "valid" 10-digit phone
-- correspond to a real, named customer — which reads as "these are real people whose
-- names were never captured, and the name is recoverable". It is an artefact. The match
-- is on 8000000000, a placeholder that dozens of unrelated rows also carry, and the join
-- produces 1.2 million pairs from 1,127 rows. There is no person behind these records.
--
-- SCOPE. This excludes card stock from the CUSTOMER view only. It does not delete the
-- rows and does not touch any card, income or balance-sheet figure — it cannot, since
-- every one of these carries zero limit and zero balance. app.customers keeps them, so
-- the cards team can still see what stock exists.
--
-- is_test_card_name does NOT catch these ("BLINK 1000" → false), which is correct: they
-- are not test cards, they are unissued stock, and the two are worth telling apart.
--
-- STILL PRESENT AND DELIBERATELY NOT TOUCHED: 58 rows in the same view that ARE test
-- cards by app.is_test_card_name. They are equally not customers, but callers already
-- exclude them explicitly and some may be counted on purpose for reconciliation, so
-- removing them from under those callers is a separate decision, not a side effect
-- of this one.
--
-- REVERSIBLE: rollback/rollback_306.sql restores the previous view definition verbatim.

CREATE OR REPLACE FUNCTION app.is_card_stock_name(nm text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$
    -- Anchored at both ends and requiring digits and nothing else after the word, so a
    -- real person cannot be caught by it. "Blink 1000" matches; a customer actually
    -- called Blink, or "Blinkers Ltd", does not. Case-insensitive and tolerant of the
    -- missing space seen in the data.
    SELECT COALESCE(btrim(nm) ~* '^blink[[:space:]]*[0-9]+$', FALSE);
$$;

COMMENT ON FUNCTION app.is_card_stock_name(text) IS
  'True when a customer name is an unissued Blink card stock placeholder ("BLINK 1000") '
  'rather than a person. Distinct from is_test_card_name: stock is real inventory that '
  'was never sold, a test card is a vendor artefact. Neither is a customer.';

-- ---------------------------------------------------------------------------
-- The view, unchanged except for the exclusion on the last line.
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- Guards.
-- ---------------------------------------------------------------------------

DO $m306$
DECLARE
    v_stock_left bigint;
    v_total      bigint;
    v_named      bigint;
BEGIN
    SELECT count(*) INTO v_stock_left
      FROM app.customer_acquisition WHERE app.is_card_stock_name(full_name);
    IF v_stock_left > 0 THEN
        RAISE EXCEPTION '306: % card-stock rows are still in the customer view.', v_stock_left;
    END IF;

    -- The stock rows must still exist in app.customers: this is an exclusion from a
    -- view, not a deletion, and the cards team needs to see its own inventory.
    SELECT count(*) INTO v_stock_left
      FROM app.customers WHERE app.is_card_stock_name(full_name);
    IF v_stock_left = 0 THEN
        RAISE EXCEPTION '306: card stock has been removed from app.customers. It should '
                        'only have been excluded from the customer view.';
    END IF;

    -- The function must not be eating real customers. 20,000+ rows have to survive.
    SELECT count(*) INTO v_total FROM app.customer_acquisition;
    IF v_total < 20000 THEN
        RAISE EXCEPTION '306: only % customers left in the view — the stock pattern is '
                        'matching real people.', v_total;
    END IF;

    SELECT count(*) INTO v_named
      FROM app.customers WHERE full_name ~* '^blink' AND NOT app.is_card_stock_name(full_name);
    RAISE NOTICE '306: % card-stock placeholders excluded from the customer view; % rows '
                 'remain. % genuinely Blink-named non-stock rows were left alone.',
                 v_stock_left, v_total, v_named;
END
$m306$;

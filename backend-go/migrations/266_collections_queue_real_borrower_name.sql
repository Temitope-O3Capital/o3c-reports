-- 266 — The collections queue names the wrong person on Udara loans.
--
-- app.collections_delinquent_unified resolves the borrower's name on its CBS-loan branch
-- with:
--
--     LEFT JOIN customers c ON c.cif = cl.cbs_customer_id
--
-- That is a cross-namespace join. The workspace carries three separate identifier spaces
-- that all look like a zero-padded 8-digit number and are NOT interchangeable:
--
--     app.parties.party_id          the workspace Customer ID — the unifying key
--     app.customers.cif             a CARDS identifier (CCS/Sage). NOT a customer id.
--     cbs_loans.cbs_customer_id     Udara360 core banking only
--
-- So every Udara borrower in the collections queue is labelled with whichever CARD
-- customer happens to hold the same number. Measured before this migration:
-- 46 of the 49 Udara loans in the queue, carrying N879,070,398 of exposure, displayed a
-- different real person's name. Examples:
--
--     00000553  shown "Olabode Sanusi"     is FOLTI TECHNOLOGIES   N154,300,000  dpd 7
--     00000597  shown "Henry Obukoadata"   is NASSCOOP SOCIETY     N111,111,111  dpd 31
--     00000629  shown "Olatunji Tijani"    is AMBIENCE HOTEL       N100,000,000  dpd 47
--     00000424  shown "Adetunji Taiwo"     is FINTRAK               N40,000,000  dpd 42
--     00000533  shown "Saka Lamidi"        is ADELOYE BAYONLE       N25,000,000  dpd 49
--
-- This is the working list collections officers call from, so a wrong name here is not a
-- cosmetic defect: it points recovery activity at an uninvolved customer and discloses one
-- customer's debt under another's name.
--
-- FIX. Take the name from the Udara customer master (the system of record for that loan),
-- then the loan payload, then the workspace party reached through the ONLY correct bridge
-- (app.cbs_links, entity_type='party' — verified to resolve 294/294 Udara customers and
-- 52/52 loans to the right party), and only then fall back to the bare id.
--
-- Row-count safety: cbs_customers is joined on its PRIMARY KEY, and the party lookup is a
-- correlated scalar subquery with LIMIT 1 — neither can add or drop a row. Verified below.
-- The card branch keeps its `c.cif = a.cif` join: accounts.cif IS a cards CIF, so that one
-- is correct and is deliberately left alone.
--
-- CREATE OR REPLACE VIEW keeps column names, order and types identical, so no consumer
-- changes. Applied defensively: skipped if the view is absent or has already been fixed,
-- so a concurrent session's edit is never clobbered.

DO $$
DECLARE
    def      text;
    old_expr text;
    new_expr text;
    old_join text;
    new_join text;
BEGIN
    SELECT pg_get_viewdef('app.collections_delinquent_unified'::regclass, true) INTO def;
    IF def IS NULL THEN
        RAISE WARNING '266: collections_delinquent_unified absent — nothing to fix';
        RETURN;
    END IF;

    old_expr := 'COALESCE(NULLIF(TRIM(BOTH FROM (c.first_name || '' ''::text) || COALESCE(c.last_name, ''''::text)), ''''::text), cl.cbs_customer_id) AS customer_name';
    old_join := 'FROM cbs_loans cl
             LEFT JOIN customers c ON c.cif = cl.cbs_customer_id';

    IF position(old_expr IN def) = 0 OR position(old_join IN def) = 0 THEN
        IF position('LEFT JOIN customers c ON c.cif = cl.cbs_customer_id' IN def) = 0 THEN
            RAISE NOTICE '266: CBS-loan name join already corrected — leaving view untouched';
        ELSE
            RAISE WARNING '266: view shape differs from expectation — NOT modified, fix by hand';
        END IF;
        RETURN;
    END IF;

    new_expr := 'COALESCE(NULLIF(btrim(cc.name), ''''::text), '
             || 'NULLIF(btrim(cl.raw ->> ''name''::text), ''''::text), '
             || '( SELECT NULLIF(btrim(p.full_name), ''''::text) FROM cbs_links lk '
             ||   'JOIN parties p ON p.party_id = lk.entity_id '
             ||   'WHERE lk.entity_type = ''party''::text AND lk.cbs_customer_id = cl.cbs_customer_id LIMIT 1), '
             || 'cl.cbs_customer_id) AS customer_name';

    new_join := 'FROM cbs_loans cl
             LEFT JOIN cbs_customers cc ON cc.cbs_customer_id = cl.cbs_customer_id';

    def := replace(def, old_expr, new_expr);
    def := replace(def, old_join, new_join);

    EXECUTE 'CREATE OR REPLACE VIEW app.collections_delinquent_unified AS ' || def;
    RAISE NOTICE '266: collections queue now names the real Udara borrower';
END $$;

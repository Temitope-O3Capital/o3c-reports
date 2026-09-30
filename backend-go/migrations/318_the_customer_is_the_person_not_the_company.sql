-- 318: a lead's matched customer is the PERSON, not the person's company.
--
-- app.crm_contacts.matched_customer_cif was written by rescanCustomerLeads, which until
-- 2026-09-29 chose among several candidate customers with `ORDER BY cu.cif LIMIT 1`. That
-- guard is now person-aware in Go, but the rows it already wrote are still wrong.
--
-- Five leads resolve to exactly two parties: one 'person' and one 'organization' sharing a
-- phone — a sole proprietor and their own business. Lowest-CIF picked the COMPANY in every
-- one of the five:
--
--     lead 11960 'ODIBO AMOS'       -> 00039226 Bryams Limited       (person: Amos Odibo)
--     lead 18830 'ODIBO AMOS'       -> 00039226 Bryams Limited       (person: Amos Odibo)
--     lead 27981 'ODIBO AMOS'       -> 00039226 Bryams Limited       (person: Amos Odibo)
--     lead    90 '+234 9167204690'  -> 00039226 Bryams Limited       (person: Amos Odibo)
--     lead  8742 'ADESOLA ADESANYA' -> 00039190 A Global Enterprise  (person: Adesola Adesanya)
--
-- The lead's own name is the person in every case, which is what makes this a correction
-- rather than a guess. Where a person holds several CIFs we take the lowest of THEIRS — CIF
-- is a cards-only id and one person legitimately holds several, so any of their own cards
-- identifies the same human (see app.cbs_links and the identity notes).
--
-- already_customer stays true: the phone really does belong to a customer. Only the CIF that
-- names WHICH customer changes.
--
-- Scope check run 2026-09-30 over all 166 flagged leads: 161 already correct, these 5 wrong,
-- and ZERO where two genuinely different people share a number. Nothing here is ambiguous.

WITH cand AS (
    SELECT c.id                                          AS lead_id,
           c.matched_customer_cif                        AS cur,
           cu.cif                                        AS cif,
           COALESCE(cu.party_id::text, 'cif:' || cu.cif) AS identity,
           COALESCE(p.party_type, 'unknown')             AS pt
      FROM app.crm_contacts c
      JOIN app.customers cu
        ON app.normalise_ng_phone(cu.phone) = app.normalise_ng_phone(c.phone)
       AND cu.cif IS NOT NULL
      LEFT JOIN app.parties p ON p.party_id = cu.party_id
     WHERE c.already_customer = true
       AND c.matched_customer_cif IS NOT NULL
), agg AS (
    SELECT lead_id,
           count(DISTINCT identity) FILTER (WHERE pt = 'person') AS persons,
           min(cif)                 FILTER (WHERE pt = 'person') AS person_cif,
           bool_or(cif = cur AND pt = 'organization')            AS cur_is_org
      FROM cand
     GROUP BY lead_id, cur
)
UPDATE app.crm_contacts c
   SET matched_customer_cif = a.person_cif
  FROM agg a
 WHERE c.id = a.lead_id
   AND a.persons = 1
   AND a.cur_is_org
   AND a.person_cif IS DISTINCT FROM c.matched_customer_cif;

DO $m318$
DECLARE
    v_left  int;
    v_orgs  int;
    v_total int;
BEGIN
    -- Nothing may still name a company when exactly one person is on the number.
    WITH cand AS (
        SELECT c.id AS lead_id, c.matched_customer_cif AS cur, cu.cif,
               COALESCE(cu.party_id::text, 'cif:' || cu.cif) AS identity,
               COALESCE(p.party_type, 'unknown') AS pt
          FROM app.crm_contacts c
          JOIN app.customers cu
            ON app.normalise_ng_phone(cu.phone) = app.normalise_ng_phone(c.phone)
           AND cu.cif IS NOT NULL
          LEFT JOIN app.parties p ON p.party_id = cu.party_id
         WHERE c.already_customer = true AND c.matched_customer_cif IS NOT NULL
    ), agg AS (
        SELECT lead_id,
               count(DISTINCT identity) FILTER (WHERE pt = 'person') AS persons,
               bool_or(cif = cur AND pt = 'organization')            AS cur_is_org
          FROM cand GROUP BY lead_id, cur
    )
    SELECT count(*) INTO v_left FROM agg WHERE persons = 1 AND cur_is_org;

    IF v_left > 0 THEN
        RAISE EXCEPTION '318: % lead(s) still point at an organization when one person was available', v_left;
    END IF;

    -- A flagged lead must still carry an identity, and it must be a real customer's.
    SELECT count(*) INTO v_orgs
      FROM app.crm_contacts c
     WHERE c.already_customer = true
       AND c.matched_customer_cif IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM app.customers cu WHERE cu.cif = c.matched_customer_cif);
    IF v_orgs > 0 THEN
        RAISE EXCEPTION '318: % flagged lead(s) name a CIF that is not in app.customers', v_orgs;
    END IF;

    SELECT count(*) INTO v_total
      FROM app.crm_contacts WHERE already_customer = true AND matched_customer_cif IS NOT NULL;
    IF v_total < 160 THEN
        RAISE EXCEPTION '318: only % flagged leads left, expected ~166 — this migration must not unflag anyone', v_total;
    END IF;

    RAISE NOTICE '318: % flagged leads, all naming a person where one was identifiable', v_total;
END
$m318$;

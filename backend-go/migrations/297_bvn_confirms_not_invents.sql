-- 297 — A BVN identifies a PERSON, so it must not fuse a company with its proprietor.
--
-- THE DEFECT. app.assign_parties() builds three kinds of identity edge. Two of them carry
-- the name in the key, so they can only ever join records of the SAME name:
--
--     'np:'||nname||'|'||cphone      name + phone
--     'ne:'||nname||'|'||cemail      name + email
--     'bvn:'||cbvn                   BVN alone  <-- no name test at all
--
-- A BVN is issued to an individual. When a company record carries a BVN it is the
-- proprietor's, so matching on BVN alone asserts that the company and the person are one
-- entity. Two real examples, both found on 2026-09-24:
--
--     MAJREF LIMITED (U...595)                + JAMES OLUWAFEMI JOSHUA (U...540)
--     COSAH ENTERPRISE AND SERVICES (U...550) + SALIFU SIAKA ISAAC     (U...545)
--
-- Migration 273 hit this same shape and worked around it by keying its repoint on each
-- row's own contact_id rather than the party. The cause was never removed, so the edge kept
-- re-fusing them; today they are held apart only because app.cbs_links happens to point each
-- one at a different party. That is an accident, not a rule, and migration 295 could easily
-- have turned it into a merge.
--
-- THE FIX. Give the BVN edge the same name qualification the other two already have. A
-- shared BVN then confirms an identity it does not invent one: it still unites two records
-- of the same person, and it can no longer claim a company is its director.
--
-- WHAT THIS COSTS, MEASURED. Nothing. Of 22,187 customers only 137 carry a valid 11-digit
-- BVN, across 126 BVNs. 124 of those BVN groups already hold a single name, so the added
-- name test changes nothing for them. Exactly 2 groups span two names — the two pairs above.
-- So the BVN edge has never once united the same person under two different spellings; its
-- only cross-name effect in the whole database is the two wrong merges this removes. And
-- because migration 294 made the name key punctuation-insensitive and word-order-insensitive,
-- 'Momoh Abdul-Kadiri' and 'ABDUL-KADIRI MOMOH' still match, so the qualification costs far
-- less than it would have before 294.
--
-- NO DATA MOVES, AND THAT IS WHY THIS MIGRATION ONLY REPLACES THE FUNCTION. Verified by
-- running the corrected function in a rolled-back transaction: 0 customers change party.
-- The cluster key changes for exactly the two company records, but the cbs_links override
-- then puts them back on the party they already occupy. So there is nothing to re-point, and
-- deliberately no SELECT app.assign_parties() here — this change can SPLIT a cluster, and a
-- split makes the blanket "UPDATE ... SET party_id = new WHERE party_id = old" re-point used
-- by 294/295 wrong, because references belonging to the members that stayed would be dragged
-- along too. Preventive fixes should not carry a merge migration's machinery.
--
-- NOT AN INVARIANT: "a party holds one name". Exactly one party legitimately breaks it —
-- 708802, which holds HARRIET ODOMETA and ODOMETA ONOME because the business asserted they
-- are one person (migrations 291/295/296). Asserted identity is allowed to join two names;
-- an inferred edge is not. Do not add a guard that forbids it.
--
-- Everything else in the function is carried through unchanged from migration 296: the 294
-- name normalisation, the 274 cbs_links crosswalk, and the 296 label refresh.

BEGIN;

CREATE OR REPLACE FUNCTION app.assign_parties()
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE
  linked integer := 0;
BEGIN
  CREATE TEMP TABLE _res ON COMMIT DROP AS
  WITH base AS (
    SELECT contact_id, cif, full_name, email, phone, bvn,
      -- NAME NORMALISATION (migration 294). Punctuation stripped, words SORTED, so the same
      -- person entered two ways lands on one key. Can only ever merge, never split.
      (SELECT string_agg(t,' ' ORDER BY t)
         FROM unnest(string_to_array(
                regexp_replace(lower(trim(coalesce(full_name,''))),'[^a-z0-9]+',' ','g'),' ')) t
        WHERE t <> '') AS nname,
      app.norm_phone(phone) AS rawp,
      CASE WHEN regexp_replace(coalesce(bvn,''),'\D','','g') ~ '^[0-9]{11}$'
           THEN regexp_replace(bvn,'\D','','g') END AS cbvn,
      lower(nullif(trim(email),'')) AS cemail
    FROM app.customers
  ),
  ph_stats AS (
    SELECT rawp p, count(DISTINCT nname) ndn FROM base WHERE rawp ~ '^[789][0-9]{9}$' GROUP BY 1
  ),
  enr AS (
    SELECT b.*,
      CASE WHEN b.rawp ~ '^[789][0-9]{9}$' AND b.rawp !~ '^(.)\1{9}$' AND COALESCE(s.ndn,999) <= 3
           THEN b.rawp END AS cphone,
      (b.nname ~ '[a-z]{2,}\s+[a-z]{2,}') AS real_name
    FROM base b LEFT JOIN ph_stats s ON s.p = b.rawp
  ),
  edges AS (
    SELECT contact_id, 'np:'||nname||'|'||cphone AS key FROM enr WHERE real_name AND cphone IS NOT NULL
    UNION ALL SELECT contact_id, 'ne:'||nname||'|'||cemail FROM enr WHERE real_name AND cemail IS NOT NULL
    UNION ALL SELECT contact_id, 'bvn:'||nname||'|'||cbvn FROM enr
               WHERE cbvn IS NOT NULL AND nname IS NOT NULL AND nname <> ''
  ),
  ka1 AS (SELECT key, min(contact_id) a FROM edges GROUP BY key),
  ca1 AS (SELECT e.contact_id, min(k.a) a FROM edges e JOIN ka1 k USING(key) GROUP BY e.contact_id),
  ka2 AS (SELECT e.key, min(c.a) a FROM edges e JOIN ca1 c USING(contact_id) GROUP BY e.key),
  ca2 AS (SELECT e.contact_id, min(k.a) a FROM edges e JOIN ka2 k USING(key) GROUP BY e.contact_id)
  SELECT b.contact_id, b.cif, b.full_name, b.nname, b.email, b.cbvn, enr.cphone,
         COALESCE('p:'||ca2.a, 'cid:'||b.contact_id) AS party_key
  FROM base b JOIN enr USING (contact_id) LEFT JOIN ca2 ON ca2.contact_id = b.contact_id;

  -- ── migration 274: an ASSERTED identity beats an INFERRED one ───────────────
  -- app.cbs_links is a curated crosswalk from a Udara customer id to the party that holds
  -- that customer's facilities. Where it speaks, it wins. Migration 295 corrected the rows
  -- that pointed at a party NOT holding the customer's own cluster, which split people
  -- rather than uniting them.
  UPDATE _res r
     SET party_key = lp.party_key
    FROM app.customers c
    JOIN app.cbs_links lk
      ON lk.entity_type = 'party'
     AND lk.cbs_customer_id = CASE
           WHEN c.contact_id ~ '^U[0-9]{15}$'        THEN right(c.contact_id, 8)
           WHEN COALESCE(c.source,'') = 'udara_cbs'  THEN c.cif
         END
    JOIN app.parties lp ON lp.party_id = lk.entity_id
   WHERE c.contact_id = r.contact_id
     AND lp.party_key IS DISTINCT FROM r.party_key;

  -- New clusters -> new parties (existing ones untouched)
  INSERT INTO app.parties (party_key, party_type, full_name, primary_phone, primary_email, bvn, card_count)
  SELECT party_key,
    CASE WHEN mode() WITHIN GROUP (ORDER BY nname) ~* '(limited|ltd\.?|nig\b|enterprise|company|ventures|assoc|plc|cooperative|\bcoop\b|school|church|ministr|foundation|global|integrated|resources|services|systems|holdings|group\b)'
         THEN 'organization' ELSE 'person' END,
    mode() WITHIN GROUP (ORDER BY full_name),
    (array_agg(cphone) FILTER (WHERE cphone IS NOT NULL))[1],
    min(email) FILTER (WHERE email IS NOT NULL AND email <> ''),
    min(cbvn)  FILTER (WHERE cbvn IS NOT NULL),
    count(*)
  FROM _res GROUP BY party_key
  ON CONFLICT (party_key) DO NOTHING;

  -- Link customers to their party
  UPDATE app.customers c
  SET party_id = p.party_id
  FROM _res r JOIN app.parties p USING (party_key)
  WHERE c.contact_id = r.contact_id
    AND c.party_id IS DISTINCT FROM p.party_id;
  GET DIAGNOSTICS linked = ROW_COUNT;

  -- Keep card_count fresh
  UPDATE app.parties p
  SET card_count = x.n
  FROM (SELECT party_id, count(*) n FROM app.customers WHERE party_id IS NOT NULL GROUP BY party_id) x
  WHERE x.party_id = p.party_id AND p.card_count IS DISTINCT FROM x.n;

  -- ── migration 296: keep the label in step with who is on the party ─────────
  -- Fires ONLY where the current label matches no member, so it repairs a party that lost
  -- the member it was named after and never churns a label that is already somebody's.
  -- Udara-sourced names win; alphabetical breaks ties so repeated runs agree.
  UPDATE app.parties p
     SET full_name = x.nm
    FROM (
      SELECT c.party_id,
             (array_agg(c.full_name
                        ORDER BY (COALESCE(c.source,'') = 'udara_cbs') DESC, c.full_name))[1] AS nm
        FROM app.customers c
       WHERE c.party_id IS NOT NULL
         AND nullif(trim(coalesce(c.full_name,'')), '') IS NOT NULL
       GROUP BY c.party_id) x
   WHERE x.party_id = p.party_id
     AND p.full_name IS DISTINCT FROM x.nm
     AND NOT EXISTS (
       SELECT 1 FROM app.customers c2
        WHERE c2.party_id = p.party_id
          AND app.norm_name(c2.full_name) = app.norm_name(p.full_name));

  DROP TABLE IF EXISTS _res;
  RETURN linked;
END
$function$;

DO $m297$
DECLARE mixed int;
BEGIN
    -- Informational only, never fatal: how many BVN groups still span more than one name.
    -- Expected 2 before this change takes effect on the next re-clustering, 2 after (the
    -- records still hold those BVNs) — what changes is that the edge no longer JOINS them.
    SELECT COUNT(*) INTO mixed FROM (
      SELECT regexp_replace(bvn,'\D','','g') b
        FROM app.customers
       WHERE regexp_replace(coalesce(bvn,''),'\D','','g') ~ '^[0-9]{11}$'
         AND nullif(app.norm_name(full_name),'') IS NOT NULL
       GROUP BY 1 HAVING COUNT(DISTINCT app.norm_name(full_name)) > 1) z;
    RAISE NOTICE '297: BVN edge is now name-qualified; % BVN(s) are shared across more than one name and will no longer cluster', mixed;
END $m297$;

COMMIT;

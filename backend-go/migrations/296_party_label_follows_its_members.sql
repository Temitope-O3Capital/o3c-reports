-- 296 — A party's name should be the name of somebody on it.
--
-- THE DEFECT. app.parties.full_name is written once, by the INSERT in app.assign_parties():
--
--     INSERT INTO app.parties (..., full_name, ...)
--     SELECT ..., mode() WITHIN GROUP (ORDER BY full_name), ...
--     FROM _res GROUP BY party_key
--     ON CONFLICT (party_key) DO NOTHING;
--
-- ON CONFLICT DO NOTHING means an EXISTING party never has its label revisited. But
-- membership does change — re-clustering moves customers, migrations 273/294/295 merge
-- parties — and the label stays behind. Measured 2026-09-24, after 294: 103 parties carry a
-- name that no customer on them holds. All 103 hold exactly one customer, which is the
-- signature of a party that lost its other members and kept their name. Party 14927 is
-- labelled 'Oyewole Kole Jones' while the only person on it is OLUWATIMILEHIN KOLE JONES.
--
-- This is a display defect, not a money one — nothing joins on full_name — but it means a
-- customer page can show one person under another person's name, which is the kind of
-- error that gets repeated to a customer on a phone call.
--
-- THE FIX has two halves, and the second is the one that matters:
--   1. correct the 103 now;
--   2. make assign_parties() keep the label in step, so this cannot silently return.
--
-- WHEN IT REFRESHES, AND WHY NOT ALWAYS. The refresh fires only where the current label
-- matches NO member. That makes it self-limiting and idempotent: once a label matches
-- somebody it is never touched again, so a party holding 'Bashir Jambo' and 'JAMBO BASHIR'
-- keeps whichever it has rather than flip-flopping between two spellings on every nightly
-- run. Refreshing unconditionally from mode() would churn labels for no gain. Verified by
-- running assign_parties() a SECOND time in the same transaction: 0 customers moved and 0
-- labels were left stale.
--
-- WHICH NAME WINS. A Udara-sourced record first, then alphabetical for determinism. Udara
-- is the system of record for a borrower's name, which is the standing instruction for this
-- workspace; alphabetical is not meaningful, it is just repeatable, so two runs never
-- disagree.
--
-- SAFE BECAUSE NOTHING ELSE WRITES THIS COLUMN. Checked before writing: no Go handler
-- issues an UPDATE against app.parties at all, and the only reference to parties.full_name
-- in the backend is a SELECT in repayment_pattern.go. So there is no hand-typed party name
-- for this to overwrite. If a rename feature is ever added, this refresh must learn to skip
-- manually-set names.

BEGIN;

-- The name key used for comparison: lowercase, punctuation stripped, words sorted — the
-- same shape migration 294 gave the clustering, so 'Kole-Jones' and 'KOLE JONES' count as
-- the same name here too. Declared as a function because both halves below need it.
CREATE OR REPLACE FUNCTION app.norm_name(t text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $$
  SELECT string_agg(w, ' ' ORDER BY w)
    FROM unnest(string_to_array(
           regexp_replace(lower(trim(coalesce(t,''))), '[^a-z0-9]+', ' ', 'g'), ' ')) w
   WHERE w <> '';
$$;

COMMENT ON FUNCTION app.norm_name(text) IS
  'Comparison key for a person or company name: lowercased, punctuation stripped, words sorted. '
  'Used by migration 296 to tell whether a party label still matches one of its members. '
  'Matches the nname expression inside app.assign_parties() (migration 294).';

-- ── 1. Correct the labels that match nobody ─────────────────────────────────
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

-- ODOMETA is named explicitly, because her label is NOT stale by the test above — it
-- matches the member it came from. The business confirmed on 2026-09-23 that Udara is her
-- only source, and migration 295 merged HARRIET ODOMETA (Udara 00000355) onto this party,
-- so the party should carry the Udara name rather than the uploaded sheet's.
UPDATE app.parties p
   SET full_name = 'HARRIET ODOMETA'
 WHERE p.party_id = 708802
   AND EXISTS (SELECT 1 FROM app.customers c
                WHERE c.party_id = p.party_id AND c.full_name = 'HARRIET ODOMETA');

-- ── 2. Keep it in step from now on ──────────────────────────────────────────
-- Identical to migration 294's function, with one block added at the end. The nname
-- expression and the migration 274 crosswalk are carried through UNCHANGED — this file
-- must not become the place where either of those quietly regresses. Verified by diffing
-- this function body against 294's: the label block is the only difference.
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
    UNION ALL SELECT contact_id, 'bvn:'||cbvn FROM enr WHERE cbvn IS NOT NULL
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

DO $m296$
DECLARE orphan_labels int;
BEGIN
    SELECT COUNT(*) INTO orphan_labels
      FROM app.parties p
     WHERE p.full_name IS NOT NULL
       AND EXISTS (SELECT 1 FROM app.customers c WHERE c.party_id = p.party_id)
       AND EXISTS (SELECT 1 FROM app.customers c WHERE c.party_id = p.party_id
                    AND nullif(trim(coalesce(c.full_name,'')),'') IS NOT NULL)
       AND NOT EXISTS (
         SELECT 1 FROM app.customers c
          WHERE c.party_id = p.party_id
            AND app.norm_name(c.full_name) = app.norm_name(p.full_name));
    IF orphan_labels > 0 THEN
        RAISE EXCEPTION '296: % party(ies) still labelled with a name no member holds — refusing', orphan_labels;
    END IF;
    RAISE NOTICE '296: every party label now matches a customer on that party';
END $m296$;

COMMIT;

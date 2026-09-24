-- Rollback for 294 — one person, one party.
--
-- READ THIS FIRST: the DATA half of 294 is NOT reversible by this script, and no honest
-- rollback can make it so. 294 folded 105 retired parties into the parties that already
-- held the same person and carried 164 stamped references across with them. Undoing that
-- needs the old party_id of every moved row, and 294 kept that map only in a temp table
-- (m294_remap, ON COMMIT DROP) because the alternative — a permanent audit table — was
-- not worth the schema for a change that can only ever merge. If the merges themselves
-- must come off, restore from a backup taken before 294 ran.
--
-- What this script DOES do is restore the name normalisation, so no FURTHER merging
-- happens on the next run of app.assign_parties(). That is the part that matters
-- operationally: it stops the behaviour. Already-merged parties stay merged, which is
-- safe — a merged party holds all of the person's records and all of their money; it is
-- the split state that loses figures.
--
-- Rows retired outright by 294 (a duplicate app.customer_lifecycle row, duplicate
-- app.party_contact_consent grants) are not restored either. The lifecycle table is fully
-- derived and compute_customer_lifecycle() rebuilds it on its next run. The consent rows
-- deleted were duplicate GRANTS for a person who still holds the identical grant on the
-- surviving party, so no permission is lost by leaving them gone; 294 explicitly copies a
-- non-granted state onto the survivor before deleting, so no withdrawal was dropped.

BEGIN;

-- Restore the pre-294 nname: lowercase and squeeze whitespace only, with no punctuation
-- stripping and no word sorting. Everything else in the function is left as 294 had it —
-- in particular the migration 274 cbs_links crosswalk, which predates 294 and must stay.
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
      lower(regexp_replace(trim(coalesce(full_name,'')),'\s+',' ','g')) AS nname,
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

  -- migration 274: an ASSERTED identity beats an INFERRED one. Predates 294; retained.
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

  UPDATE app.customers c
  SET party_id = p.party_id
  FROM _res r JOIN app.parties p USING (party_key)
  WHERE c.contact_id = r.contact_id
    AND c.party_id IS DISTINCT FROM p.party_id;
  GET DIAGNOSTICS linked = ROW_COUNT;

  UPDATE app.parties p
  SET card_count = x.n
  FROM (SELECT party_id, count(*) n FROM app.customers WHERE party_id IS NOT NULL GROUP BY party_id) x
  WHERE x.party_id = p.party_id AND p.card_count IS DISTINCT FROM x.n;

  DROP TABLE IF EXISTS _res;
  RETURN linked;
END
$function$;

COMMIT;

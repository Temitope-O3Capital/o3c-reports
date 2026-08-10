-- 131: app.assign_parties() — reusable, idempotent person-resolution so NEW
-- customers arriving via the cust_file feed get linked to a person (party_id).
-- Same conservative rules as migration 130. Stable: existing party_ids never
-- change (a cluster's key = 'p:'||min(contact_id); new rows always have larger
-- contact_ids, so anchors — and thus party_keys — are preserved). Returns the
-- number of customer rows (re)linked.

CREATE OR REPLACE FUNCTION app.assign_parties() RETURNS integer
LANGUAGE plpgsql AS $fn$
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

  DROP TABLE IF EXISTS _res;
  RETURN linked;
END $fn$;

-- 130: Person (party) layer above CIF. A CIF is a card/account, not a person — one
-- human holds many CIFs. This adds app.parties (one row per real person/org) and
-- links every card-holder row (app.customers) to its person via party_id.
-- Conservative, transitive resolution (BVN | name+real-phone | name+email), with
-- placeholder-phone and initials-name guards. Additive & reversible: no CIF/card
-- row is changed or deleted — they are only grouped. Idempotent.

-- ── Schema ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app.parties (
  party_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  party_key     text UNIQUE NOT NULL,           -- deterministic cluster key
  party_type    text NOT NULL DEFAULT 'person', -- person | organization
  full_name     text,
  primary_phone text,
  primary_email text,
  bvn           text,
  card_count    int  NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE app.customers ADD COLUMN IF NOT EXISTS party_id bigint;

-- ── Resolution (keyed on contact_id, the stable PK) ────────────────────────
DROP TABLE IF EXISTS _res;
CREATE TEMP TABLE _res AS
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
SELECT b.contact_id, b.cif, b.full_name, b.nname, b.email, b.cbvn,
       b.rawp, enr.cphone,
       COALESCE('p:'||ca2.a, 'cid:'||b.contact_id) AS party_key
FROM base b
JOIN enr USING (contact_id)
LEFT JOIN ca2 ON ca2.contact_id = b.contact_id;

-- ── Populate parties (canonical attributes per cluster) ────────────────────
INSERT INTO app.parties (party_key, party_type, full_name, primary_phone, primary_email, bvn, card_count)
SELECT
  party_key,
  CASE WHEN mode() WITHIN GROUP (ORDER BY nname) ~* '(limited|ltd\.?|nig\b|enterprise|company|ventures|assoc|plc|cooperative|\bcoop\b|school|church|ministr|foundation|global|integrated|resources|services|systems|holdings|group\b)'
       THEN 'organization' ELSE 'person' END,
  mode() WITHIN GROUP (ORDER BY full_name),
  (array_agg(cphone) FILTER (WHERE cphone IS NOT NULL))[1],
  min(email) FILTER (WHERE email IS NOT NULL AND email <> ''),
  min(cbvn)  FILTER (WHERE cbvn IS NOT NULL),
  count(*)
FROM _res
GROUP BY party_key
ON CONFLICT (party_key) DO NOTHING;

-- ── Link every card-holder row to its person ───────────────────────────────
UPDATE app.customers c
SET party_id = p.party_id
FROM _res r JOIN app.parties p USING (party_key)
WHERE c.contact_id = r.contact_id
  AND c.party_id IS DISTINCT FROM p.party_id;

-- ── Constraints & indexes ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_customers_party_id ON app.customers (party_id);
CREATE INDEX IF NOT EXISTS idx_parties_type       ON app.parties (party_type);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_party_id_fkey') THEN
    ALTER TABLE app.customers
      ADD CONSTRAINT customers_party_id_fkey FOREIGN KEY (party_id)
      REFERENCES app.parties(party_id) ON DELETE SET NULL;
  END IF;
END $$;

-- ── Person-level directory view ────────────────────────────────────────────
CREATE OR REPLACE VIEW app.v_persons AS
SELECT
  p.party_id, p.party_type, p.full_name, p.primary_phone, p.primary_email, p.bvn,
  p.card_count,
  (SELECT array_agg(DISTINCT c.cif ORDER BY c.cif) FROM app.customers c WHERE c.party_id = p.party_id) AS cifs,
  (SELECT array_agg(DISTINCT a.product_name) FROM app.accounts a
     JOIN app.customers c ON c.cif = a.cif WHERE c.party_id = p.party_id) AS products,
  (SELECT max(c.state) FROM app.customers c WHERE c.party_id = p.party_id) AS state,
  (SELECT max(c.country) FROM app.customers c WHERE c.party_id = p.party_id) AS country
FROM app.parties p;

DROP TABLE IF EXISTS _res;

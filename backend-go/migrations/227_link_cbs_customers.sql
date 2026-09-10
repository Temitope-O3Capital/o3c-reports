-- 227: continuously give every Udara customer a workspace party (CUST) + crosswalk link.
--
-- Migration 210 built the party/link layer ONCE, from the loan/FD books only, so it saw
-- just facility holders as they stood on 2026-09-08. Customers with no facility (and any
-- facility booked afterwards) never got a party. Now that the full Udara customer master
-- is mirrored (cbs_customers, migration 226), this function creates the missing parties
-- and links, and — crucially — runs on every sync so new Udara customers are onboarded
-- automatically, not by a one-off migration.
--
-- CIF is a CARD identifier; Udara's customerID is a different namespace that merely
-- collides with it (the FINTRAK bug). So a Udara customer is NEVER linked by cif==cif.
-- Merge into an existing party ONLY on BVN — the one unique-per-person key. The card book
-- carries no reliable BVN and its phone numbers are shared across family members with
-- nickname-style names, so name/phone auto-merge would fuse different people. When no BVN
-- match exists, a fresh party is created (party_key 'CBS:<cif>', same convention as mig
-- 210). Everything is additive + idempotent: a customer already linked is skipped.

CREATE OR REPLACE FUNCTION app.link_cbs_customers() RETURNS integer AS $func$
DECLARE
  made integer := 0;
BEGIN
  -- Master customers with no cbs_links row yet.
  CREATE TEMP TABLE _u ON COMMIT DROP AS
  SELECT cc.cbs_customer_id                                          AS cif,
         NULLIF(btrim(cc.name), '')                                  AS nm,
         CASE WHEN regexp_replace(coalesce(cc.bvn, ''), '\D', '', 'g') ~ '^[0-9]{11}$'
              THEN regexp_replace(cc.bvn, '\D', '', 'g') END         AS cbvn,
         cc.customer_type,
         NULLIF(btrim(cc.phone), '')                                 AS phone,
         NULLIF(btrim(cc.email), '')                                 AS email
  FROM cbs_customers cc
  WHERE NOT EXISTS (SELECT 1 FROM app.cbs_links l WHERE l.cbs_customer_id = cc.cbs_customer_id);

  -- Parties matchable by a UNIQUE 11-digit BVN, not already carrying a Udara link.
  CREATE TEMP TABLE _bvnmap ON COMMIT DROP AS
  SELECT regexp_replace(p.bvn, '\D', '', 'g') AS cbvn, min(p.party_id) AS pid
  FROM app.parties p
  WHERE regexp_replace(coalesce(p.bvn, ''), '\D', '', 'g') ~ '^[0-9]{11}$'
    AND NOT EXISTS (SELECT 1 FROM app.cbs_links l WHERE l.entity_type = 'party' AND l.entity_id = p.party_id)
  GROUP BY 1 HAVING count(*) = 1;

  -- Target existing party (BVN only); NULL target => create a fresh party.
  CREATE TEMP TABLE _tgt ON COMMIT DROP AS
  SELECT u.*, b.pid AS target
  FROM _u u LEFT JOIN _bvnmap b ON b.cbvn = u.cbvn;

  -- (a) BVN-matched: link the Udara customer onto the existing party.
  INSERT INTO app.cbs_links (entity_type, entity_id, cbs_account_number, cbs_customer_id, linked_at, notes)
  SELECT 'party', t.target, '', t.cif, NOW(), 'auto: Udara customer matched by BVN (link_cbs_customers)'
  FROM _tgt t WHERE t.target IS NOT NULL
  ON CONFLICT (entity_type, entity_id) DO NOTHING;

  -- (b) Unmatched: create a fresh party (CUST), classified org/person, then link it.
  INSERT INTO app.parties (party_key, party_type, full_name, primary_phone, primary_email, bvn, card_count, created_at)
  SELECT 'CBS:' || t.cif,
         CASE WHEN t.customer_type = 'Corporate'
                OR t.nm ~* '(LTD|LIMITED|LLC| PLC|ENTERPRISE|VENTURE|SOCIETY|COOP|COMPANY|RESOURCE|SERVICE|TECHNOLOG|GLOBAL|HOTEL|AGRIC|SOFTWARE|SCHOOL|CHURCH|MINISTR|FARM|STORE|GROUP|ASSOCIATION|UNION|CONCEPT|INTEGRATED|HOLDING)'
              THEN 'organization' ELSE 'person' END,
         t.nm, t.phone, t.email, t.cbvn, 0, NOW()
  FROM _tgt t WHERE t.target IS NULL
  ON CONFLICT (party_key) DO NOTHING;

  INSERT INTO app.cbs_links (entity_type, entity_id, cbs_account_number, cbs_customer_id, linked_at, notes)
  SELECT 'party', p.party_id, '', t.cif, NOW(), 'auto: new Udara customer party (link_cbs_customers)'
  FROM _tgt t JOIN app.parties p ON p.party_key = 'CBS:' || t.cif
  WHERE t.target IS NULL
  ON CONFLICT (entity_type, entity_id) DO NOTHING;

  SELECT count(*) INTO made
  FROM _u u WHERE EXISTS (SELECT 1 FROM app.cbs_links l WHERE l.cbs_customer_id = u.cif);
  RETURN made;
END;
$func$ LANGUAGE plpgsql;

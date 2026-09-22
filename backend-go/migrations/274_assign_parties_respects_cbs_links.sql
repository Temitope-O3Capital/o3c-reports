-- 274 — Make app.assign_parties() respect app.cbs_links, and re-apply migration 273.
--
-- ── WHY 273 DID NOT HOLD ─────────────────────────────────────────────────────
-- Migration 273 moved 264 Udara KYC profiles onto the party that carries the customer's
-- facilities, and verified 0 stranded at 10:52:35. By 11:0x all 264 were back on the KYC
-- shells. The repoint was correct and it was reverted, because app.assign_parties() runs
-- from cbssync (every 3 minutes) and custfeed (every 15) and ends with:
--
--     UPDATE app.customers c SET party_id = p.party_id
--       FROM _res r JOIN app.parties p USING (party_key)
--      WHERE c.contact_id = r.contact_id AND c.party_id IS DISTINCT FROM p.party_id;
--
-- It re-derives EVERY customer's party from that customer's own attributes — name+phone,
-- name+email, BVN — and overwrites party_id with the result. It has no knowledge of
-- app.cbs_links. So a Udara customer is deterministically pushed back onto a party keyed
-- off their own contact_id, for ever, and any one-shot data migration is undone within
-- three minutes.
--
-- That also explains the fragmentation itself. Nothing "minted duplicates by mistake" on
-- 2026-09-21: assign_parties computed those parties, correctly by its own rules, because
-- the Udara profiles had just been created and nothing told it they already had a party.
-- Fixing the data without fixing this function is pointless.
--
-- ── THE FIX ──────────────────────────────────────────────────────────────────
-- One override, applied to _res AFTER the clustering and BEFORE any party is created:
-- if a customer row is Udara-sourced and app.cbs_links names a party for its Udara id,
-- that party's key wins over the derived one. cbs_links is a curated crosswalk — an
-- asserted identity — and an assertion must beat an inference.
--
-- Applying it before the INSERT matters twice: the derived 'p:U…' / 'cid:U…' shells are
-- never created in the first place, and the existing UPDATE then lands every Udara
-- profile on the facility party and KEEPS it there on every subsequent run. The repair
-- becomes self-healing instead of a snapshot.
--
-- Rows matched, deliberately narrowly:
--   * contact_id 'U'||lpad(udara id,15,'0')  — the 264 Udara KYC profiles
--   * source = 'udara_cbs' with a cif that is a live Udara customer id — the 18 older
--     'Z…' rows that predate the U-namespace. Restricted to source='udara_cbs' so a
--     GENUINE cards CIF that merely collides with a Udara id can never be caught: that is
--     the whole failure this codebase keeps repeating (271 of 295 Udara ids also exist as
--     a cards CIF, and 100% of those are a different person).
--
-- Everything else is untouched: a customer with no Udara link clusters exactly as before.
--
-- ── WHAT THIS DOES NOT FIX ───────────────────────────────────────────────────
-- The 18 'Z…' Udara rows still hold a Udara id in `cif`, and app.customers is keyed by
-- contact_id with uq_customers_cif on cif. custfeed/ingest.go inserts cards customers as
-- ('Z'||lpad(cif,15,'0'), cif) with ON CONFLICT (cif) DO UPDATE, so a real cards customer
-- arriving on one of those 18 numbers would OVERWRITE the Udara borrower's name, phone,
-- email and address in place. None of the 18 collides with a live card today (0 accounts,
-- 0 card_book rows each), so this is a live hazard but not a live defect, and unpicking it
-- means merging 14 duplicate profile pairs — a separate, evidence-led change, not a
-- rider on this one.

BEGIN;

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

  -- ── migration 274: an ASSERTED identity beats an INFERRED one ───────────────
  -- app.cbs_links is a curated crosswalk from a Udara customer id to the party that holds
  -- that customer's facilities. Where it speaks, it wins: the clustering above knows only
  -- what is on the customer row and will otherwise strand every Udara borrower's KYC on a
  -- party of its own, away from their money. Runs before the INSERT below so the derived
  -- shells are never created.
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

  DROP TABLE IF EXISTS _res;
  RETURN linked;
END
$fn$;

COMMENT ON FUNCTION app.assign_parties() IS
    'Resolves app.customers rows to app.parties. Clusters on name+phone, name+email and '
    'BVN, EXCEPT where app.cbs_links asserts a party for a Udara-sourced row — an asserted '
    'identity beats an inferred one (migration 274). Called from cbssync every 3 minutes '
    'and custfeed every 15, and it OVERWRITES party_id, so any data migration that '
    'repoints a customer must be reflected here or it is undone within minutes.';

-- Re-apply the repoint this function had been reverting, now that it will hold.
SELECT app.assign_parties();

DO $$
DECLARE stranded int; onparty int;
BEGIN
    SELECT count(*) INTO stranded
      FROM app.customers c
      JOIN app.cbs_links lk ON lk.entity_type='party' AND lk.cbs_customer_id = right(c.contact_id,8)
     WHERE c.contact_id ~ '^U[0-9]{15}$' AND c.party_id IS DISTINCT FROM lk.entity_id;
    SELECT count(*) INTO onparty
      FROM app.customers c
      JOIN app.cbs_links lk ON lk.entity_type='party' AND lk.cbs_customer_id = right(c.contact_id,8)
     WHERE c.contact_id ~ '^U[0-9]{15}$' AND c.party_id = lk.entity_id;
    IF stranded > 0 THEN
        RAISE EXCEPTION '274: % Udara KYC profiles still off their facility party after re-running assign_parties', stranded;
    END IF;
    RAISE NOTICE '274: % Udara KYC profiles on their facility party, 0 stranded — and assign_parties will now keep them there', onparty;
END $$;

COMMIT;

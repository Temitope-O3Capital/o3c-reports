-- 295 — Stop app.cbs_links pulling a Udara customer away from their own cluster.
--
-- THE DEFECT. Migration 274 gave app.cbs_links the last word in app.assign_parties(): a
-- curated Udara-id -> party crosswalk overrides whatever the clustering inferred. That is
-- right in principle, and it is what keeps 264 Udara KYC rows attached to their facilities.
-- But the crosswalk was allowed to point at a party that does NOT hold the customer's own
-- cluster, and when it does the override does not unite anything — it SPLITS a person:
--
--     ASI ENGINEERING LIMITED
--       party 2319558  key p:U000000000000620   holds W000000000000010  (manual)
--       party  708774  key cid:W000000000000010 holds U000000000000620  (udara_cbs)
--
-- The two party_keys are crossed. Both customers carry the same name AND the same email
-- (info@asiengineeringlimited.ng), so the clustering puts them together in cluster
-- p:U000000000000620 — and then the crosswalk drags the Udara half out to party 708774,
-- whose key is the OTHER half's. Every run re-creates the split, which is why migration
-- 273's `sibling_profile_on_same_party` step was found reverted: 2 of its 15 rows had gone
-- back. (The other 13 held — they were renamed Z... -> U..., which brought them under the
-- crosswalk. Nothing was lost.)
--
-- THE FIX. Point the crosswalk at the party that holds the cluster. Then the override
-- becomes a no-op for these customers, the natural cluster wins, and the person is one
-- party. This is a correction to curated data, not a change to the clustering rule — 294
-- already handles names, and these survived it only because the crosswalk outranks it.
--
-- WHICH SPLITS ARE FIXED, AND WHY THAT TEST AND NOT ANOTHER. Derived, not hand-listed:
-- every natural cluster whose members sit on more than one party AND who all share ONE
-- normalised name. Measured 2026-09-24: 8 clusters are split, and the name test keeps
-- exactly the right 6:
--
--   MERGED (one name, plus a shared email or phone):
--     ADELOYE BAYONLE / Bayonle Adeloye      18754 <- 763237    (email + phone)
--     GEORGE OSAHON / OSAHON GEORGE          18757 <- 227336    (email + phone)
--     ABDUL-KADIRI MOMOH / MOMOH ...         18818 <- 763255    (email + phone)
--     ASI ENGINEERING LIMITED              2319558 <- 708774    (email)
--     MARY OPEYEMI OMOLAOLU / OMOLAOLU ... 2319563 <- 763108    (phone)
--     HENGOOB MULTI-SERVICES LIMITED       2319609 <- 708793    (email)
--
--   LEFT ALONE (two names in one cluster — these are NOT one person):
--     MAJREF LIMITED          + JAMES OLUWAFEMI JOSHUA
--     COSAH ENTERPRISE AND SERVICES + SALIFU SIAKA ISAAC
--
-- Those last two are a company and its proprietor sharing a BVN. The BVN edge in
-- assign_parties carries no name test, so it clusters them; today they stay apart only
-- because the crosswalk happens to hold them apart. Merging a company into its director
-- would be wrong, so the single-name test excludes them — deliberately, and this migration
-- does not make their situation any better or worse.
--
-- ODOMETA is the one entry that is NOT derived. ODOMETA ONOME (party 708802, from the
-- uploaded sheet) and HARRIET ODOMETA (party 763109, Udara 00000355) hold no phone, no
-- email and no BVN between them and their names do not match, so nothing in the data joins
-- them and no rule can find them. The business confirmed on 2026-09-23 that they are one
-- person and that Udara is her only source; migration 291 already acted on that. This
-- writes the assertion into the crosswalk so it survives the next re-clustering. Her Udara
-- facilities keep their bridge, because the crosswalk row is what the bridge IS.
--
-- Note her UD-00000355 queue row (collections 1817) appeared on its own on 2026-09-24,
-- exactly as 291 predicted: the 23 September instalment was missed and the Udara arm
-- reclaimed her. That row re-points onto the surviving party here.

BEGIN;

-- Where each customer sits BEFORE, so the old -> new map can be derived afterwards.
CREATE TEMP TABLE m295_before ON COMMIT DROP AS
SELECT contact_id, party_id FROM app.customers WHERE party_id IS NOT NULL;

-- ── Derive the crosswalk corrections ────────────────────────────────────────
-- This repeats assign_parties()' own edge logic, because the question being asked is
-- precisely "what would the clustering do if the crosswalk were not overriding it".
CREATE TEMP TABLE m295_link_fix ON COMMIT DROP AS
WITH base AS (
  SELECT contact_id, full_name, party_id,
    (SELECT string_agg(t,' ' ORDER BY t) FROM unnest(string_to_array(
              regexp_replace(lower(trim(coalesce(full_name,''))),'[^a-z0-9]+',' ','g'),' ')) t
      WHERE t <> '') AS nname,
    app.norm_phone(phone) AS rawp,
    CASE WHEN regexp_replace(coalesce(bvn,''),'\D','','g') ~ '^[0-9]{11}$'
         THEN regexp_replace(bvn,'\D','','g') END AS cbvn,
    lower(nullif(trim(email),'')) AS cemail
  FROM app.customers),
ph_stats AS (
  SELECT rawp p, count(DISTINCT nname) ndn FROM base WHERE rawp ~ '^[789][0-9]{9}$' GROUP BY 1),
enr AS (
  SELECT b.*,
         CASE WHEN b.rawp ~ '^[789][0-9]{9}$' AND b.rawp !~ '^(.)\1{9}$'
                   AND COALESCE(s.ndn,999) <= 3 THEN b.rawp END AS cphone,
         (b.nname ~ '[a-z]{2,}\s+[a-z]{2,}') AS real_name
    FROM base b LEFT JOIN ph_stats s ON s.p = b.rawp),
edges AS (
  SELECT contact_id, 'np:'||nname||'|'||cphone AS key FROM enr WHERE real_name AND cphone IS NOT NULL
  UNION ALL SELECT contact_id, 'ne:'||nname||'|'||cemail FROM enr WHERE real_name AND cemail IS NOT NULL
  UNION ALL SELECT contact_id, 'bvn:'||cbvn FROM enr WHERE cbvn IS NOT NULL),
ka1 AS (SELECT key, min(contact_id) a FROM edges GROUP BY key),
ca1 AS (SELECT e.contact_id, min(k.a) a FROM edges e JOIN ka1 k USING(key) GROUP BY e.contact_id),
ka2 AS (SELECT e.key, min(c.a) a FROM edges e JOIN ca1 c USING(contact_id) GROUP BY e.key),
ca2 AS (SELECT e.contact_id, min(k.a) a FROM edges e JOIN ka2 k USING(key) GROUP BY e.contact_id),
cl AS (SELECT b.contact_id, b.nname, b.party_id, ca2.a AS cluster
         FROM base b JOIN ca2 ON ca2.contact_id = b.contact_id),
-- A cluster split over two or more parties, all of whose members are the SAME name.
split AS (
  SELECT cluster
    FROM cl
   GROUP BY cluster
  HAVING COUNT(DISTINCT party_id) > 1
     AND COUNT(DISTINCT nname)   = 1)
SELECT right(c.contact_id, 8)                                    AS cbs_customer_id,
       l.entity_id                                               AS from_party,
       p.party_id                                                AS to_party,
       'cluster '||s.cluster||' was split by the crosswalk'       AS reason
  FROM split s
  JOIN cl  c ON c.cluster = s.cluster
  JOIN app.parties p ON p.party_key = 'p:'||s.cluster
  JOIN app.cbs_links l
    ON l.entity_type = 'party'
   AND l.cbs_customer_id = right(c.contact_id, 8)
 WHERE c.contact_id ~ '^U[0-9]{15}$'
   AND l.entity_id <> p.party_id;

-- ODOMETA: asserted by the business, derivable from nothing.
INSERT INTO m295_link_fix (cbs_customer_id, from_party, to_party, reason)
SELECT '00000355', l.entity_id, 708802,
       'asserted 2026-09-23: ODOMETA ONOME (708802) and HARRIET ODOMETA are one person'
  FROM app.cbs_links l
 WHERE l.entity_type = 'party' AND l.cbs_customer_id = '00000355'
   AND l.entity_id <> 708802;

DO $m295$
DECLARE n int; bad int;
BEGIN
    SELECT COUNT(*) INTO n FROM m295_link_fix;
    -- A no-op is fine (another session may have fixed these). A flood is not: 7 were
    -- verified by hand, so anything near a hundred means the derivation has changed
    -- meaning and must be re-read before it rewrites the curated crosswalk wholesale.
    IF n > 25 THEN
        RAISE EXCEPTION '295: % crosswalk corrections derived, expected about 7 — refusing', n;
    END IF;
    -- Every destination must be a real party that currently holds customers.
    SELECT COUNT(*) INTO bad FROM m295_link_fix f
     WHERE NOT EXISTS (SELECT 1 FROM app.customers c WHERE c.party_id = f.to_party);
    IF bad > 0 THEN
        RAISE EXCEPTION '295: % correction(s) point at a party holding no customers — refusing', bad;
    END IF;
    RAISE NOTICE '295: % crosswalk correction(s) to apply', n;
END $m295$;

UPDATE app.cbs_links l
   SET entity_id = f.to_party,
       notes     = COALESCE(l.notes||' | ','')||'295: re-pointed from party '||f.from_party||' ('||f.reason||')'
  FROM m295_link_fix f
 WHERE l.entity_type = 'party'
   AND l.cbs_customer_id = f.cbs_customer_id;

-- Re-cluster now, in this transaction, so the remap below sees the result.
SELECT app.assign_parties();

CREATE TEMP TABLE m295_remap ON COMMIT DROP AS
SELECT DISTINCT b.party_id AS old_id, c.party_id AS new_id
  FROM m295_before b
  JOIN app.customers c USING (contact_id)
 WHERE c.party_id IS NOT NULL
   AND b.party_id IS DISTINCT FROM c.party_id;

DO $m295$
DECLARE ambiguous int; moved int;
BEGIN
    SELECT COUNT(*) INTO ambiguous
      FROM (SELECT old_id FROM m295_remap GROUP BY 1 HAVING COUNT(DISTINCT new_id) > 1) z;
    IF ambiguous > 0 THEN
        RAISE EXCEPTION '295: % party(ies) map to more than one successor — a split, refusing', ambiguous;
    END IF;
    SELECT COUNT(*) INTO moved FROM m295_remap;
    IF moved > 200 THEN
        RAISE EXCEPTION '295: % customers would move, expected a handful — refusing', moved;
    END IF;
    RAISE NOTICE '295: % party reference(s) to re-point', moved;
END $m295$;

UPDATE app.activities             t SET party_id = r.new_id FROM m295_remap r WHERE t.party_id = r.old_id;
UPDATE app.call_center_contacts   t SET party_id = r.new_id FROM m295_remap r WHERE t.party_id = r.old_id;
UPDATE app.call_center_leads      t SET party_id = r.new_id FROM m295_remap r WHERE t.party_id = r.old_id;
UPDATE app.collection_assignments t SET party_id = r.new_id FROM m295_remap r WHERE t.party_id = r.old_id;
UPDATE app.collection_payments    t SET party_id = r.new_id FROM m295_remap r WHERE t.party_id = r.old_id;
UPDATE app.contact_suppressions   t SET party_id = r.new_id FROM m295_remap r WHERE t.party_id = r.old_id;
UPDATE app.crm_contacts           t SET party_id = r.new_id FROM m295_remap r WHERE t.party_id = r.old_id;
UPDATE app.customer_officers      t SET party_id = r.new_id FROM m295_remap r WHERE t.party_id = r.old_id;
UPDATE app.dunning_sends          t SET party_id = r.new_id FROM m295_remap r WHERE t.party_id = r.old_id;
UPDATE app.loan_applications      t SET party_id = r.new_id FROM m295_remap r WHERE t.party_id = r.old_id;
UPDATE app.recovery_cases         t SET party_id = r.new_id FROM m295_remap r WHERE t.party_id = r.old_id;

-- Unique-keyed tables: collapse onto the survivor, exactly as migration 294 did. See 294
-- for why each is a DELETE and not a re-point; customer_lifecycle in particular has its
-- PRIMARY KEY on party_id, so a plain re-point is a startup crash.
DELETE FROM app.customer_lifecycle cl USING m295_remap r
 WHERE cl.party_id = r.old_id
   AND EXISTS (SELECT 1 FROM app.customer_lifecycle s WHERE s.party_id = r.new_id);
UPDATE app.customer_lifecycle t SET party_id = r.new_id FROM m295_remap r WHERE t.party_id = r.old_id;

UPDATE app.party_contact_consent s
   SET state = l.state, basis = l.basis, evidence = l.evidence,
       recorded_at = l.recorded_at, expires_at = l.expires_at
  FROM m295_remap r
  JOIN app.party_contact_consent l ON l.party_id = r.old_id
 WHERE s.party_id = r.new_id AND s.channel = l.channel AND s.purpose = l.purpose
   AND l.state IS DISTINCT FROM 'granted' AND s.state = 'granted';
DELETE FROM app.party_contact_consent l USING m295_remap r
 WHERE l.party_id = r.old_id
   AND EXISTS (SELECT 1 FROM app.party_contact_consent s
                WHERE s.party_id = r.new_id AND s.channel = l.channel AND s.purpose = l.purpose);
UPDATE app.party_contact_consent t SET party_id = r.new_id FROM m295_remap r WHERE t.party_id = r.old_id;

DELETE FROM app.customer_messages m USING m295_remap r
 WHERE m.party_id = r.old_id AND m.journey IS NOT NULL
   AND m.state IN ('preview','queued','sent')
   AND EXISTS (SELECT 1 FROM app.customer_messages s
                WHERE s.party_id = r.new_id AND s.journey = m.journey
                  AND s.state IN ('preview','queued','sent')
                  AND (s.created_at AT TIME ZONE 'UTC')::date = (m.created_at AT TIME ZONE 'UTC')::date);
UPDATE app.customer_messages t SET party_id = r.new_id FROM m295_remap r WHERE t.party_id = r.old_id;

-- Any OTHER crosswalk row still naming a retired party follows too.
UPDATE app.cbs_links t SET entity_id = r.new_id
  FROM m295_remap r WHERE t.entity_type = 'party' AND t.entity_id = r.old_id;

-- Record the merges where 273 recorded its own, so the trail is in one place.
INSERT INTO app.party_merge_audit
       (step, table_name, row_key, udara_id, old_party_id, new_party_id, customer_name, evidence)
-- Keyed off the before-snapshot so only the customers that actually MOVED are recorded.
-- Joining on the survivor party instead would log every customer already sitting there
-- (five, for ADELOYE BAYONLE) as though it had been merged.
SELECT 'crosswalk_repointed_to_cluster', 'app.customers', c.contact_id,
       CASE WHEN c.contact_id ~ '^U[0-9]{15}$' THEN right(c.contact_id,8) END,
       b.party_id, c.party_id, c.full_name,
       'migration 295: cbs_links pointed at a party that did not hold this customer''s cluster'
  FROM m295_before b
  JOIN app.customers c USING (contact_id)
 WHERE c.party_id IS NOT NULL
   AND c.party_id IS DISTINCT FROM b.party_id;

DO $m295$
DECLARE stranded int;
BEGIN
    SELECT COUNT(*) INTO stranded FROM (
        SELECT party_id FROM app.recovery_cases                   WHERE party_id IS NOT NULL
        UNION ALL SELECT party_id FROM app.collection_assignments  WHERE party_id IS NOT NULL
        UNION ALL SELECT party_id FROM app.crm_contacts            WHERE party_id IS NOT NULL
        UNION ALL SELECT party_id FROM app.call_center_leads       WHERE party_id IS NOT NULL
        UNION ALL SELECT party_id FROM app.call_center_contacts    WHERE party_id IS NOT NULL
        UNION ALL SELECT party_id FROM app.customer_lifecycle      WHERE party_id IS NOT NULL
        UNION ALL SELECT party_id FROM app.party_contact_consent   WHERE party_id IS NOT NULL
        UNION ALL SELECT party_id FROM app.customer_messages       WHERE party_id IS NOT NULL
        UNION ALL SELECT party_id FROM app.activities              WHERE party_id IS NOT NULL
        UNION ALL SELECT party_id FROM app.customer_officers       WHERE party_id IS NOT NULL
        UNION ALL SELECT party_id FROM app.dunning_sends           WHERE party_id IS NOT NULL
        UNION ALL SELECT party_id FROM app.loan_applications       WHERE party_id IS NOT NULL
        UNION ALL SELECT party_id FROM app.collection_payments     WHERE party_id IS NOT NULL
        UNION ALL SELECT party_id FROM app.contact_suppressions    WHERE party_id IS NOT NULL
        UNION ALL SELECT entity_id FROM app.cbs_links              WHERE entity_type = 'party'
    ) z
    JOIN m295_remap r ON r.old_id = z.party_id;
    IF stranded > 0 THEN
        RAISE EXCEPTION '295: % reference(s) still point at a retired party — refusing', stranded;
    END IF;

    -- The whole point: no cluster of one single name may still straddle two parties.
    RAISE NOTICE '295: parties holding customers now %',
      (SELECT COUNT(DISTINCT party_id) FROM app.customers WHERE party_id IS NOT NULL);
END $m295$;

COMMIT;

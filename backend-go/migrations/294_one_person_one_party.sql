-- 294 — One person, one party: stop a hyphen or a reversed name creating a second party.
--
-- THE DEFECT. app.assign_parties() clusters customer records into parties using, among
-- other edges, (normalised name + phone). The normalisation lowercased and squeezed
-- whitespace but did NOT strip punctuation or fix word order, so these were three
-- different keys for one human being:
--
--     'Oyewole Kole-Jones'  vs  'OYEWOLE KOLE JONES'     — a hyphen
--     'Bashir Jambo'        vs  'JAMBO BASHIR'           — surname entered first
--
-- 675 people hold more than one CIF under the same name and phone. 627 of them already
-- clustered correctly; 47 did not, and those 47 carry N24,908,164.23 — including
-- N12,225,480.11 on Oyewole Kole-Jones and N3,086,329.44 on Bashir Jambo, in both cases
-- sitting on one half of the person while the other half reads zero.
--
-- Numbered 294, not 282: other sessions took 282 and then 293 while this was waiting, and
-- three new tables carrying party_id arrived in the meantime. That is not a numbering
-- footnote — those three tables would have made this migration FAIL AT STARTUP, which is
-- an outage. See the completeness guard below, which is there so the next person does not
-- have to notice by luck.
--
-- THE FIX is the nname expression: strip non-alphanumerics, sort the words. It can only
-- ever merge and never split, because making two strings equal cannot make a third pair
-- unequal. MEASURED by dry-running this migration WHOLE against live on 2026-09-24:
-- 20,983 parties holding customers -> 20,878 (105 merged, 0 split), 164 stamped
-- references carried across, and every merge folding ONE retired party into the party
-- that already held that person (no destination takes two sources). Clustering the names
-- alone predicted 113; the 8-party difference is the migration 274 crosswalk correctly
-- PINNING Udara-linked customers to their asserted party. Asserted identity beating
-- inferred is intended — and is why this is dry-run whole rather than approximated.
--
-- PRECISION, checked by name. 'JAMBO BASHIR' folds into 'Bashir Jambo' and 'OYEWOLE KOLE
-- JONES' into 'Oyewole Kole-Jones', while KEHINDE KOLE-JONES and OLUWATIMILEHIN KOLE
-- JONES stay on their own parties. Sorting the words does not collapse a family: the first
-- name is still part of the key.
--
-- WHAT IS NOT DONE, AND WHY. A date-of-birth veto ("refuse to merge when birthdays
-- disagree") was written and tested first. It is wrong for this data. Birthdays here
-- carry day/month transpositions (Florence Morkah 1977-06-10 vs 1977-10-06), sentinel
-- values (1970-01-01, 1980-01-01) and hand-incremented runs (Temitope Olagbegi:
-- 1970-04-11 through -16, one per CIF). The veto split 8 currently-correct parties,
-- among them Olayinka Ogunsola, whose N2,632,447.57 would have been stranded away from
-- the rest of their records. The real protection against a coincidental name match is
-- the existing phone rule — a number shared by more than 3 distinct names is refused for
-- matching — which is what already, correctly, keeps the nine different people on
-- 8095363189 apart.
--
-- Nor does this claim to find every duplicate person. Two 'Bashir Jambo' parties (699 and
-- 7428) remain separate because no phone, email or BVN edge joins them; this migration
-- fixes the punctuation and word-order class only, and can merge but never split.
--
-- RE-POINTING. Merging parties retires the losing party_id, but party_id is stamped at
-- write time onto rows in other tables and those do NOT follow — the same class of bug
-- as migration 273, where re-pointed work was silently reverted within three minutes.
-- So this migration runs the re-clustering itself and then carries every stamped
-- reference onto the surviving party, inside one transaction.

BEGIN;

-- ── Completeness guard ──────────────────────────────────────────────────────
-- The failure mode this migration exists to avoid is a STAMPED party_id that does not
-- follow its party. The list below is only correct for the schema as it stands, and this
-- file has already been overtaken once: customer_lifecycle, customer_messages and
-- party_contact_consent appeared between drafting and applying. So rather than trust the
-- list, assert it — every base table in app that carries a party_id must be named here as
-- either handled or deliberately excluded, and an unknown one stops the migration.
DO $m294$
DECLARE unhandled text;
BEGIN
    SELECT string_agg(c.table_name, ', ' ORDER BY c.table_name) INTO unhandled
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = 'app'
       AND c.column_name  = 'party_id'
       AND t.table_type   = 'BASE TABLE'
       AND c.table_name NOT IN (
             -- re-pointed or merged below
             'activities','call_center_contacts','call_center_leads','collection_assignments',
             'collection_payments','contact_suppressions','crm_contacts','customer_lifecycle',
             'customer_messages','customer_officers','dunning_sends','loan_applications',
             'party_contact_consent','recovery_cases',
             -- re-clustered by assign_parties() itself
             'customers',
             -- the party table; party_id is its own key
             'parties',
             -- a frozen pre-change backup: re-pointing it would destroy its value as one
             'bak_customers_cfile_20260810',
             -- audit history. These record what was done to a party AT THE TIME. Retired
             -- parties are not deleted by this migration, so the rows still resolve; and
             -- rewriting an audit row to name a different party falsifies the record.
             'customer_officer_rekey_audit','party_type_correction_audit');
    IF unhandled IS NOT NULL THEN
        RAISE EXCEPTION '294: table(s) carry party_id but are not handled here: % — add them before merging', unhandled;
    END IF;
END $m294$;

-- Where each customer sits BEFORE the change, so the old -> new map can be derived.
CREATE TEMP TABLE m294_before ON COMMIT DROP AS
SELECT contact_id, party_id FROM app.customers WHERE party_id IS NOT NULL;

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
      -- NAME NORMALISATION (migration 294). Punctuation is stripped and the words are
      -- SORTED, so the same person entered two ways lands on one key:
      --     'Oyewole Kole-Jones'  and 'OYEWOLE KOLE JONES'  -> 'jones kole oyewole'
      --     'Bashir Jambo'        and 'JAMBO BASHIR'        -> 'bashir jambo'
      -- Before this, a hyphen or a surname-first entry created a second party for one
      -- person: 47 customers were split that way, carrying N24,908,164.23.
      --
      -- This can only ever MERGE, never split — stripping and sorting can make two names
      -- equal but never unequal. Verified whole: 105 parties merged, 0 split.
      --
      -- Deliberately NO date-of-birth check. It was tried and it is wrong here: DOB in
      -- this table carries day/month transpositions (1977-06-10 vs 1977-10-06), sentinel
      -- dates (1970-01-01) and hand-incremented runs (1970-04-11,12,13,14,15,16 on one
      -- person). Vetoing on a DOB mismatch split 8 correct parties, including one holding
      -- N2,632,447.57. What guards against a coincidental match is the phone rule below
      -- (a number shared by more than 3 distinct names is refused), not the birthday.
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
$function$;

-- Re-cluster now, inside this transaction, so the remap below sees the result.
SELECT app.assign_parties();

CREATE TEMP TABLE m294_remap ON COMMIT DROP AS
SELECT DISTINCT b.party_id AS old_id, c.party_id AS new_id
  FROM m294_before b
  JOIN app.customers c USING (contact_id)
 WHERE c.party_id IS NOT NULL
   AND b.party_id IS DISTINCT FROM c.party_id;

-- A merge sends every customer of a retired party to ONE survivor. If an old party maps
-- to two new ones something split, which this change is not supposed to be able to do.
DO $m294$
DECLARE ambiguous int; moved int;
BEGIN
    SELECT COUNT(*) INTO ambiguous
      FROM (SELECT old_id FROM m294_remap GROUP BY 1 HAVING COUNT(DISTINCT new_id) > 1) z;
    IF ambiguous > 0 THEN
        RAISE EXCEPTION '294: % party(ies) map to more than one successor — a split, refusing', ambiguous;
    END IF;
    SELECT COUNT(*) INTO moved FROM m294_remap;
    RAISE NOTICE '294: % party reference(s) to re-point', moved;
END $m294$;

UPDATE app.activities             t SET party_id = r.new_id FROM m294_remap r WHERE t.party_id = r.old_id;
UPDATE app.call_center_contacts   t SET party_id = r.new_id FROM m294_remap r WHERE t.party_id = r.old_id;
UPDATE app.call_center_leads      t SET party_id = r.new_id FROM m294_remap r WHERE t.party_id = r.old_id;
UPDATE app.collection_assignments t SET party_id = r.new_id FROM m294_remap r WHERE t.party_id = r.old_id;
UPDATE app.collection_payments    t SET party_id = r.new_id FROM m294_remap r WHERE t.party_id = r.old_id;
UPDATE app.contact_suppressions   t SET party_id = r.new_id FROM m294_remap r WHERE t.party_id = r.old_id;
-- credit_customer_ids and customer_acquisition are VIEWS derived from these tables, so
-- they follow automatically and must not be updated directly.
UPDATE app.crm_contacts           t SET party_id = r.new_id FROM m294_remap r WHERE t.party_id = r.old_id;
UPDATE app.customer_officers      t SET party_id = r.new_id FROM m294_remap r WHERE t.party_id = r.old_id;
UPDATE app.dunning_sends          t SET party_id = r.new_id FROM m294_remap r WHERE t.party_id = r.old_id;
UPDATE app.loan_applications      t SET party_id = r.new_id FROM m294_remap r WHERE t.party_id = r.old_id;
UPDATE app.recovery_cases         t SET party_id = r.new_id FROM m294_remap r WHERE t.party_id = r.old_id;

-- ── Tables whose party_id is UNIQUE: merge, do not re-point ─────────────────
-- These three arrived after this migration was first written (migrations 289 and 290).
-- A plain re-point would violate a unique index and, because migrations run at startup
-- before the server serves traffic, a violation here is an outage rather than a failed
-- step. Each is therefore collapsed onto the survivor first.

-- app.customer_lifecycle is keyed PRIMARY KEY (party_id) — one row per party, and it
-- currently covers every party, so a merge is GUARANTEED to collide. It is wholly
-- DERIVED: compute_customer_lifecycle() does a full recompute and then deletes any row it
-- did not just write. So the retired party's row is simply dropped where the survivor
-- already has one; the next nightly run recomputes the survivor over its now-larger
-- customer set. Hand-merging value_kobo or lifetime_value_kobo here would be inventing a
-- figure the engine owns.
DELETE FROM app.customer_lifecycle cl
 USING m294_remap r
 WHERE cl.party_id = r.old_id
   AND EXISTS (SELECT 1 FROM app.customer_lifecycle s WHERE s.party_id = r.new_id);

UPDATE app.customer_lifecycle t SET party_id = r.new_id
  FROM m294_remap r WHERE t.party_id = r.old_id;

-- app.party_contact_consent is unique on (party_id, channel, purpose). Every party today
-- holds exactly email/servicing/granted and sms/servicing/granted, so in practice both
-- halves of a merged person carry identical grants. But consent is the one thing that
-- must never become MORE permissive by accident: if the retired half carries anything
-- other than a grant, that is a withdrawal and it has to survive the merge. So the
-- restrictive state is copied onto the survivor before the duplicate row is dropped.
UPDATE app.party_contact_consent s
   SET state       = l.state,
       basis       = l.basis,
       evidence    = l.evidence,
       recorded_at = l.recorded_at,
       expires_at  = l.expires_at
  FROM m294_remap r
  JOIN app.party_contact_consent l ON l.party_id = r.old_id
 WHERE s.party_id = r.new_id
   AND s.channel  = l.channel
   AND s.purpose  = l.purpose
   AND l.state IS DISTINCT FROM 'granted'
   AND s.state = 'granted';

DELETE FROM app.party_contact_consent l
 USING m294_remap r
 WHERE l.party_id = r.old_id
   AND EXISTS (SELECT 1 FROM app.party_contact_consent s
                WHERE s.party_id = r.new_id AND s.channel = l.channel AND s.purpose = l.purpose);

UPDATE app.party_contact_consent t SET party_id = r.new_id
  FROM m294_remap r WHERE t.party_id = r.old_id;

-- app.customer_messages is unique on (party_id, journey, day) for live sends. A collision
-- means both halves of one person were sent the same journey on the same day — which is
-- the duplicate send that index exists to prevent — so the retired half's row is dropped.
-- The table is empty today; this is written for the case where it is not.
DELETE FROM app.customer_messages m
 USING m294_remap r
 WHERE m.party_id = r.old_id
   AND m.journey IS NOT NULL
   AND m.state IN ('preview','queued','sent')
   AND EXISTS (SELECT 1 FROM app.customer_messages s
                WHERE s.party_id = r.new_id AND s.journey = m.journey
                  AND s.state IN ('preview','queued','sent')
                  AND (s.created_at AT TIME ZONE 'UTC')::date = (m.created_at AT TIME ZONE 'UTC')::date);

UPDATE app.customer_messages t SET party_id = r.new_id
  FROM m294_remap r WHERE t.party_id = r.old_id;

-- app.cbs_links is the curated Udara crosswalk and is an ASSERTED identity: it must point
-- at a party that still holds customers, or every Udara borrower behind a retired party
-- loses the bridge to their facilities.
UPDATE app.cbs_links t SET entity_id = r.new_id
  FROM m294_remap r WHERE t.entity_type = 'party' AND t.entity_id = r.old_id;

-- Nothing may still point at a party that no longer holds a customer.
DO $m294$
DECLARE stranded int;
BEGIN
    SELECT COUNT(*) INTO stranded FROM (
        SELECT party_id FROM app.recovery_cases                   WHERE party_id IS NOT NULL
        UNION ALL SELECT party_id FROM app.collection_assignments  WHERE party_id IS NOT NULL
        UNION ALL SELECT party_id FROM app.crm_contacts            WHERE party_id IS NOT NULL
        UNION ALL SELECT party_id FROM app.call_center_leads       WHERE party_id IS NOT NULL
        UNION ALL SELECT party_id FROM app.customer_lifecycle      WHERE party_id IS NOT NULL
        UNION ALL SELECT party_id FROM app.party_contact_consent   WHERE party_id IS NOT NULL
        UNION ALL SELECT party_id FROM app.customer_messages       WHERE party_id IS NOT NULL
        UNION ALL SELECT party_id FROM app.activities              WHERE party_id IS NOT NULL
        UNION ALL SELECT party_id FROM app.customer_officers       WHERE party_id IS NOT NULL
        UNION ALL SELECT party_id FROM app.dunning_sends           WHERE party_id IS NOT NULL
        UNION ALL SELECT party_id FROM app.loan_applications       WHERE party_id IS NOT NULL
        UNION ALL SELECT party_id FROM app.collection_payments     WHERE party_id IS NOT NULL
        UNION ALL SELECT party_id FROM app.contact_suppressions    WHERE party_id IS NOT NULL
        UNION ALL SELECT party_id FROM app.call_center_contacts    WHERE party_id IS NOT NULL
        UNION ALL SELECT entity_id FROM app.cbs_links              WHERE entity_type = 'party'
    ) z
    JOIN m294_remap r ON r.old_id = z.party_id;
    IF stranded > 0 THEN
        RAISE EXCEPTION '294: % reference(s) still point at a retired party — refusing', stranded;
    END IF;
    RAISE NOTICE '294: parties now %', (SELECT COUNT(*) FROM app.parties);
END $m294$;

COMMIT;

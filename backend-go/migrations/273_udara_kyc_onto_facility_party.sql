-- 273 — Put every Udara customer's KYC on the same Customer ID as their money.
--
-- THE DEFECT. Every Udara360 customer exists in this database as TWO Customer IDs:
--   * the party app.cbs_links names — carries the facilities, collections, recovery, money
--   * the party app.customers holds their KYC on — carries name, BVN, phone, email, NOK
-- and **0 of 264 agree**. A customer's identity documents are on a different Customer ID
-- from their debt, so nothing that starts from one can see the other.
--
-- Both halves were minted by one import at 2026-09-21 13:13:29 — all 264 KYC parties share
-- that exact timestamp. It created a fresh party per Udara customer instead of resolving
-- the party cbs_links already named, alternating key prefixes for no discernible reason
-- (156 got 'p:U<udara id>', 106 got 'cid:U<udara id>').
--
-- THE REPAIR IS SMALL. The KYC parties hold NOTHING but customer-profile rows: 0
-- collections, 0 recovery, 0 payments, 0 leads, 0 contacts, 0 cbs_links. Measured per
-- side, the link parties carry 52 collection assignments, 40 payments and 7 recovery
-- cases; the KYC parties carry none. So no money moves and no case moves — only
-- app.customers, 279 rows. What moves is the evidence of who owes the money.
--
-- ── THE ONE DETAIL THAT MATTERS ──────────────────────────────────────────────
-- Step 1 repoints BY ROW, on each row's OWN contact_id, NOT by party.
--
-- Two KYC parties each carry TWO different Udara customers, because a director and his
-- company share a BVN and the importer treated the BVN as identity:
--   party 2319516 — JAMES OLUWAFEMI JOSHUA (00000540) + MAJREF LIMITED (00000595)
--   party 2319521 — SALIFU SIAKA ISAAC (00000545) + COSAH ENTERPRISE (00000550)
-- These are already wrongly fused today; this is an existing defect, not just a risk.
-- A migration written as "repoint every row on party X to party Y" would CEMENT the
-- fusion. Keying on the row's own Udara id sends those four rows to four different
-- parties and splits them correctly, for free. A third such pair exists (ESILI EIGBE /
-- ESCAP MANAGEMENT, found on a shared email) and is handled by the same rule.
--
-- ── EVIDENCE, STATED HONESTLY ────────────────────────────────────────────────
-- The binding evidence is an exact identifier match asserted independently by both sides:
-- cbs_links.cbs_customer_id and customers.contact_id ('U' || lpad(udara id,15,'0')), which
-- resolve numerically for 264/264, with **zero contradictions** anywhere in name, BVN,
-- phone or email.
--
-- Attribute corroboration fires on 162 of 264 (BVN 120, phone 123, email 154) — but it is
-- largely CIRCULAR: the KYC row is a verbatim copy of app.cbs_customers (264/264 on name),
-- so both sides descend from the same Udara record and of course agree. Corroboration from
-- a source that did NOT descend from Udara exists for only **7** ids. If the bar is "two
-- genuinely independent systems agree", the answer is 7, not 264. This migration acts on
-- the identifier match, because cbs_links and contact_id are both primary-key assertions
-- about the same Udara row and that is what this schema is meant to be keyed on. The
-- weaker attribute signals are recorded per row in the audit so the basis stays inspectable.
--
-- Name, phone and email alone are NEVER the deciding signal here, and must not be used as
-- one later: one phone (8023011944) sits on 44 parties, one email
-- (apinheiro@o3cards.com — an O3 Cards STAFF address used as a placeholder) on 17, and the
-- placeholder phone 8012345678 sits on 4,113 parties, 19% of the whole table.
--
-- ── DELIBERATELY NOT DONE ────────────────────────────────────────────────────
-- * No party is DELETED. The 262 emptied KYC shells are left in place: deleting is
--   irreversible, they are harmless once empty, and a later cleanup can retire them once
--   this has been observed working. Same for the 13 empty 'p:Z' orphan shells.
-- * cid:Z000000000000001 "UA 457" (party 67062) is NOT touched. It is a REAL cards
--   customer with 3 card_book and 3 accounts rows on cif 00000001, colliding with Udara
--   00000001 (AREMU AYOBAMI) on nothing but the digit 1. Merging those would join a cards
--   customer to an unrelated Udara borrower — the exact failure this whole effort exists
--   to stop. The rule below cannot reach it: it drives off contact_id LIKE 'U%', and that
--   row is keyed on a cif.
-- * app.identity_rekey_audit is append-only evidence of what migration 267 changed and is
--   never rewritten, even though it carries party ids.
--
-- Safe to re-run: every step is a no-op once the rows are already on the right party.
-- Unique constraints: verified that NO unique index in `app` includes party_id, and that
-- 0 of the 262 KYC parties carry a cbs_links row, so nothing can collide.

BEGIN;

CREATE TABLE IF NOT EXISTS app.party_merge_audit (
    id             bigserial PRIMARY KEY,
    step           text        NOT NULL,
    table_name     text        NOT NULL,
    row_key        text,
    udara_id       text,
    old_party_id   bigint,
    new_party_id   bigint,
    customer_name  text,
    evidence       text,
    merged_at      timestamptz NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE app.party_merge_audit IS
    'Before/after record of migration 273, which moved Udara KYC profiles onto the party '
    'that carries the customer''s facilities. Every row records the Udara id that decided '
    'its destination, so the two wrongly-fused company/director parties can be shown to '
    'have been split correctly. Never delete: this is how the merge is reversed.';

-- ── Step 1: the U-keyed KYC rows, each by its OWN Udara id ───────────────────
CREATE TEMP TABLE kyc_move ON COMMIT DROP AS
SELECT c.contact_id,
       right(c.contact_id, 8)              AS udara_id,
       c.party_id                          AS old_party_id,
       lk.entity_id                        AS new_party_id,
       btrim(c.full_name)                  AS customer_name,
       -- Corroboration recorded, never relied on.
       (cc.bvn   IS NOT NULL AND cc.bvn   = c.bvn)   AS bvn_agrees,
       (NULLIF(btrim(cc.email),'') IS NOT NULL
        AND lower(btrim(cc.email)) = lower(btrim(c.email)))  AS email_agrees
  FROM app.customers c
  JOIN app.cbs_links lk ON lk.entity_type = 'party'
                       AND lk.cbs_customer_id = right(c.contact_id, 8)
  LEFT JOIN app.cbs_customers cc ON cc.cbs_customer_id = right(c.contact_id, 8)
 WHERE c.contact_id LIKE 'U%'
   AND c.party_id IS DISTINCT FROM lk.entity_id;

INSERT INTO app.party_merge_audit
    (step, table_name, row_key, udara_id, old_party_id, new_party_id, customer_name, evidence)
SELECT 'kyc_row_by_own_udara_id', 'app.customers', contact_id, udara_id,
       old_party_id, new_party_id, customer_name,
       'exact Udara id asserted by BOTH cbs_links.cbs_customer_id and customers.contact_id'
       || CASE WHEN bvn_agrees   THEN '; BVN agrees'   ELSE '' END
       || CASE WHEN email_agrees THEN '; email agrees' ELSE '' END
  FROM kyc_move;

UPDATE app.customers c
   SET party_id = m.new_party_id
  FROM kyc_move m
 WHERE c.contact_id = m.contact_id;

-- ── Step 2: the party-level map, for UNAMBIGUOUS parties only ────────────────
-- A KYC party that carried two Udara customers is excluded here: step 1 has already sent
-- its U-rows to the right places, and no party-level rule can be correct for it.
CREATE TEMP TABLE party_map ON COMMIT DROP AS
SELECT old_party_id, min(new_party_id) AS new_party_id, min(udara_id) AS udara_id
  FROM kyc_move
 GROUP BY old_party_id
HAVING count(DISTINCT new_party_id) = 1;

-- Other profiles that were sitting on those same KYC parties and belong to the same Udara
-- entity: 13 'Z…' cards-namespace rows and 2 'W…' manual corporate rows. Verified that all
-- 15 sit on a party carrying exactly ONE Udara id, so the party map is safe for them.
INSERT INTO app.party_merge_audit
    (step, table_name, row_key, udara_id, old_party_id, new_party_id, customer_name, evidence)
SELECT 'sibling_profile_on_same_party', 'app.customers', c.contact_id, pm.udara_id,
       c.party_id, pm.new_party_id, btrim(c.full_name),
       'non-U profile left behind on a KYC party that maps to exactly one Udara customer'
  FROM app.customers c
  JOIN party_map pm ON pm.old_party_id = c.party_id
 WHERE c.contact_id NOT LIKE 'U%';

UPDATE app.customers c
   SET party_id = pm.new_party_id
  FROM party_map pm
 WHERE c.party_id = pm.old_party_id
   AND c.contact_id NOT LIKE 'U%';

-- ── Step 3: every other table that references a party ────────────────────────
-- All of these hold ZERO rows on the KYC parties today. They are repointed anyway: this
-- database has several sessions writing to it and the counts can change between the
-- measurement and the deploy. Each is a no-op when empty.
-- app.identity_rekey_audit is deliberately absent — append-only evidence, never rewritten.
DO $$
DECLARE
    t record;
    n bigint;
BEGIN
    FOR t IN
        SELECT * FROM (VALUES
            ('app.crm_contacts',          'party_id'),
            ('app.call_center_contacts',  'party_id'),
            ('app.call_center_leads',     'party_id'),
            ('app.loan_applications',     'party_id'),
            ('app.activities',            'party_id'),
            ('app.collection_assignments','party_id'),
            ('app.collection_payments',   'party_id'),
            ('app.recovery_cases',        'party_id')
        ) AS v(tbl, col)
    LOOP
        IF to_regclass(t.tbl) IS NULL THEN
            RAISE NOTICE '273: % absent — skipped', t.tbl;
            CONTINUE;
        END IF;
        EXECUTE format(
            'UPDATE %s x SET %I = pm.new_party_id FROM party_map pm WHERE x.%I = pm.old_party_id',
            t.tbl, t.col, t.col);
        GET DIAGNOSTICS n = ROW_COUNT;
        IF n > 0 THEN
            RAISE NOTICE '273: repointed % row(s) in %', n, t.tbl;
        END IF;
    END LOOP;
END $$;

-- cbs_links itself: polymorphic, and verified that no KYC party carries one. Guarded so a
-- row appearing between measurement and deploy is still moved rather than orphaned.
UPDATE app.cbs_links lk
   SET entity_id = pm.new_party_id
  FROM party_map pm
 WHERE lk.entity_type = 'party' AND lk.entity_id = pm.old_party_id;

DO $$
DECLARE moved int; siblings int; split int; stranded int;
BEGIN
    SELECT count(*) INTO moved    FROM app.party_merge_audit WHERE step='kyc_row_by_own_udara_id'       AND merged_at >= NOW() - INTERVAL '5 minutes';
    SELECT count(*) INTO siblings FROM app.party_merge_audit WHERE step='sibling_profile_on_same_party' AND merged_at >= NOW() - INTERVAL '5 minutes';
    SELECT count(DISTINCT old_party_id) INTO split
      FROM app.party_merge_audit
     WHERE step='kyc_row_by_own_udara_id' AND merged_at >= NOW() - INTERVAL '5 minutes'
       AND old_party_id IN (SELECT old_party_id FROM app.party_merge_audit
                             WHERE step='kyc_row_by_own_udara_id'
                             GROUP BY old_party_id HAVING count(DISTINCT new_party_id) > 1);
    -- The whole point: no Udara KYC profile may be left on a party other than its own.
    SELECT count(*) INTO stranded
      FROM app.customers c
      JOIN app.cbs_links lk ON lk.entity_type='party' AND lk.cbs_customer_id = right(c.contact_id,8)
     WHERE c.contact_id LIKE 'U%' AND c.party_id IS DISTINCT FROM lk.entity_id;
    IF stranded > 0 THEN
        RAISE EXCEPTION '273: % Udara KYC profiles still on the wrong party — aborting', stranded;
    END IF;
    RAISE NOTICE '273: moved % KYC profiles and % sibling profiles; % fused party/parties split across multiple targets; 0 stranded', moved, siblings, split;
END $$;

COMMIT;

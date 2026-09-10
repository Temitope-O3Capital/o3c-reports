-- 211: cross-source customer dedup + identity cleanup.
--
-- Migration 210 gave every Udara CBS customer its OWN party. But many of them are the
-- SAME person/organization that already exists as a card customer (a party with
-- app.customers rows). This folds those together so a customer has ONE canonical CUST
-- id spanning cards + Udara loans/FDs, and their Udara facilities surface on the right
-- 360. It is deliberately conservative: it merges only unambiguous 1:1 name matches;
-- ambiguous or Udara-only customers keep their own party.

-- A. Repoint the cbs_links crosswalk from the CBS party to the matching card party for
--    every strict 1:1 match: the normalized full_name matches EXACTLY ONE card party AND
--    that card party is matched by EXACTLY ONE CBS party. (Verified 2026-09-08: 46 such
--    pairs, all distinctive names — ASI ENGINEERING LIMITED, FINTRAK, KEMDIO TECHNICAL
--    LIMITED, full personal names.) The old cbs party id is recorded in notes so any
--    bad merge is auditable/reversible.
WITH nrm AS (
  SELECT party_id, party_key,
         upper(regexp_replace(btrim(full_name), '[^A-Za-z0-9 ]', '', 'g')) AS nk
  FROM app.parties
),
cbs AS (
  SELECT party_id AS cbs_party, nk FROM nrm WHERE party_key LIKE 'CBS:%' AND nk <> ''
),
card AS (
  SELECT n.party_id AS card_party, n.nk
  FROM nrm n
  WHERE n.party_key NOT LIKE 'CBS:%'
    AND EXISTS (SELECT 1 FROM app.customers c WHERE c.party_id = n.party_id)
),
card_uni AS (SELECT nk, min(card_party) AS card_party FROM card GROUP BY nk HAVING count(*) = 1),
cbs_uni  AS (SELECT nk, min(cbs_party)  AS cbs_party  FROM cbs  GROUP BY nk HAVING count(*) = 1),
pairs AS (
  SELECT cu.cbs_party, cru.card_party
  FROM cbs_uni cu JOIN card_uni cru ON cru.nk = cu.nk
)
UPDATE app.cbs_links k
   SET entity_id = p.card_party,
       notes = COALESCE(NULLIF(k.notes,'') || ' | ', '')
             || 'merged CBS party ' || p.cbs_party || ' -> card party ' || p.card_party
             || ' (1:1 name-match dedup, migration 211)'
  FROM pairs p
 WHERE k.entity_type = 'party' AND k.entity_id = p.cbs_party;

-- Drop the CBS parties that were merged: their crosswalk now points at the card party,
-- so no cbs_links row references them any more. Guarded against deleting any party that
-- has card rows (CBS parties never do, but be safe).
DELETE FROM app.parties p
 WHERE p.party_key LIKE 'CBS:%'
   AND NOT EXISTS (SELECT 1 FROM app.cbs_links k WHERE k.entity_type='party' AND k.entity_id = p.party_id)
   AND NOT EXISTS (SELECT 1 FROM app.customers c WHERE c.party_id = p.party_id);

-- B. Reclassify the surviving Udara-only parties that are clearly organizations but were
--    tagged 'person' because migration 210's keyword list missed them (e.g. FINTRAK,
--    trading names). Best-effort; individuals are unaffected.
UPDATE app.parties SET party_type = 'organization'
 WHERE party_key LIKE 'CBS:%' AND party_type = 'person'
   AND full_name ~* '(FINTRAK|EDUSHINE|NIGERIA|\mNIG\M|INVESTMENT|CAPITAL|MICROFINANCE|\mBANK\M|INSURANCE|PROPERT|CONSULT|LOGISTIC|ENERGY|\mOIL\M|\mGAS\M|CONSTRUCTION|MOTORS|\mAUTO\M|PHARMAC|MEDICAL|HOSPITAL|\mFOODS\M|BAKERY|TEXTILE|FASHION|MEDIA|\mPRINT\M|SECURITY|TRAVEL|LOUNGE|RESTAURANT|CATERING|ACADEMY|COLLEGE|MOSQUE|FOUNDATION|\mTRUST\M|COOPERATIVE|SOCIETY|CONCEPT|BAZAR|GARDEN)';

-- C. Null out clearly-junk BVNs on the customer master: non-numeric placeholders like
--    'NA'/'N/A'/'NIL' and Excel scientific-notation ('2.22E+11'), plus all-zero
--    sentinels. Deliberately conservative — numeric values of the "wrong" length are
--    KEPT (they may be recoverable), and valid 11-digit BVNs are untouched. This is what
--    caused the dirty-BVN noise on same-person CIFs; it does not affect party grouping.
UPDATE app.customers SET bvn = NULL
 WHERE bvn IS NOT NULL
   AND (btrim(bvn) !~ '^[0-9]+$' OR btrim(bvn) ~ '^0+$');

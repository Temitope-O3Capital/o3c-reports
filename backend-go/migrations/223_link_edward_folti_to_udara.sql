-- Udara is authoritative: link the last two loan customers whose core-banking record
-- was sitting under a separate party.
--
-- Migrations 210/211 built the party crosswalk (app.cbs_links: party -> Udara customer)
-- and deduped CBS parties into their card/workspace twins by exact name. Nine of the
-- Loan Repayment CRM borrowers merged cleanly that way — ASI ENGINEERING, FINTRAK,
-- HYCUBE, NASSCOOP, THIERRY, G3 GARDEN, HENGOOB, EDUSHINE, OLAHAN ABIDEMI.
--
-- Two missed, on a singular/plural spelling only:
--
--   workspace party 708783  EDWARD COSMETICS    <->  Udara 00000556  EDWARDS COSMETICS   (party 763258)
--   workspace party 708787  FOLTI TECHNOLOGY    <->  Udara 00000553  FOLTI TECHNOLOGIES  (party 763180)
--
-- These are the two the collections team flagged as showing multiple loans. With the
-- link in place their Udara facility resolves to the same customer as the uploaded
-- sheet row, so the Credit Portfolio can suppress the spreadsheet mirror and show the
-- core-banking record alone.
--
-- The match is 1:1 and by exact company identity, not fuzzy: each name resolves to
-- exactly one party on each side, and each Udara customer id has exactly one loan set.
-- Guarded so re-running is a no-op, and so it cannot fire if the data has since changed.

-- Re-point the crosswalk from the Udara-only party to the workspace party that already
-- carries the customer's collections history.
UPDATE app.cbs_links k
   SET entity_id = v.keep_party,
       notes     = COALESCE(k.notes,'') || ' | re-pointed to workspace party ' || v.keep_party
                   || ' (singular/plural name variant, migration 223)'
  FROM (VALUES
        ('00000556'::text, 763258::bigint, 708783::bigint),
        ('00000553'::text, 763180::bigint, 708787::bigint)
       ) AS v(cbs_id, old_party, keep_party)
 WHERE k.entity_type = 'party'
   AND k.cbs_customer_id = v.cbs_id
   AND k.entity_id = v.old_party
   -- Only if both parties still look like the pair verified above.
   AND EXISTS (SELECT 1 FROM app.parties p WHERE p.party_id = v.keep_party)
   AND EXISTS (SELECT 1 FROM app.parties p WHERE p.party_id = v.old_party);

-- Move any customer rows off the retired Udara-only party so nothing is orphaned.
UPDATE app.customers c
   SET party_id = v.keep_party
  FROM (VALUES (763258::bigint, 708783::bigint), (763180::bigint, 708787::bigint))
       AS v(old_party, keep_party)
 WHERE c.party_id = v.old_party;

-- Fold the Udara-only party's card count into the survivor, then retire it.
UPDATE app.parties p
   SET card_count = (SELECT COUNT(*) FROM app.customers c WHERE c.party_id = p.party_id)
 WHERE p.party_id IN (708783, 708787, 763258, 763180);

DELETE FROM app.parties p
 WHERE p.party_id IN (763258, 763180)
   AND NOT EXISTS (SELECT 1 FROM app.customers c WHERE c.party_id = p.party_id)
   AND NOT EXISTS (SELECT 1 FROM app.cbs_links k WHERE k.entity_id = p.party_id);

-- Canonical customer identity, cleanly.
--
-- app.parties IS the customer (person/organization); the canonical id is CUST-<party_id>
-- (already generated as fmt.Sprintf("CUST-%06d", party_id) in contacts.go / customer360.go).
-- CIF is a CARD identifier and cbs_customer_id is a Udara identifier — BOTH hang UNDER a
-- party. The bug: Udara loan/FD customers were never in the party layer, so they had no
-- party → no CUST, and the code fell back to matching cbs_customer_id == app.customers.cif,
-- which collides (Udara 00000424 = FINTRAK vs card CIF 00000424 = someone else).
--
-- This migration is additive + idempotent: it gives every Udara CBS customer a party (so
-- they get a real CUST), links them via the curated cbs_links crosswalk, and maps Udara's
-- surname-first account-officer names to workspace users. No existing rows are altered and
-- no consumer reads these yet (wiring is a separate step), so it is safe to apply.

-- 1. One party per distinct Udara CBS customer (loans + FDs), named from Udara's OWN
--    record. Company-looking names → 'organization'. Idempotent via party_key 'CBS:<id>'.
INSERT INTO app.parties (party_key, party_type, full_name, card_count, created_at)
SELECT 'CBS:' || s.cbs_customer_id,
       CASE WHEN s.nm ~* '(LTD|LIMITED|LLC| PLC|ENTERPRISE|VENTURE|SOCIETY|COOP|COMPANY|RESOURCE|SERVICE|TECHNOLOG|GLOBAL|HOTEL|AGRIC|INITIO|MULTILINK|SOFTWARE|SCHOOL|CHURCH|MINISTR|FARM|STORE|GROUP|ASSOCIATION|UNION|CONCEPT|INTEGRATED|HOLDING)'
            THEN 'organization' ELSE 'person' END,
       s.nm, 0, NOW()
FROM (
  -- One row PER customer id (a customer with both a loan and an FD, or differing names,
  -- must not yield two rows with the same 'CBS:<id>' party_key).
  SELECT cbs_customer_id, MAX(nm) AS nm FROM (
    SELECT cbs_customer_id, raw->>'name' AS nm FROM cbs_loans          WHERE NULLIF(cbs_customer_id,'') IS NOT NULL
    UNION ALL
    SELECT cbs_customer_id, raw->>'name'       FROM cbs_fixed_deposits WHERE NULLIF(cbs_customer_id,'') IS NOT NULL
  ) u GROUP BY cbs_customer_id
) s
WHERE NOT EXISTS (SELECT 1 FROM app.parties p WHERE p.party_key = 'CBS:' || s.cbs_customer_id);

-- 2. Link each Udara CBS customer id to its party (populate the curated crosswalk that
--    was designed for exactly this and had been left empty).
-- cbs_account_number is NOT NULL and (entity_type, entity_id) is unique. This is a
-- CUSTOMER-level link (party ↔ cbs_customer_id), so account is blank; one row per party.
INSERT INTO app.cbs_links (entity_type, entity_id, cbs_account_number, cbs_customer_id, linked_at, notes)
SELECT 'party', p.party_id, '', substr(p.party_key, 5), NOW(), 'auto: Udara CBS customer -> party (migration 210)'
FROM app.parties p
WHERE p.party_key LIKE 'CBS:%'
ON CONFLICT (entity_type, entity_id) DO NOTHING;

-- 3. Officer map: Udara accountOfficerName is surname-first ("Pinheiro Abimbola"); the
--    workspace o3c_users are given-first ("Abimbola Pinheiro"). Map by reversing the two
--    tokens (verified: matched every Udara officer). officer_user_id stays NULL if no match.
CREATE TABLE IF NOT EXISTS app.cbs_officer_map (
  udara_name      TEXT PRIMARY KEY,
  officer_user_id BIGINT REFERENCES o3c_users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO app.cbs_officer_map (udara_name, officer_user_id)
SELECT o.nm,
       (SELECT u.id FROM o3c_users u
         WHERE lower(regexp_replace(u.full_name, '\s+', ' ', 'g'))
             = lower(trim(split_part(o.nm,' ',2) || ' ' || split_part(o.nm,' ',1)))
         LIMIT 1)
FROM (
  SELECT DISTINCT raw->>'accountOfficerName' AS nm FROM cbs_loans          WHERE NULLIF(raw->>'accountOfficerName','') IS NOT NULL
  UNION
  SELECT DISTINCT raw->>'accountOfficerName'       FROM cbs_fixed_deposits WHERE NULLIF(raw->>'accountOfficerName','') IS NOT NULL
) o
ON CONFLICT (udara_name) DO NOTHING;

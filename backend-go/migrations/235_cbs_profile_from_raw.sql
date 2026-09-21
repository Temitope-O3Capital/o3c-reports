-- Promote three attributes out of cbs_customers.raw into real columns.
--
-- The Udara sync stores the whole API payload in `raw` (jsonb) and copies a
-- chosen subset into columns. Three attributes never got a column and are
-- therefore invisible to every query, view, export and UI in the platform —
-- reachable only by someone who thinks to dig into the jsonb by hand:
--
--   religion   104 of 292 rows populated. The ONLY religion data anywhere in
--              o3_workspace. Sensitive: see the note below.
--   hometown   104 of 292. The closest thing the platform has to a
--              state-of-origin, and the Production_ED column that would have
--              carried it (State_OfOrigin) is 100% empty at source, so this is
--              the only route to it.
--   nokGender   82 of 292. Next-of-kin gender.
--
-- Counts are from the 2026-09-12 dump.
--
-- Populated here from `raw` rather than waiting for the next sync: the sync only
-- runs against live Udara, and these 292 rows already hold the values.
ALTER TABLE app.cbs_customers
  ADD COLUMN IF NOT EXISTS religion   text,
  ADD COLUMN IF NOT EXISTS hometown   text,
  ADD COLUMN IF NOT EXISTS nok_gender text;

UPDATE app.cbs_customers
   SET religion   = COALESCE(religion,   NULLIF(btrim(raw->>'religion'), '')),
       hometown   = COALESCE(hometown,   NULLIF(btrim(raw->>'hometown'), '')),
       nok_gender = COALESCE(nok_gender, NULLIF(btrim(raw->>'nokGender'), ''))
 WHERE raw IS NOT NULL
   AND (religion IS NULL OR hometown IS NULL OR nok_gender IS NULL);

-- ── The city mismapping ────────────────────────────────────────────────────
--
-- cbssync writes Udara's `hometown` into the `city` column (sync.go passes
-- gstr(m, "hometown") in city's position, and migration 226 even documents it
-- with an inline "-- hometown" comment). So cbs_customers.city does not mean
-- "city of residence" for any of these rows — it means place of origin, and
-- enrichCustomersFromCBS copies it into app.customers.city, where it silently
-- becomes a residence value.
--
-- This migration only ADDS the correct column and leaves `city` untouched: the
-- values are not wrong data, they are correctly-valued and wrongly-named, and
-- nulling a populated column that a sync will refill is not something to do
-- inside a boot-time migration. The sync is being changed to stop writing
-- hometown into city; clearing the 106 mislabelled city values (and re-checking
-- what enrichCustomersFromCBS has already propagated into app.customers) is a
-- deliberate, separate cleanup.
COMMENT ON COLUMN app.cbs_customers.city IS
  'CAUTION: historically populated from Udara''s hometown, not a city of residence — see migration 235. Use hometown for place of origin.';

COMMENT ON COLUMN app.cbs_customers.hometown IS
  'Place of origin from Udara (raw->>''hometown''). The platform has no other state-of-origin data: Production_ED.State_OfOrigin is 100% empty at source.';
COMMENT ON COLUMN app.cbs_customers.nok_gender IS
  'Next-of-kin gender from Udara (raw->>''nokGender'').';

-- Religion is special-category personal data under the NDPA. It is recorded here
-- because Udara already collects and returns it, and burying it in jsonb does not
-- make it less present — it makes it unauditable. It must never be used as, or
-- as a proxy for, a credit-decision input, and it should not be added to a
-- customer-facing or bulk export without a lawful basis.
COMMENT ON COLUMN app.cbs_customers.religion IS
  'Special-category personal data (NDPA). Sourced from Udara raw->>''religion''. Never an input to a credit decision; do not add to bulk exports without a lawful basis.';

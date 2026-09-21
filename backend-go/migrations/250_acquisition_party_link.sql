-- 240: connect the ACQUISITION layer (leads / call-centre / sales / applications) to
-- the canonical person model (app.parties), which it had never referenced.
--
-- Investigation 2026-09-14: crm_contacts, call_center_leads, call_center_contacts and
-- loan_applications carried NO party_id. A lead resolved to the canonical person only by
-- a CIF *string* or phone match at read time, so ~94% of leads never reached the party
-- graph and every join re-introduced the CIF-as-person hazard the party model was built
-- to kill. This migration gives each of those tables a real party_id FK, backfills it by
-- SAFE rules only, and auto-stamps it on new rows so the link is durable from creation.
--
-- SAFE resolution rules (never fabricate identity):
--   1. CIF string already on the row -> app.customers.cif -> that customer's party_id.
--      (A CIF is a card id under a party; customers.party_id is 100% populated.)
--   2. Else exact phone match to EXACTLY ONE party (app.norm_phone, last-10-digit). If a
--      phone maps to 0 or >1 parties it is left NULL — a shared/ambiguous number must not
--      fuse people (the same guard used for card clustering and cbs linking).
-- No new party is minted here: an un-resolvable prospect stays party_id NULL rather than
-- inflating app.parties with 25k unconverted numbers. Everything is additive + idempotent.

-- ── 1. Columns + FKs (nullable, ON DELETE SET NULL — a party delete must not delete leads)
ALTER TABLE crm_contacts        ADD COLUMN IF NOT EXISTS party_id bigint;
ALTER TABLE call_center_leads   ADD COLUMN IF NOT EXISTS party_id bigint;
ALTER TABLE call_center_contacts ADD COLUMN IF NOT EXISTS party_id bigint;
ALTER TABLE loan_applications   ADD COLUMN IF NOT EXISTS party_id bigint;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='crm_contacts_party_id_fkey') THEN
    ALTER TABLE crm_contacts ADD CONSTRAINT crm_contacts_party_id_fkey
      FOREIGN KEY (party_id) REFERENCES app.parties(party_id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='call_center_leads_party_id_fkey') THEN
    ALTER TABLE call_center_leads ADD CONSTRAINT call_center_leads_party_id_fkey
      FOREIGN KEY (party_id) REFERENCES app.parties(party_id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='call_center_contacts_party_id_fkey') THEN
    ALTER TABLE call_center_contacts ADD CONSTRAINT call_center_contacts_party_id_fkey
      FOREIGN KEY (party_id) REFERENCES app.parties(party_id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='loan_applications_party_id_fkey') THEN
    ALTER TABLE loan_applications ADD CONSTRAINT loan_applications_party_id_fkey
      FOREIGN KEY (party_id) REFERENCES app.parties(party_id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_crm_contacts_party        ON crm_contacts (party_id)         WHERE party_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cc_leads_party            ON call_center_leads (party_id)    WHERE party_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cc_contacts_party         ON call_center_contacts (party_id) WHERE party_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_loan_applications_party   ON loan_applications (party_id)     WHERE party_id IS NOT NULL;

-- ── 2. Shared helpers: CIF-string -> party, and unique-phone -> party ──────────────
-- party_for_cif: the party that owns a given card CIF (NULL if unknown).
CREATE OR REPLACE FUNCTION app.party_for_cif(p_cif text) RETURNS bigint AS $$
  SELECT c.party_id FROM app.customers c
   WHERE c.cif = NULLIF(btrim(p_cif),'') AND c.party_id IS NOT NULL
   LIMIT 1;
$$ LANGUAGE sql STABLE;

-- party_for_phone: the party for a phone ONLY when exactly one party owns it (else NULL).
-- Matches against BOTH the fresh card-feed phone (app.customers.phone → its party) and the
-- party's own primary_phone (covers CBS/Udara parties not in the card book). The two are
-- unioned and the result is used only when it points at a single party — a shared/family
-- number (count > 1) resolves to NULL, never fusing people. Uses the functional indexes
-- below, so single-row inserts resolve in a couple of lookups.
CREATE OR REPLACE FUNCTION app.party_for_phone(p_phone text) RETURNS bigint AS $$
  WITH n AS (SELECT NULLIF(app.norm_phone(p_phone),'') AS ph),
  m AS (
    SELECT DISTINCT c.party_id FROM app.customers c, n
      WHERE n.ph IS NOT NULL AND c.party_id IS NOT NULL AND app.norm_phone(c.phone) = n.ph
    UNION
    SELECT DISTINCT p.party_id FROM app.parties p, n
      WHERE n.ph IS NOT NULL AND app.norm_phone(p.primary_phone) = n.ph
  )
  SELECT party_id FROM m WHERE (SELECT count(*) FROM m) = 1 LIMIT 1;
$$ LANGUAGE sql STABLE;

-- Functional indexes on the normalised phones so party_for_phone and the phone backfill are
-- index scans, not full-table norm_phone() sweeps (norm_phone is IMMUTABLE, so indexable).
CREATE INDEX IF NOT EXISTS idx_parties_norm_phone   ON app.parties  (app.norm_phone(primary_phone));
CREATE INDEX IF NOT EXISTS idx_customers_norm_phone ON app.customers (app.norm_phone(phone));

-- ── 3. Backfill existing rows — SET-BASED (build the phone->party map ONCE, then join;
--       never a per-row correlated lookup over 21k parties). CIF pass first, phone second.
CREATE OR REPLACE FUNCTION app.resolve_acquisition_parties() RETURNS integer AS $func$
DECLARE touched integer := 0; n integer;
BEGIN
  -- Unique-phone -> party map from BOTH the fresh card-feed phone and party primary_phone;
  -- only phones owned by exactly one party survive (shared/family numbers are dropped).
  CREATE TEMP TABLE _pm ON COMMIT DROP AS
  WITH src AS (
    SELECT app.norm_phone(phone) AS ph, party_id FROM app.customers WHERE party_id IS NOT NULL
    UNION ALL
    SELECT app.norm_phone(primary_phone), party_id FROM app.parties
  )
  SELECT ph, min(party_id) AS pid FROM src
   WHERE ph <> '' GROUP BY ph HAVING count(DISTINCT party_id) = 1;
  CREATE UNIQUE INDEX ON _pm (ph);

  -- crm_contacts — CIF pass (any of its three CIF strings), then unique-phone pass.
  UPDATE crm_contacts c SET party_id = cu.party_id
    FROM app.customers cu
   WHERE c.party_id IS NULL AND cu.party_id IS NOT NULL
     AND cu.cif = COALESCE(NULLIF(btrim(c.converted_cif),''), NULLIF(btrim(c.cif_number),''), NULLIF(btrim(c.matched_customer_cif),''));
  GET DIAGNOSTICS n = ROW_COUNT; touched := touched + n;
  UPDATE crm_contacts c SET party_id = pm.pid
    FROM _pm pm WHERE c.party_id IS NULL AND app.norm_phone(c.phone) = pm.ph;
  GET DIAGNOSTICS n = ROW_COUNT; touched := touched + n;

  -- call_center_leads — CIF (customer_cif) then phone (customer_phone).
  UPDATE call_center_leads l SET party_id = cu.party_id
    FROM app.customers cu
   WHERE l.party_id IS NULL AND cu.party_id IS NOT NULL AND cu.cif = NULLIF(btrim(l.customer_cif),'');
  GET DIAGNOSTICS n = ROW_COUNT; touched := touched + n;
  UPDATE call_center_leads l SET party_id = pm.pid
    FROM _pm pm WHERE l.party_id IS NULL AND app.norm_phone(l.customer_phone) = pm.ph;
  GET DIAGNOSTICS n = ROW_COUNT; touched := touched + n;

  -- call_center_contacts — phone only.
  UPDATE call_center_contacts cc SET party_id = pm.pid
    FROM _pm pm WHERE cc.party_id IS NULL AND app.norm_phone(cc.phone) = pm.ph;
  GET DIAGNOSTICS n = ROW_COUNT; touched := touched + n;

  -- loan_applications — CIF (cif/applicant_cif) then phone (phone/applicant_phone).
  UPDATE loan_applications a SET party_id = cu.party_id
    FROM app.customers cu
   WHERE a.party_id IS NULL AND cu.party_id IS NOT NULL
     AND cu.cif = COALESCE(NULLIF(btrim(a.cif),''), NULLIF(btrim(a.applicant_cif),''));
  GET DIAGNOSTICS n = ROW_COUNT; touched := touched + n;
  UPDATE loan_applications a SET party_id = pm.pid
    FROM _pm pm WHERE a.party_id IS NULL
     AND COALESCE(NULLIF(app.norm_phone(a.phone),''), app.norm_phone(a.applicant_phone)) = pm.ph;
  GET DIAGNOSTICS n = ROW_COUNT; touched := touched + n;

  RETURN touched;
END; $func$ LANGUAGE plpgsql;

SELECT app.resolve_acquisition_parties();

-- ── 4. Auto-stamp party_id on new rows (BEFORE INSERT), so the link is durable from
--       creation and no future lead is born detached. Only fills when the row itself
--       carries a resolvable CIF/phone; never overrides an explicit party_id.
CREATE OR REPLACE FUNCTION app.stamp_crm_contact_party() RETURNS trigger AS $$
BEGIN
  IF NEW.party_id IS NULL THEN
    NEW.party_id := COALESCE(app.party_for_cif(NEW.converted_cif), app.party_for_cif(NEW.cif_number),
                             app.party_for_cif(NEW.matched_customer_cif), app.party_for_phone(NEW.phone));
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION app.stamp_cc_lead_party() RETURNS trigger AS $$
BEGIN
  IF NEW.party_id IS NULL THEN
    NEW.party_id := COALESCE(app.party_for_cif(NEW.customer_cif), app.party_for_phone(NEW.customer_phone));
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION app.stamp_cc_contact_party() RETURNS trigger AS $$
BEGIN
  IF NEW.party_id IS NULL THEN NEW.party_id := app.party_for_phone(NEW.phone); END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION app.stamp_loan_app_party() RETURNS trigger AS $$
BEGIN
  IF NEW.party_id IS NULL THEN
    NEW.party_id := COALESCE(app.party_for_cif(NEW.cif), app.party_for_cif(NEW.applicant_cif),
                             app.party_for_phone(NEW.phone), app.party_for_phone(NEW.applicant_phone));
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_stamp_crm_contact_party  ON crm_contacts;
DROP TRIGGER IF EXISTS trg_stamp_cc_lead_party      ON call_center_leads;
DROP TRIGGER IF EXISTS trg_stamp_cc_contact_party   ON call_center_contacts;
DROP TRIGGER IF EXISTS trg_stamp_loan_app_party     ON loan_applications;

CREATE TRIGGER trg_stamp_crm_contact_party BEFORE INSERT ON crm_contacts
  FOR EACH ROW EXECUTE FUNCTION app.stamp_crm_contact_party();
CREATE TRIGGER trg_stamp_cc_lead_party BEFORE INSERT ON call_center_leads
  FOR EACH ROW EXECUTE FUNCTION app.stamp_cc_lead_party();
CREATE TRIGGER trg_stamp_cc_contact_party BEFORE INSERT ON call_center_contacts
  FOR EACH ROW EXECUTE FUNCTION app.stamp_cc_contact_party();
CREATE TRIGGER trg_stamp_loan_app_party BEFORE INSERT ON loan_applications
  FOR EACH ROW EXECUTE FUNCTION app.stamp_loan_app_party();

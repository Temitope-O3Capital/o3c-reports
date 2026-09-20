-- 231_activities_party.sql
--
-- Make the CUSTOMER (party) the first-class anchor of the activity stream.
--
-- A CIF identifies a CARD, and one person (app.parties.party_id) holds many CIFs — the
-- data shows one party with 21 CIFs. Anchoring activity only on CIF/phone/contact means a
-- person's activity is scattered across their cards and only reassembled by Customer 360's
-- read-time party resolution. This adds party_id as the durable person key so activity
-- follows the CUSTOMER, not the card, and "all activity for this customer" is one query.
--
-- Resolution is centralised in a BEFORE INSERT trigger on app.activities: whatever anchors
-- a row carries (cif / contact / application / phone), party_id is stamped from them. Every
-- insert path — Go LogActivity, the capture triggers, the manual endpoint, this backfill —
-- gets it for free, in one place.
--
-- It also fixes a phone-normalisation inconsistency: activities.phone must be the last-10
-- `norm_phone` form (what Go's normalizePhone stores and what Customer 360 matches on). The
-- crm_lead capture trigger (mig 230) wrongly used `normalise_ng_phone` (0 + last-10); this
-- corrects both the trigger and the rows it already wrote.

ALTER TABLE app.activities ADD COLUMN IF NOT EXISTS party_id BIGINT;
CREATE INDEX IF NOT EXISTS idx_activities_party ON app.activities (party_id) WHERE party_id IS NOT NULL;

-- Standardise stored phones to the last-10 form so the phone anchor actually matches.
UPDATE app.activities SET phone = app.norm_phone(phone)
 WHERE phone IS NOT NULL AND phone <> '' AND phone <> app.norm_phone(phone);

-- Recreate the crm_lead capture trigger fn using norm_phone (was normalise_ng_phone).
CREATE OR REPLACE FUNCTION app.activities_from_crm_lead_event() RETURNS trigger AS $$
DECLARE
  is_forward boolean := NEW.event ILIKE '%forward%';
BEGIN
  INSERT INTO app.activities
    (contact_id, cif, phone, actor_user_id, actor_team, type, target_team, status, subject, body, occurred_at, source, entity_type, entity_id)
  VALUES (
    NEW.contact_id,
    (SELECT COALESCE(NULLIF(converted_cif,''), NULLIF(cif_number,'')) FROM app.crm_contacts WHERE id = NEW.contact_id),
    (SELECT NULLIF(app.norm_phone(phone),'') FROM app.crm_contacts WHERE id = NEW.contact_id),
    NEW.created_by,
    CASE WHEN is_forward THEN 'call_center' ELSE 'sales' END,
    CASE WHEN is_forward THEN 'handoff' ELSE 'stage_change' END,
    CASE WHEN is_forward OR NEW.event ILIKE '%sales%' THEN 'sales' ELSE NULL END,
    CASE WHEN is_forward THEN 'open' ELSE NULL END,
    initcap(replace(NEW.event,'_',' ')),
    NULLIF(NEW.note,''), NEW.created_at, 'crm_lead', 'crm_contact', NEW.contact_id::text);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- The party resolver: fills party_id from the row's anchors, best/most-exact first.
CREATE OR REPLACE FUNCTION app.activity_resolve_party() RETURNS trigger AS $$
BEGIN
  IF NEW.party_id IS NULL THEN
    SELECT cand.party_id INTO NEW.party_id FROM (
      SELECT c.party_id, 1 AS pri FROM app.customers c
        WHERE NEW.cif IS NOT NULL AND NEW.cif <> '' AND c.cif = NEW.cif AND c.party_id IS NOT NULL
      UNION ALL
      SELECT c.party_id, 2 FROM app.crm_contacts cc
        JOIN app.customers c ON c.cif IN (NULLIF(cc.converted_cif,''), NULLIF(cc.cif_number,''))
        WHERE NEW.contact_id IS NOT NULL AND cc.id = NEW.contact_id AND c.party_id IS NOT NULL
      UNION ALL
      SELECT c.party_id, 3 FROM app.loan_applications la
        JOIN app.customers c ON c.cif = la.applicant_cif
        WHERE NEW.application_id IS NOT NULL AND la.id = NEW.application_id AND c.party_id IS NOT NULL
      UNION ALL
      SELECT c.party_id, 4 FROM app.customers c
        WHERE NEW.phone IS NOT NULL AND NEW.phone <> '' AND app.norm_phone(c.phone) = NEW.phone AND c.party_id IS NOT NULL
    ) cand ORDER BY cand.pri LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_activity_resolve_party ON app.activities;
CREATE TRIGGER trg_activity_resolve_party
  BEFORE INSERT ON app.activities
  FOR EACH ROW EXECUTE FUNCTION app.activity_resolve_party();

-- Backfill party_id for existing rows using the same resolution.
UPDATE app.activities a SET party_id = (
  SELECT cand.party_id FROM (
    SELECT c.party_id, 1 AS pri FROM app.customers c
      WHERE a.cif IS NOT NULL AND a.cif <> '' AND c.cif = a.cif AND c.party_id IS NOT NULL
    UNION ALL
    SELECT c.party_id, 2 FROM app.crm_contacts cc
      JOIN app.customers c ON c.cif IN (NULLIF(cc.converted_cif,''), NULLIF(cc.cif_number,''))
      WHERE a.contact_id IS NOT NULL AND cc.id = a.contact_id AND c.party_id IS NOT NULL
    UNION ALL
    SELECT c.party_id, 3 FROM app.loan_applications la
      JOIN app.customers c ON c.cif = la.applicant_cif
      WHERE a.application_id IS NOT NULL AND la.id = a.application_id AND c.party_id IS NOT NULL
    UNION ALL
    SELECT c.party_id, 4 FROM app.customers c
      WHERE a.phone IS NOT NULL AND a.phone <> '' AND app.norm_phone(c.phone) = a.phone AND c.party_id IS NOT NULL
  ) cand ORDER BY cand.pri LIMIT 1)
WHERE a.party_id IS NULL;

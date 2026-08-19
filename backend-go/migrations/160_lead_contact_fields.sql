-- 160_lead_contact_fields.sql
--
-- Makes call_center_leads carry what a LEAD actually has.
--
-- The table was modelled on a customer: customer_cif and employer, both of which
-- a cold lead does not have. The upload template asked for them, so every import
-- either left them blank or invited whoever prepared the file to invent a CIF —
-- and a CIF is the identity key for the card book, which a lead has no business
-- holding until they convert.
--
-- What a lead does have is a way to reach them: a phone number (the only thing
-- genuinely required, since the whole point is to call), and optionally a name,
-- an email and an address.
--
-- customer_cif and employer are LEFT IN PLACE rather than dropped: a lead that
-- converts gets a CIF written back, and existing rows carry employer data from
-- earlier imports. They are simply no longer part of the upload.
--
-- Idempotent: safe to re-run.

ALTER TABLE app.call_center_leads
  ADD COLUMN IF NOT EXISTS email   text,
  ADD COLUMN IF NOT EXISTS address text;

COMMENT ON COLUMN app.call_center_leads.customer_cif IS
  'Set when a lead converts to a customer. Never collected at upload — a lead has no CIF.';

-- Phone is the one field a lead cannot be worked without, and it must be stored
-- in one shape. The book already holds a mix of 0803…, +234803…, 234803… and bare
-- 803…, which is why every lookup has to normalise on the fly.
--
-- Canonical form is the Nigerian national format: 0 + the last 10 digits.
CREATE OR REPLACE FUNCTION app.normalise_ng_phone(p_raw text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    -- Not enough digits to be a phone number: keep whatever was given so the row
    -- is still visibly wrong rather than silently blanked.
    WHEN length(regexp_replace(COALESCE(p_raw, ''), '\D', '', 'g')) < 10
      THEN NULLIF(TRIM(COALESCE(p_raw, '')), '')
    ELSE '0' || right(regexp_replace(p_raw, '\D', '', 'g'), 10)
  END
$$;

COMMENT ON FUNCTION app.normalise_ng_phone(text) IS
  'Canonical Nigerian phone: 0 + last 10 digits. 08012345678, +2348012345678, '
  '234 801 234 5678 and 8012345678 all collapse to 08012345678.';

-- Normalise what is already there, so the dedupe index below can be trusted.
UPDATE app.call_center_leads
   SET customer_phone = app.normalise_ng_phone(customer_phone)
 WHERE customer_phone IS NOT NULL
   AND customer_phone <> app.normalise_ng_phone(customer_phone);

-- The importer dedupes on the last 10 digits; index that so a large upload does
-- not become a sequential scan per row.
CREATE INDEX IF NOT EXISTS idx_call_center_leads_phone10
  ON app.call_center_leads (right(regexp_replace(COALESCE(customer_phone, ''), '\D', '', 'g'), 10));

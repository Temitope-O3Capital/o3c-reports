-- 253: give every QUALIFIED lead a canonical party — the balanced answer to "should a lead
-- become a party?".
--
-- Not at import: ~8k of the 13k call-centre leads are cold no-answer dials; minting a party
-- per imported number would nearly double app.parties with non-customers and skew every
-- count. Not never: a person who has expressed interest and entered the sales pipeline
-- deserves one durable identity that their activities and pipeline anchor on. So the line is
-- QUALIFICATION — the same moment the call-centre hands the lead to Sales.
--
-- app.ensure_lead_party(contact_id): if the contact already resolves to a party (existing
-- customer), link to it; otherwise mint a prospect party keyed 'LEAD:<contact_id>' — a key
-- that, together with card_count=0 and no customers/cbs_links row, marks it as a prospect so
-- it is trivially excluded from customer counts (party_key NOT LIKE 'LEAD:%'). Idempotent:
-- a contact already linked returns its party unchanged. The link is written to BOTH
-- crm_contacts and its call_center_leads row.

CREATE OR REPLACE FUNCTION app.ensure_lead_party(p_contact_id bigint) RETURNS bigint AS $func$
DECLARE pid bigint; nm text; ph text; em text; cif text; is_org boolean;
BEGIN
  SELECT party_id,
         NULLIF(btrim(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')), ''),
         NULLIF(btrim(phone), ''), NULLIF(btrim(email), ''),
         COALESCE(NULLIF(btrim(converted_cif),''), NULLIF(btrim(cif_number),''), NULLIF(btrim(matched_customer_cif),''))
    INTO pid, nm, ph, em, cif
    FROM crm_contacts WHERE id = p_contact_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF pid IS NOT NULL THEN RETURN pid; END IF;   -- already linked, nothing to do

  -- Prefer an existing party (a customer that may have appeared since the lead was created).
  pid := COALESCE(app.party_for_cif(cif), app.party_for_phone(ph));

  IF pid IS NULL THEN
    -- Mint a prospect party. Company-looking names -> organization (same heuristic as the
    -- CBS/Udara party builder). 'LEAD:<contact_id>' keeps it idempotent and identifiable.
    is_org := nm ~* '(LTD|LIMITED|LLC| PLC|ENTERPRISE|VENTURE|SOCIETY|COOP|COMPANY|RESOURCE|SERVICE|TECHNOLOG|GLOBAL|HOTEL|AGRIC|SOFTWARE|SCHOOL|CHURCH|MINISTR|FARM|STORE|GROUP|ASSOCIATION|UNION|CONCEPT|INTEGRATED|HOLDING)';
    INSERT INTO app.parties (party_key, party_type, full_name, primary_phone, primary_email, card_count, created_at)
    VALUES ('LEAD:' || p_contact_id, CASE WHEN is_org THEN 'organization' ELSE 'person' END,
            nm, ph, em, 0, NOW())
    ON CONFLICT (party_key) DO NOTHING;
    SELECT party_id INTO pid FROM app.parties WHERE party_key = 'LEAD:' || p_contact_id;
  END IF;

  IF pid IS NOT NULL THEN
    UPDATE crm_contacts      SET party_id = pid WHERE id = p_contact_id     AND party_id IS NULL;
    UPDATE call_center_leads SET party_id = pid WHERE contact_id = p_contact_id AND party_id IS NULL;
  END IF;
  RETURN pid;
END; $func$ LANGUAGE plpgsql;

-- Backfill: every lead already at or beyond qualified that has no party yet.
SELECT count(*) FILTER (WHERE app.ensure_lead_party(id) IS NOT NULL) AS ensured
  FROM crm_contacts
 WHERE party_id IS NULL
   AND lead_stage IN ('qualified','handed_to_sales','documents_requested','application_submitted','approved','converted');

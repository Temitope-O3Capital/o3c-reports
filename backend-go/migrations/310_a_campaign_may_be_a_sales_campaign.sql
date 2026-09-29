-- 310 — A call-centre CAMPAIGN may have the purpose its own calls already have.
--
-- Migration 162 added 'sales' to the purpose vocabulary and widened the CHECK on
-- helpdesk_calls and call_center_contacts. It did not widen call_center_campaigns, and
-- call_center_outbound.go's validator was written against the old five. So:
--
--   * a CALL can legally be stamped purpose='sales' (both CHECKs admit it, and
--     LogCallModal's CALL_PURPOSES offers it), but
--   * the CAMPAIGN those calls belong to cannot. Creating one answers
--     400 "invalid purpose (collections|marketing|support|retention|other)".
--
-- So the outbound sales floor could log sales calls but never group them under a sales
-- campaign — the campaign had to be mislabelled 'marketing' and every report keyed on
-- campaign purpose then counted sales activity as marketing.
--
-- dialer_campaigns carries no purpose CHECK at all, so there is nothing to widen there.
--
-- Verified before writing: no existing row violates the new list (it is strictly wider),
-- so this cannot fail on live data.

BEGIN;

ALTER TABLE app.call_center_campaigns DROP CONSTRAINT IF EXISTS call_center_campaigns_purpose_chk;

ALTER TABLE app.call_center_campaigns
  ADD CONSTRAINT call_center_campaigns_purpose_chk
  CHECK (purpose IS NULL OR purpose = ANY (ARRAY[
    'collections'::text, 'marketing'::text, 'sales'::text,
    'support'::text, 'retention'::text, 'other'::text]));

DO $m310$
DECLARE n_bad int; n_call int; n_camp int;
BEGIN
    -- The three purpose vocabularies must now agree. Compared as sorted arrays so the
    -- assertion is about CONTENT, not the order the ARRAY literal happens to be written in.
    SELECT COUNT(*) INTO n_bad
      FROM app.call_center_campaigns
     WHERE purpose IS NOT NULL
       AND purpose <> ALL (ARRAY['collections','marketing','sales','support','retention','other']);
    IF n_bad > 0 THEN
        RAISE EXCEPTION '310: % campaign(s) hold a purpose outside the vocabulary — refusing', n_bad;
    END IF;

    SELECT COUNT(*) INTO n_camp FROM app.call_center_campaigns WHERE purpose = 'sales';
    SELECT COUNT(*) INTO n_call FROM app.helpdesk_calls        WHERE purpose = 'sales';
    RAISE NOTICE '310: campaigns may now be purpose=sales (% already so, against % sales '
        'calls already logged)', n_camp, n_call;
END $m310$;

COMMIT;

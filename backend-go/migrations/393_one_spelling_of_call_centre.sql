-- 393_one_spelling_of_call_centre.sql
--
-- app.crm_lead_sources carries BOTH 'call_center' and 'call_centre', both active, both
-- labelled "Call Centre". Every lead-source dropdown in the platform therefore shows the
-- same option twice, and an officer picking the wrong one writes a value nothing else in
-- the system reads.
--
-- 'call_centre' is canonical and it is not a close call: 19,821 contacts carry it,
-- 'call_center' carries none, recordCallHandoff writes 'call_centre'
-- (handlers/call_center_forwards.go), and no Go or TypeScript file references the American
-- spelling as a lead_source value at all.
--
-- The row is DEACTIVATED rather than deleted. If anything ever did write it, a foreign key
-- or a historical report would break on a delete, and losing a row to tidy a dropdown is a
-- bad trade. is_active = false removes it from every picker while leaving it resolvable.

BEGIN;

-- Re-point anything carrying the dead spelling, before deactivating it. Expected to touch
-- zero rows today; written so the migration is still correct if that changes before it runs.
UPDATE app.crm_contacts SET lead_source = 'call_centre'
 WHERE lead_source = 'call_center';

UPDATE app.crm_lead_sources SET is_active = false
 WHERE code = 'call_center';

DO $$
DECLARE n int;
BEGIN
    -- The canonical row must survive, active. Deactivating both would empty the call-centre
    -- option out of every dropdown, which is a worse bug than the duplicate.
    SELECT count(*) INTO n FROM app.crm_lead_sources WHERE code = 'call_centre' AND is_active;
    IF n <> 1 THEN
        RAISE EXCEPTION 'migration 393: call_centre must remain active, found % active rows', n;
    END IF;

    SELECT count(*) INTO n FROM app.crm_lead_sources WHERE code = 'call_center' AND is_active;
    IF n <> 0 THEN
        RAISE EXCEPTION 'migration 393: call_center is still active';
    END IF;

    SELECT count(*) INTO n FROM app.crm_contacts WHERE lead_source = 'call_center';
    IF n <> 0 THEN
        RAISE EXCEPTION 'migration 393: % contacts still carry the dead spelling', n;
    END IF;

    -- And exactly one ACTIVE source may be labelled "Call Centre", which is the thing the
    -- officer actually sees. This is the assertion that would catch a third spelling being
    -- added later rather than the specific one fixed here.
    SELECT count(*) INTO n FROM app.crm_lead_sources
     WHERE is_active AND lower(btrim(label)) = 'call centre';
    IF n <> 1 THEN
        RAISE EXCEPTION 'migration 393: % active sources are labelled Call Centre, expected 1', n;
    END IF;
END $$;

INSERT INTO app.schema_migrations (filename) VALUES ('393_one_spelling_of_call_centre.sql')
ON CONFLICT DO NOTHING;

COMMIT;

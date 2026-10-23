-- rollback_393.sql
--
-- Re-activates the duplicate 'call_center' lead source.
--
-- This puts the duplicate option back in every lead-source dropdown — two entries both
-- reading "Call Centre" — so it is only worth running if something turns out to depend on
-- that row being selectable.
--
-- It deliberately does NOT re-point contacts back to the dead spelling. 393 moved any row
-- carrying 'call_center' onto the canonical 'call_centre' (zero rows at the time), and
-- undoing that would mean guessing which of the 19,821 canonical rows had been the dead
-- ones — unrecoverable, and pointless even if it were possible, since both mean the same
-- thing to every reader in the system.

BEGIN;

UPDATE app.crm_lead_sources SET is_active = true
 WHERE code = 'call_center';

DO $$
DECLARE n int;
BEGIN
    SELECT count(*) INTO n FROM app.crm_lead_sources WHERE code = 'call_center' AND is_active;
    IF n <> 1 THEN
        RAISE EXCEPTION 'rollback 393: call_center was not re-activated';
    END IF;

    -- The canonical row must still be active. If this fires, the database is in a worse
    -- state than either 393 or its rollback intended and needs a human.
    SELECT count(*) INTO n FROM app.crm_lead_sources WHERE code = 'call_centre' AND is_active;
    IF n <> 1 THEN
        RAISE EXCEPTION 'rollback 393: call_centre is not active; do not leave the database here';
    END IF;
END $$;

DELETE FROM app.schema_migrations
 WHERE btrim(filename, chr(13)) = '393_one_spelling_of_call_centre.sql';

COMMIT;

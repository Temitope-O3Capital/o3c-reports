-- 325: two converted contacts stored their CIF unpadded, so they joined to nothing.
--
-- Numbered 325 because 322, 323 and 324 all went while this was being written.
-- TestMigrationNumbersDoNotCollide caught the 323 clash, and another session had already taken
-- 324 by the time that rename landed — so check the test, not a directory listing, before
-- settling on a number.
--
-- 321 is a real collision that predates this and is NOT safe to rename: both files are already
-- recorded in app.schema_migrations under their current names, so renaming either makes the
-- runner treat it as new and run it a second time.
--
-- app.customers.cif is always exactly 8 digits, zero-padded. Two rows out of 1,447 hold a
-- 3-character value in both cif_number and converted_cif:
--
--     contact  5916  'KEN  YERIMA HENSHAW'  cif_number '350'  -> 00000350 Ken Henshaw
--     contact 19582  'Deinma Koko'          cif_number '708'  -> 00000708 Deinma Koko
--
-- These were first read as junk typed into a CIF field and nearly nulled out. They are not
-- junk — they are real CIFs with the leading zeros lost, and each resolves to exactly one
-- customer when padded. The identification is corroborated on both rows independently of the
-- number itself:
--
--   5916  phone 8039795016 is customer 00000350's 08039795016 — the same line.
--   19582 'Deinma Koko' is customer 00000708's name exactly; the emails differ only by domain
--         (hotmail against chevron), i.e. a personal address against a work one.
--
-- So this restores a join that existed in the source data, rather than asserting a new one.
-- Both columns are padded: converted_cif carries the same short value and is what the
-- conversion record points at.
--
-- Scoped by length rather than by id so a replay elsewhere fixes the same defect wherever it
-- sits, and so this cannot touch a correct 8-digit value. lpad is applied only where the
-- padded form actually names a customer — a short value that resolves to nobody is a
-- different problem and is left visibly wrong rather than silently padded into a stranger.
--
-- NO ROLLBACK, on the rule the handover doc records for 316: a rollback is worth writing where
-- it restores a previous *intention*. '350' was never an intention, it is lost leading zeros,
-- and there is no state of the world in which somebody wants these two contacts detached from
-- their customer records again. rollback_318 is the near case that did get one, because which
-- of two people a lead matched was genuinely arguable; which customer '350' means is not.

UPDATE app.crm_contacts c
   SET cif_number = lpad(c.cif_number, 8, '0'),
       updated_at = NOW()
 WHERE COALESCE(c.cif_number, '') <> ''
   AND length(c.cif_number) < 8
   AND c.cif_number ~ '^[0-9]+$'
   AND EXISTS (SELECT 1 FROM app.customers cu WHERE cu.cif = lpad(c.cif_number, 8, '0'));

UPDATE app.crm_contacts c
   SET converted_cif = lpad(c.converted_cif, 8, '0'),
       updated_at    = NOW()
 WHERE COALESCE(c.converted_cif, '') <> ''
   AND length(c.converted_cif) < 8
   AND c.converted_cif ~ '^[0-9]+$'
   AND EXISTS (SELECT 1 FROM app.customers cu WHERE cu.cif = lpad(c.converted_cif, 8, '0'));

DO $m325$
DECLARE
    v_short_cif   int;
    v_short_conv  int;
    v_unresolved  int;
    r             record;
BEGIN
    -- No CIF-shaped value may be left short where padding would have resolved it.
    SELECT count(*) INTO v_short_cif
      FROM app.crm_contacts
     WHERE COALESCE(cif_number, '') <> '' AND length(cif_number) < 8 AND cif_number ~ '^[0-9]+$'
       AND EXISTS (SELECT 1 FROM app.customers cu WHERE cu.cif = lpad(cif_number, 8, '0'));
    SELECT count(*) INTO v_short_conv
      FROM app.crm_contacts
     WHERE COALESCE(converted_cif, '') <> '' AND length(converted_cif) < 8 AND converted_cif ~ '^[0-9]+$'
       AND EXISTS (SELECT 1 FROM app.customers cu WHERE cu.cif = lpad(converted_cif, 8, '0'));
    IF v_short_cif > 0 OR v_short_conv > 0 THEN
        RAISE EXCEPTION '325: % cif_number and % converted_cif values are still short but resolvable',
            v_short_cif, v_short_conv;
    END IF;

    -- Every populated cif_number must now name a real customer. This is the check that would
    -- catch a pad that landed on the wrong person or on nobody.
    SELECT count(*) INTO v_unresolved
      FROM app.crm_contacts c
     WHERE COALESCE(c.cif_number, '') <> ''
       AND NOT EXISTS (SELECT 1 FROM app.customers cu WHERE cu.cif = c.cif_number);
    IF v_unresolved > 0 THEN
        RAISE EXCEPTION '325: % contacts name a cif_number that is not in app.customers', v_unresolved;
    END IF;

    FOR r IN
        SELECT c.id, c.last_name, c.cif_number, cu.full_name
          FROM app.crm_contacts c JOIN app.customers cu ON cu.cif = c.cif_number
         WHERE c.id IN (5916, 19582) ORDER BY c.id
    LOOP
        RAISE NOTICE '325: contact % (%) -> CIF % %', r.id, r.last_name, r.cif_number, r.full_name;
    END LOOP;
END
$m325$;

-- rollback_390.sql
--
-- Undoes 390_the_week_abuja_worked_on_paper.sql.
--
-- The hard part of this rollback is that two of the columns 390 writes hold ONE value each
-- -- call_center_leads.status and .last_disposition -- so the prior value is unrecoverable
-- from the row itself. They are therefore restored from the explicit per-lead values read
-- off the database before 390 ran, listed below. A rollback that set all 22 back to one
-- blanket status would invent a status for the five that never had it.
--
-- Order matters. The reconstructed forward rows are identified by the note text 390 wrote,
-- so they must be deleted before any note is stripped.

BEGIN;

-- 1. The reconstructed forward rows. A forward the system raised itself says
--    "Auto: qualified by a call-centre call" instead, and is left alone.
DELETE FROM app.call_center_lead_forwards
 WHERE notes LIKE 'Reconstructed from the Abuja tracker (feedback as at 2026-10-16) on 2026-10-22:%';

-- 2. Un-assign the forwards that already existed, and strip the appended note.
UPDATE app.call_center_lead_forwards
   SET sales_owner_id = NULL, sales_owner_name = NULL,
       status = 'forwarded', updated_at = now(),
       notes = NULLIF(btrim(replace(notes,
           ' | Assigned from the Abuja tracker (feedback as at 2026-10-16), transcribed 2026-10-22',
           '')), '')
 WHERE notes LIKE '%Assigned from the Abuja tracker (feedback as at 2026-10-16)%';

-- 3. The transcribed dispositions.
DELETE FROM app.call_center_dispositions
 WHERE notes LIKE '[Abuja tracker, feedback as at 2026-10-16,%';

-- 4. Ownership, cleared only where the owner is still the officer 390 set. If a head has
--    since reassigned one of these, that is a later human decision and it stands.
WITH sheet(lead_id, email) AS (VALUES
    (18872, 'ookpara@o3cards.com'), (20340, 'ookpara@o3cards.com'),
    (19537, 'ookpara@o3cards.com'), (17378, 'ookpara@o3cards.com'),
    (20171, 'iokoro@o3cards.com'),  (20109, 'iokoro@o3cards.com'),
    (18448, 'iokoro@o3cards.com'),  (20552, 'iokoro@o3cards.com'),
    (19894, 'jekomaru@o3cards.com'),(20448, 'jekomaru@o3cards.com'),
    (19647, 'jekomaru@o3cards.com'),
    (20445, 'rorekoya@o3cards.com'),(19376, 'rorekoya@o3cards.com'),
    (20172, 'rorekoya@o3cards.com'),
    (19188, 'doluwole@o3cards.com'),(19498, 'doluwole@o3cards.com'),
    (15282, 'doluwole@o3cards.com'),(19820, 'doluwole@o3cards.com'),
    (19634, 'maisah@o3cards.com'),  (20222, 'maisah@o3cards.com'),
    (19106, 'maisah@o3cards.com'))
UPDATE app.crm_contacts k SET sales_owner_id = NULL
  FROM sheet s
  JOIN app.call_center_leads l ON l.id = s.lead_id
  JOIN app.o3c_users u ON lower(u.email) = s.email
 WHERE k.id = l.contact_id AND k.sales_owner_id = u.id;

-- 5. Status, restored to the exact prior value per lead.
UPDATE app.call_center_leads SET status = 'interested' WHERE id IN (18872, 19537, 19647, 19376);
UPDATE app.call_center_leads SET status = 'called'     WHERE id = 19188;

-- 6. The dispositions 390 overwrote, restored per lead from the values read before it ran.
UPDATE app.call_center_leads SET last_disposition = 'Interested'
 WHERE id IN (18872, 19894, 20448, 19647, 20445, 19376, 20172, 18448, 20340, 19537, 20552,
              20222, 19106, 20109, 20271, 15282);
UPDATE app.call_center_leads SET last_disposition = 'Not Ready Yet'
 WHERE id IN (19634, 19498, 20171, 19820);
UPDATE app.call_center_leads SET last_disposition = 'Other ' || chr(8212) || ' Describe What Happened'
 WHERE id = 19188;
UPDATE app.call_center_leads
   SET last_disposition = 'Declined ' || chr(8212) || ' Not Eligible: HE SUBMITTED HIS FILLED FORMS AND '
       || 'YINKA SAID HE HAS A BAD CREDIT REPORT AND WE WILL NOT BE ABLE TO GIVE HIM THE LOAN AGAIN'
 WHERE id = 17378;

-- 7. The appended tracker note on the lead.
UPDATE app.call_center_leads
   SET notes = NULLIF(btrim(regexp_replace(COALESCE(notes, ''),
           '\[Abuja tracker, feedback as at 2026-10-16[^\]]*\][^' || chr(10) || ']*', '', 'g'),
           chr(10) || ' '), '')
 WHERE notes LIKE '%[Abuja tracker, feedback as at 2026-10-16%';

-- 8. Location. 390 only ever wrote 'FCT' into a BLANK column, so only 'FCT' goes back to
--    blank. Lead 18872 (Manet Global) held 'ABUJA' and an owner before 390 ran -- the router
--    assigned it on 13 Oct -- so neither is 390's to undo and both are excluded. Contact
--    46228 is restored to Lagos: that correction was ours, so reversing it is ours too.
WITH sheet(lead_id) AS (VALUES (20340),(19537),(17378),(20171),(20109),(18448),
    (20552),(19894),(20448),(19647),(20445),(19376),(20172),(19188),(19498),(15282),
    (19820),(19634),(20222),(19106),(20271))
UPDATE app.call_center_leads l SET state = '', updated_at = now()
  FROM sheet s WHERE l.id = s.lead_id AND l.state = 'FCT';

WITH sheet(lead_id) AS (VALUES (20340),(19537),(17378),(20171),(20109),(18448),
    (20552),(19894),(20448),(19647),(20445),(19376),(20172),(19188),(19498),(15282),
    (19820),(19634),(20222),(19106),(20271))
UPDATE app.crm_contacts k SET state = ''
  FROM sheet s
  JOIN app.call_center_leads l ON l.id = s.lead_id
 WHERE k.id = l.contact_id AND k.state = 'FCT' AND k.id <> 46228;

UPDATE app.crm_contacts SET state = 'Lagos' WHERE id = 46228 AND state = 'FCT';

DO $$
DECLARE n int;
BEGIN
    SELECT count(*) INTO n FROM app.call_center_dispositions
     WHERE notes LIKE '[Abuja tracker, feedback as at 2026-10-16,%';
    IF n <> 0 THEN RAISE EXCEPTION 'rollback 390: % transcribed dispositions survive', n; END IF;

    SELECT count(*) INTO n FROM app.call_center_lead_forwards
     WHERE notes LIKE 'Reconstructed from the Abuja tracker%';
    IF n <> 0 THEN RAISE EXCEPTION 'rollback 390: % reconstructed forwards survive', n; END IF;

    SELECT count(*) INTO n FROM app.call_center_leads
     WHERE id IN (18872, 19537, 19647, 19376, 19188) AND status = 'closed';
    IF n <> 0 THEN RAISE EXCEPTION 'rollback 390: % of the five closures survive', n; END IF;

    -- Manet Global keeps what the router gave it on 13 Oct. This assertion is the guard
    -- against a rollback that over-reaches into work 390 never did.
    IF (SELECT state FROM app.call_center_leads WHERE id = 18872) <> 'ABUJA' THEN
        RAISE EXCEPTION 'rollback 390: lead 18872 state was not left as the router set it';
    END IF;
END $$;

DELETE FROM app.schema_migrations
 WHERE btrim(filename, chr(13)) = '390_the_week_abuja_worked_on_paper.sql';

COMMIT;

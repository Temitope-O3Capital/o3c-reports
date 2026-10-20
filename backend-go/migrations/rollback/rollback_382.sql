-- Rollback for 382_the_department_list_stops_being_a_third_opinion.sql
--
-- WHAT THIS RESTORES. The twelve rows app.departments was seeded with on 2026-07-14,
-- by name and code. It does NOT restore their original ids: 382 deleted nine rows and
-- inserted three, and the sequence has moved on. That only matters if something has
-- started pointing at a department_id in the meantime — fleet_vehicles is the only
-- table that can, and it was empty when 382 ran. The check below refuses to proceed if
-- that has changed, because silently re-pointing a vehicle at a different department is
-- worse than refusing to roll back.
--
-- WHAT YOU ARE ROLLING BACK TO. A list in which no entry is a department anybody is in:
-- Sales, Cards Operations, Risk, Call Center, Compliance, IT and Executive are all gone
-- from the business, and Operations — where most of the staff sit — is absent. The fleet
-- vehicle form is its only consumer, so the effect is a dropdown that offers the wrong
-- six and omits the right ones. Roll back only if 382 broke something concrete.
--
-- NOTHING ELSE IS AFFECTED. 382 did not touch o3c_users.department, which is what every
-- other consumer reads, and migration 380 is what set those values. Rolling this back
-- does not reintroduce the 'Sales' / 'Sales & BD' split that 380 closed.

DO $guard$
DECLARE
  n INT;
BEGIN
  SELECT COUNT(*) INTO n FROM app.fleet_vehicles WHERE department_id IS NOT NULL;
  IF n > 0 THEN
    RAISE EXCEPTION
      'rollback 382: % vehicle(s) now reference a department id. Reassign them first, or this rollback would point them at the wrong department', n;
  END IF;
END $guard$;

DELETE FROM app.departments;

INSERT INTO app.departments (name, code) VALUES
  ('Finance',          'FIN'),
  ('Sales',            'SAL'),
  ('Risk',             'RSK'),
  ('Cards Operations', 'CRD'),
  ('Collections',      'COL'),
  ('Recovery',         'REC'),
  ('Call Center',      'CCA'),
  ('Human Resources',  'HHR'),
  ('Compliance',       'CMP'),
  ('Internal Control', 'ICT'),
  ('IT',               'ITT'),
  ('Executive',        'EXC');

COMMENT ON TABLE app.departments IS NULL;

DO $assert$
DECLARE
  n INT;
BEGIN
  SELECT COUNT(*) INTO n FROM app.departments;
  IF n <> 12 THEN
    RAISE EXCEPTION 'rollback 382: expected the 12 seeded departments, found %', n;
  END IF;
  -- o3c_users.department belongs to 380, not to this file, and must be untouched.
  IF EXISTS (
    SELECT 1 FROM app.o3c_users
     WHERE deleted_at IS NULL
       AND btrim(COALESCE(department, '')) IN ('Sales', 'Sales & BD', 'HR')
  ) THEN
    RAISE EXCEPTION 'rollback 382: staff departments carry a superseded spelling; that is 380s and this rollback should not have changed it';
  END IF;
END $assert$;

-- Rollback for 389_a_module_nobody_registered_is_invisible_to_everyone.sql
--
-- WHAT THIS UNDOES. The module_config rows for 'fleet' and 'people' are deleted again, which
-- removes the Fleet and People sections from the sidebar for every user, admin included.
--
-- WHAT YOU ARE ROLLING BACK TO. A workspace where Fleet (Overview, Fuel Cards, Work &
-- Incidents) and People (People Directory, Staff Performance, Leave) are built, deployed,
-- routed and gated — and unreachable from the menu, because the section filter in Sidebar.tsx
-- hides any section whose key has no enabled module row. That was the state the whole of 389
-- existed to correct, so roll back only if one of these modules has to be withdrawn from the
-- floor in a hurry.
--
-- PREFER DISABLING TO DELETING. To take a module off the menu while keeping it registered in
-- the Modules admin screen, set enabled = false on its row instead of running this — either in
-- Administration -> Modules, or:
--     UPDATE app.module_config SET enabled = false, updated_at = NOW() WHERE key = 'fleet';
-- That is reversible from the UI by whoever needs it back. This rollback removes the rows
-- outright, and then only a re-insert brings them back.
--
-- 389 CHANGED NO ACCESS AND NO DATA. It inserted two rows into a menu-registration table. It
-- moved no money, created no grant and touched no fleet, staff, leave or ticket record, so
-- neither it nor this rollback can alter a reported figure. Every page in both modules remains
-- gated on its own page key at the route guard and the API regardless of which way this ran.

BEGIN;

DELETE FROM app.module_config WHERE key IN ('fleet', 'people');

DO $assert$
BEGIN
  IF EXISTS (SELECT 1 FROM app.module_config WHERE key IN ('fleet', 'people')) THEN
    RAISE EXCEPTION
      'rollback 389: a fleet or people module row is still registered after the delete';
  END IF;
END $assert$;

COMMIT;

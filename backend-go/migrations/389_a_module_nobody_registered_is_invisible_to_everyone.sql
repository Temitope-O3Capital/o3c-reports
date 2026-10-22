-- Register the Fleet and People modules in module_config.
--
-- WHY THESE TWO WERE INVISIBLE TO EVERYONE, ADMIN INCLUDED. The sidebar filters whole
-- sections on the enabled-module set (Sidebar.tsx, visibleSections -> enabledModules.has
-- (section.key)), and that filter is not one the role model can override: only the 'root'
-- and 'admin' sections are exempt from it. So a section whose key has no enabled row in
-- module_config is hidden from every single user — admin and md included, even though both
-- of them bypass the three gates that do answer to roles (canSee, makeCanOpen's canOpen,
-- and RequireAccess in App.tsx).
--
-- Nothing else was wrong. Routes, page keys, handlers, nav entries and the API mounts for
-- both modules were all present and correct; the menu sections that lead to them simply
-- never rendered, so there was no way in from the sidebar.
--
-- 'people' IS A RE-REGISTRATION, NOT A NEW KEY. Migration 121 removed the old HR & Payroll
-- module and ended with `DELETE FROM module_config WHERE key = 'people'`. The People section
-- built since — People Directory, Staff Performance, Leave — reuses that same section key
-- while sharing none of the tables 121 dropped, so the row has to come back for the new
-- module to appear. 'fleet' never had a row at any point.
--
-- sort_order 10 and 11 are the next free slots (1-9 are taken). They order the Modules admin
-- screen only; the sidebar's own order comes from the SECTIONS array in Sidebar.tsx, exactly
-- as migration 147 noted when it registered Care.
--
-- ENABLING A MODULE REVEALS A MENU SECTION AND GRANTS NOTHING. Every page inside stays gated
-- on its own page key — fleet, fleet_admin, people_directory, staff_performance, leave_admin —
-- at both the route guard and the API, so who can open what is unchanged by this migration.

BEGIN;

INSERT INTO app.module_config (key, label, enabled, sort_order)
VALUES ('fleet',  'Fleet',  true, 10),
       ('people', 'People', true, 11)
ON CONFLICT (key) DO NOTHING;

DO $assert$
DECLARE
  n INT;
BEGIN
  SELECT COUNT(*) INTO n
    FROM app.module_config
   WHERE key IN ('fleet', 'people') AND enabled;
  IF n <> 2 THEN
    RAISE EXCEPTION
      'migration 389: expected Fleet and People both registered and enabled, found % of 2', n;
  END IF;
END $assert$;

COMMIT;

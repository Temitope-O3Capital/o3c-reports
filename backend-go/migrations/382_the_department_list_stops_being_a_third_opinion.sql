-- 382: the department list stops being a third opinion.
--
-- THE PROBLEM. A department is named in two places in this product:
--
--   o3c_users.department   free text, one per member of staff. This is what every
--                          consumer actually reads — availability's department-head
--                          check, leave's department scoping, the People filter, and
--                          /api/people/departments, which derives its whole list from
--                          it. Migration 380 canonicalised it to HR's own names.
--
--   app.departments        a 12-row lookup seeded on 2026-07-14, during the HR module
--                          that migration 121 later dropped. Nothing has maintained it
--                          since. Its only consumer anywhere is the department dropdown
--                          on the fleet vehicle form (fleet_vehicles.department_id), and
--                          there are zero vehicles, so it has never been used in anger.
--
-- Left alone it is a trap rather than a table. It offered Sales, Cards Operations, Risk,
-- Call Center, Compliance, IT and Executive — not one of which is a department anybody
-- is in — while omitting Operations, where 24 of the 50 active staff sit. The first
-- person to assign a vehicle would have introduced a THIRD spelling of the sales
-- department, which is the drift 380 existed to end.
--
-- WHAT THIS DOES. Rebuilds app.departments from the staff register, so the lookup cannot
-- disagree with the column every consumer reads.
--
-- ACTIVE STAFF ONLY, which is a deliberate choice and not an oversight: 'Platform'
-- exists in o3c_users.department for exactly one row, the deactivated O3C Automation
-- service account, and a service account's notional department has no business in a
-- dropdown. 'Call Centre' is kept because Felix Folorunsho is active and that is his
-- department — even though HR's roster does not name him, which is a reconciliation for
-- the business rather than a reason to delete his department here.
--
-- WHY NOT DROP THE TABLE INSTEAD. fleet_vehicles.department_id has a foreign key to it,
-- so dropping it means dropping that column too, which is a fleet decision and not this
-- migration's to take. Aligning costs nothing and removes the trap.
--
-- CODES ARE MAPPED, NOT COMPUTED. A first draft derived them from initials and produced
-- 'O' for Operations. An existing code is always kept, so FIN, HHR and ICT survive
-- untouched and nothing that memorised one breaks.

DO $dept$
DECLARE
  n_refs INT;
BEGIN
  -- Never delete a department something is actually using. If the fleet register has
  -- filled up since this was written, say so loudly rather than orphan a vehicle.
  SELECT COUNT(*) INTO n_refs
    FROM app.fleet_vehicles v
    JOIN app.departments d ON d.id = v.department_id
   WHERE btrim(d.name) NOT IN (
     SELECT DISTINCT btrim(u.department)
       FROM app.o3c_users u
      WHERE u.is_active AND u.deleted_at IS NULL
        AND NULLIF(btrim(COALESCE(u.department, '')), '') IS NOT NULL
   );
  IF n_refs > 0 THEN
    RAISE EXCEPTION
      '382: % vehicle(s) are assigned to a department no active member of staff is in; resolve those before realigning the list', n_refs;
  END IF;
END $dept$;

INSERT INTO app.departments (name, code)
SELECT s.name,
       COALESCE(
         -- An existing row's code wins, so a rename never churns a code.
         (SELECT x.code FROM app.departments x WHERE x.name = s.name),
         m.code,
         -- Last resort for a department nobody anticipated: the first four letters.
         upper(left(regexp_replace(s.name, '[^A-Za-z]', '', 'g'), 4))
       )
  FROM (
    SELECT DISTINCT btrim(u.department) AS name
      FROM app.o3c_users u
     WHERE u.is_active AND u.deleted_at IS NULL
       AND NULLIF(btrim(COALESCE(u.department, '')), '') IS NOT NULL
  ) s
  LEFT JOIN (VALUES
      ('Operations',             'OPS'),
      ('Sales & Marketing',      'SMK'),
      ('Finance',                'FIN'),
      ('Human Resources',        'HRS'),
      ('Internal Control',       'ICL'),
      ('Call Centre',            'CCE'),
      -- Information Technology has no account yet: all three of HR's IT staff are in
      -- the file with no login. The code is here so that when those accounts are
      -- created the department arrives with a sensible one rather than 'INFO'.
      ('Information Technology', 'IT')
  ) AS m(name, code) ON m.name = s.name
 ON CONFLICT (name) DO NOTHING;

DELETE FROM app.departments d
 WHERE btrim(d.name) NOT IN (
   SELECT DISTINCT btrim(u.department)
     FROM app.o3c_users u
    WHERE u.is_active AND u.deleted_at IS NULL
      AND NULLIF(btrim(COALESCE(u.department, '')), '') IS NOT NULL
 );

COMMENT ON TABLE app.departments IS
  'Lookup for fleet_vehicles.department_id only. The authoritative department of a person is o3c_users.department, and /api/people/departments derives its list from that column; migration 382 rebuilt this table from it so the two cannot disagree.';

-- ── Assertions ───────────────────────────────────────────────────────────────
DO $assert$
DECLARE
  n_missing INT;
  n_extra   INT;
  n_depts   INT;
  names     TEXT;
BEGIN
  SELECT COUNT(*) INTO n_missing
    FROM (SELECT DISTINCT btrim(u.department) AS name
            FROM app.o3c_users u
           WHERE u.is_active AND u.deleted_at IS NULL
             AND NULLIF(btrim(COALESCE(u.department, '')), '') IS NOT NULL) s
   WHERE NOT EXISTS (SELECT 1 FROM app.departments d WHERE btrim(d.name) = s.name);
  IF n_missing > 0 THEN
    RAISE EXCEPTION '382: % staff department(s) still have no row in app.departments', n_missing;
  END IF;

  SELECT COUNT(*) INTO n_extra
    FROM app.departments d
   WHERE btrim(d.name) NOT IN (
     SELECT DISTINCT btrim(u.department) FROM app.o3c_users u
      WHERE u.is_active AND u.deleted_at IS NULL
        AND NULLIF(btrim(COALESCE(u.department, '')), '') IS NOT NULL);
  IF n_extra > 0 THEN
    RAISE EXCEPTION '382: % department row(s) remain that no active member of staff is in', n_extra;
  END IF;

  IF EXISTS (SELECT 1 FROM app.departments WHERE NULLIF(btrim(COALESCE(code, '')), '') IS NULL) THEN
    RAISE EXCEPTION '382: a department was left without a code';
  END IF;

  -- Codes are shown beside the name, so two departments sharing one is a display bug
  -- waiting to happen. The unique constraint on code would have caught it; this names it.
  IF EXISTS (SELECT code FROM app.departments GROUP BY code HAVING COUNT(*) > 1) THEN
    RAISE EXCEPTION '382: two departments ended up sharing a code';
  END IF;

  SELECT COUNT(*), string_agg(name, ', ' ORDER BY name) INTO n_depts, names FROM app.departments;
  RAISE NOTICE '382: app.departments rebuilt from the staff register — % department(s): %', n_depts, names;
END $assert$;

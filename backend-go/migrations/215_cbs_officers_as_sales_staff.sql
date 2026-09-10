-- 215: create the 4 remaining Udara loan officers as Sales staff, attribute their CBS
-- book to them, and standardise office locations to the two current branches.
--
-- These officers appear on Udara loans/FDs (accountOfficerName) but had no workspace
-- user, so their production wasn't credited to anyone. Create them as sales_officer,
-- mirroring the existing synthetic-officer pattern: cbs.<first>.<last>@officer.o3c.local
-- with the non-login sentinel password hash '!cbs-no-login' (they can't sign in until an
-- admin provisions a real email + password; is_active so they count as sales staff).
-- Udara names are surname-first; workspace names are given-first (reversed here).
INSERT INTO o3c_users (email, password_hash, full_name, first_name, last_name, role, department, is_active, must_change_password)
VALUES
 ('cbs.maminetu.isah@officer.o3c.local',       '!cbs-no-login', 'Maminetu Isah',       'Maminetu',     'Isah',    'sales_officer', 'Sales', true, false),
 ('cbs.precious.obioha@officer.o3c.local',      '!cbs-no-login', 'Precious Obioha',      'Precious',     'Obioha',  'sales_officer', 'Sales', true, false),
 ('cbs.oghenefejiro.odometa@officer.o3c.local', '!cbs-no-login', 'Oghenefejiro Odometa', 'Oghenefejiro', 'Odometa', 'sales_officer', 'Sales', true, false),
 ('cbs.dorcas.oluwole@officer.o3c.local',       '!cbs-no-login', 'Dorcas Oluwole',       'Dorcas',       'Oluwole', 'sales_officer', 'Sales', true, false)
ON CONFLICT (email) DO NOTHING;

-- Point the officer map at the new users so their Udara loans/FDs are attributed.
UPDATE app.cbs_officer_map m SET officer_user_id = u.id
FROM o3c_users u
WHERE m.officer_user_id IS NULL AND (
     (m.udara_name = 'Isah Maminetu'        AND u.email = 'cbs.maminetu.isah@officer.o3c.local')
  OR (m.udara_name = 'Obioha Precious'      AND u.email = 'cbs.precious.obioha@officer.o3c.local')
  OR (m.udara_name = 'Odometa Oghenefejiro' AND u.email = 'cbs.oghenefejiro.odometa@officer.o3c.local')
  OR (m.udara_name = 'Oluwole Dorcas'       AND u.email = 'cbs.dorcas.oluwole@officer.o3c.local')
);

-- Two locations for now: Lagos (Head Quarter) and Abuja. Standardise existing "Lagos".
UPDATE o3c_users SET office_location = 'Lagos (Head Quarter)'
 WHERE office_location = 'Lagos';

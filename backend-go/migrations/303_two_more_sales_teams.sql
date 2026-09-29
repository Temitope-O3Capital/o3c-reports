-- 303 — Team Ozioma and Team Ikechukwu Okoro.
--
-- WHY. Two teams were agreed on 28 Sept 2026 and named with their members. Both are
-- created here rather than clicked in, so the structure is reviewable and the same on
-- every environment.
--
-- The members are matched to o3c_users by id, not by name, because three of the names
-- as given do not match a user record character-for-character and a name match would
-- either miss them or, worse, hit the wrong person:
--
--   "Justina C Ekomaru"  → Justina Ekomaru   (37)  — middle initial not in the record
--   "Ebunoluwa Dorcas"   → Dorcas Oluwole    (56)  — confirmed as the same person
--   "Maminetu isah"      → Maminetu Isah     (53)  — casing
--   "Reuben Orekoya"     → Reuben Orekoya    (57)
--
-- HEADS. Ozioma Okpara (44) and Ikechukwu Okoro (41). Note 41 and not 58: there are two
-- Ikechukwu Okoro records and 58 ("Ikechuckwu Okoro") is an inactive, misspelled
-- duplicate carrying a different role. 58 is left untouched here — merging duplicate
-- staff records is its own job with its own blast radius.
--
-- HUSSEINI IS DEFERRED, NOT FORGOTTEN. He was named for Team Ikechukwu Okoro and has no
-- user record at all. Inventing one would create a login, so the team is created with
-- Reuben only and Husseini is added once he has an account.
--
-- BOTH HEADS ARE sales_officer, NOT sales_head. That used to mean a head could run a
-- team and still see only their own leads, because salesLeadScope tested the role
-- instead of the structure. Fixed in sales_teams.go in the same release: running a team
-- is what grants team scope. No role is changed here — granting someone a role grants
-- them everything else that role carries, and that is not what "make her team head"
-- asked for.
--
-- REVERSIBLE and re-runnable: keyed on team name, so a second run updates the head
-- rather than creating a second Team Ozioma. rollback/rollback_303.sql removes both.

-- ---------------------------------------------------------------------------
-- The teams.
--
-- A team name has to be unique before anything can be keyed on it, and there was no
-- constraint saying so — two teams could both be called "Team Ozioma", after which
-- "which officers are on Team Ozioma?" has no answer. The two existing teams already
-- have distinct names, so this only forbids a future collision.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_teams_name ON app.sales_teams (name);

INSERT INTO app.sales_teams (name, head_user_id, is_active, created_at, updated_at)
SELECT v.name, v.head, TRUE, NOW(), NOW()
  FROM (VALUES
      ('Team Ozioma',           44::bigint),
      ('Team Ikechukwu Okoro',  41::bigint)
  ) AS v(name, head)
 WHERE EXISTS (SELECT 1 FROM app.o3c_users u WHERE u.id = v.head AND u.deleted_at IS NULL)
ON CONFLICT (name) DO UPDATE
   SET head_user_id = EXCLUDED.head_user_id,
       is_active    = TRUE,
       updated_at   = NOW();

-- ---------------------------------------------------------------------------
-- The members.
--
-- An officer belongs to at most one team (uq_sales_team_member_user), so a member who
-- is already on another team would collide. None of these four are on a team today;
-- the guard below turns a future collision into a clear failure rather than a silent
-- re-homing that takes an officer off a colleague's team without anyone noticing.
-- ---------------------------------------------------------------------------

INSERT INTO app.sales_team_members (team_id, user_id)
SELECT t.id, v.user_id
  FROM (VALUES
      ('Team Ozioma',          37::bigint),   -- Justina Ekomaru
      ('Team Ozioma',          56::bigint),   -- Dorcas Oluwole  ("Ebunoluwa Dorcas")
      ('Team Ozioma',          53::bigint),   -- Maminetu Isah
      ('Team Ikechukwu Okoro', 57::bigint)    -- Reuben Orekoya
  ) AS v(team_name, user_id)
  JOIN app.sales_teams t ON t.name = v.team_name
 WHERE EXISTS (SELECT 1 FROM app.o3c_users u WHERE u.id = v.user_id AND u.deleted_at IS NULL)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Guards.
-- ---------------------------------------------------------------------------

DO $m303$
DECLARE
    v_teams   bigint;
    v_members bigint;
    v_misplaced text;
BEGIN
    SELECT count(*) INTO v_teams
      FROM app.sales_teams
     WHERE name IN ('Team Ozioma', 'Team Ikechukwu Okoro') AND is_active;
    IF v_teams <> 2 THEN
        RAISE EXCEPTION '303: expected both teams to exist and be active, found %.', v_teams;
    END IF;

    SELECT count(*) INTO v_members
      FROM app.sales_team_members m
      JOIN app.sales_teams t ON t.id = m.team_id
     WHERE t.name IN ('Team Ozioma', 'Team Ikechukwu Okoro');
    IF v_members <> 4 THEN
        RAISE EXCEPTION
          '303: expected 4 members across the two teams (Husseini deferred, no account), found %.',
          v_members;
    END IF;

    -- Did any of the four land somewhere other than the team they were named for?
    SELECT string_agg(u.full_name || ' on ' || t.name, '; ') INTO v_misplaced
      FROM app.sales_team_members m
      JOIN app.sales_teams t ON t.id = m.team_id
      JOIN app.o3c_users  u ON u.id = m.user_id
     WHERE (m.user_id IN (37, 56, 53) AND t.name <> 'Team Ozioma')
        OR (m.user_id = 57           AND t.name <> 'Team Ikechukwu Okoro');
    IF v_misplaced IS NOT NULL THEN
        RAISE EXCEPTION '303: officer on the wrong team: %', v_misplaced;
    END IF;

    RAISE NOTICE
      '303: Team Ozioma (head Ozioma Okpara) and Team Ikechukwu Okoro (head Ikechukwu '
      'Okoro) created with 4 officers. Husseini still needs a user account.';
END
$m303$;

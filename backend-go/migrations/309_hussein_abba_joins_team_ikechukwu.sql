-- 309: Hussein Abba joins Team Ikechukwu Okoro as a sales rep.
--
-- Migration 303 created Team Ikechukwu Okoro with Reuben Orekoya only. Hussein was named
-- on the same roster but had no workspace user at all, so there was nobody to add — a lead
-- assigned to him would have had nowhere to go, and he was invisible to the team roster,
-- the supervisor calendar and every per-officer target.
--
-- WHY NO PASSWORD IS SET HERE
--
-- password_hash is the '!cbs-no-login' sentinel: a literal that can never match a bcrypt
-- comparison, so this row cannot authenticate as it stands. That is deliberate. A real
-- credential does not belong in a migration file — it would be committed to git, and it
-- would be the SAME credential in every environment this migration is ever replayed into.
-- The account is created here (structure: who exists, what they are, whose team they are
-- on) and the credential is issued through the channel that already exists for it: an
-- admin opens Admin -> Users -> Hussein Abba -> Reset Password, which generates a random
-- temporary password, emails it to him and sets must_change_password so he replaces it on
-- first sign-in.
--
-- Until that reset is done he holds leads and targets correctly but cannot log in. That is
-- the safe failure direction: an account that cannot yet be used, rather than one anybody
-- reading this file could use.
--
-- is_active is TRUE because salesOfficerPredicate and the team roster both test it — a
-- FALSE row would be created and then ignored everywhere, which is the bug this fixes.
--
-- Email follows the convention real staff use (first initial + surname @o3cards.com), not
-- the cbs.<name>@officer.o3c.local form from migration 215. That form is for synthetic
-- attribution-only officers who exist solely to be named as an RM; Hussein is a working
-- rep who needs to sign in and work a queue.

-- No explicit BEGIN/COMMIT. The runner PGExecs the whole file as one simple query, which
-- Postgres already executes in an implicit transaction, so the file is atomic as it stands.
-- An explicit BEGIN/COMMIT here would additionally COMMIT any surrounding transaction —
-- which silently defeats the `BEGIN; \i file; ROLLBACK;` harness used to dry-run these.

INSERT INTO o3c_users
    (email, password_hash, full_name, first_name, last_name,
     role, department, is_active, must_change_password)
VALUES
    ('habba@o3cards.com', '!cbs-no-login', 'Hussein Abba', 'Hussein', 'Abba',
     'sales_officer', 'Sales', TRUE, TRUE)
-- Revive rather than skip. DO NOTHING would leave a previously soft-deleted row inactive,
-- so re-applying after a rollback would recreate the membership around a dead account and
-- the guards below would pass while Hussein stayed invisible everywhere.
--
-- password_hash is deliberately NOT in the SET list: if this email has since been given a
-- real credential, overwriting it with the sentinel would lock a working user out. Reviving
-- must never be able to destroy a password.
ON CONFLICT (email) DO UPDATE
   SET is_active  = TRUE,
       deleted_at = NULL,
       role       = EXCLUDED.role,
       department = EXCLUDED.department,
       full_name  = EXCLUDED.full_name,
       updated_at = NOW()
 WHERE o3c_users.deleted_at IS NOT NULL OR o3c_users.is_active = FALSE;

-- Team membership, keyed on the team NAME rather than the id 6 observed today, so the
-- statement is still correct if the ids differ wherever this is replayed.
INSERT INTO app.sales_team_members (team_id, user_id)
SELECT t.id, u.id
  FROM app.sales_teams t
  JOIN o3c_users u ON u.email = 'habba@o3cards.com'
 WHERE t.name = 'Team Ikechukwu Okoro'
ON CONFLICT (team_id, user_id) DO NOTHING;

-- ── Guards ───────────────────────────────────────────────────────────────────
-- Each of these has failed for real on an earlier migration in this series, so they are
-- assertions rather than decoration.
DO $$
DECLARE
    uid          bigint;
    team_count   integer;
    roster_count integer;
BEGIN
    SELECT id INTO uid FROM o3c_users WHERE email = 'habba@o3cards.com';
    IF uid IS NULL THEN
        RAISE EXCEPTION 'Hussein Abba was not created';
    END IF;

    -- He must be on exactly one team, and it must be the right one.
    SELECT COUNT(*) INTO team_count
      FROM app.sales_team_members m
      JOIN app.sales_teams t ON t.id = m.team_id
     WHERE m.user_id = uid AND t.name = 'Team Ikechukwu Okoro';
    IF team_count <> 1 THEN
        RAISE EXCEPTION 'Expected Hussein on Team Ikechukwu Okoro exactly once, found %', team_count;
    END IF;

    -- The team should now be Ikechukwu (head) + Reuben + Hussein.
    SELECT COUNT(*) INTO roster_count
      FROM app.sales_team_members m
      JOIN app.sales_teams t ON t.id = m.team_id
     WHERE t.name = 'Team Ikechukwu Okoro';
    IF roster_count <> 2 THEN
        RAISE EXCEPTION 'Team Ikechukwu Okoro should have 2 members (Reuben, Hussein), has %', roster_count;
    END IF;

    -- The sentinel must be intact: if this ever looks like a bcrypt hash, a real
    -- credential has been committed to the repo.
    IF EXISTS (SELECT 1 FROM o3c_users
                WHERE email = 'habba@o3cards.com'
                  AND password_hash <> '!cbs-no-login'
                  AND password_hash LIKE '$2%'
                  AND created_at > NOW() - INTERVAL '1 minute') THEN
        RAISE EXCEPTION 'A real password hash was committed for Hussein Abba — use the admin reset instead';
    END IF;

    -- He must be active and reachable, which is the whole point of the migration.
    IF NOT EXISTS (SELECT 1 FROM o3c_users
                    WHERE email = 'habba@o3cards.com'
                      AND is_active AND deleted_at IS NULL) THEN
        RAISE EXCEPTION 'Hussein Abba exists but is inactive or soft-deleted';
    END IF;
END $$;

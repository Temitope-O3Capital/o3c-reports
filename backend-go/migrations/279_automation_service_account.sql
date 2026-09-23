-- 279 — An automation service account, so scheduled work is not signed with a person's name.
--
-- WHY. app.collection_assignments.assigned_by is NOT NULL, so anything that creates an
-- assignment must name an actor. Today every one of the 1,636 rows carries assigned_by = 1
-- — Temitope Babatunde, a real admin — because they were seeded by migration rather than
-- by a person deciding anything. Once the collections queue refresh runs on a schedule
-- that becomes actively misleading: an audit would show a named human creating assignments
-- at 03:00 every night. Automated work should say so.
--
-- SAFETY. This row cannot be used to sign in:
--   * password_hash is the literal '!no-login-service-account'. The column is NOT NULL, so
--     it cannot be left empty; this value is not a bcrypt hash, and bcrypt's compare
--     returns an error (never a match) for a malformed hash, so no password authenticates
--   * is_active = false, which the auth middleware refuses before anything else
--   * must_change_password = true, so even an accidental credential grant is dead-ended
-- It exists to be referenced by assigned_by / actor columns, nothing more.
--
-- Idempotent: keyed on the email, which carries a UNIQUE constraint.

BEGIN;

INSERT INTO app.o3c_users (email, password_hash, full_name, first_name, last_name,
                           role, department, is_active, must_change_password,
                           created_at, updated_at)
VALUES ('automation@o3capital.internal', '!no-login-service-account', 'O3C Automation', 'O3C', 'Automation',
        'system', 'Platform', false, true, NOW(), NOW())
ON CONFLICT (email) DO UPDATE
   SET full_name  = EXCLUDED.full_name,
       role       = 'system',
       is_active  = false,
       updated_at = NOW();

DO $$
DECLARE uid bigint;
BEGIN
    SELECT id INTO uid FROM app.o3c_users WHERE email = 'automation@o3capital.internal';
    IF uid IS NULL THEN
        RAISE EXCEPTION '279: automation service account was not created';
    END IF;
    RAISE NOTICE '279: automation service account is user id % — cannot sign in (is_active=false, password_hash is not a valid bcrypt hash)', uid;
END $$;

COMMIT;

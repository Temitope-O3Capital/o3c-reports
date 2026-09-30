-- Rollback 319: remove the suspension columns.
--
-- Reverses an intention rather than a defect, so it belongs here (see the handover doc note on
-- when a rollback is worth writing).
--
-- It refuses while anyone is actually suspended. Dropping the columns then would silently
-- destroy the only record of who was cut off and why, and — worse — leave those accounts
-- is_active=FALSE with nothing left to explain it, indistinguishable from an ordinary leaver.
-- Lift the suspensions first, deliberately, then run this.

DO $r319$
DECLARE
    v_live int;
BEGIN
    SELECT count(*) INTO v_live FROM app.o3c_users WHERE suspended_at IS NOT NULL;
    IF v_live > 0 THEN
        RAISE EXCEPTION 'rollback_319: % account(s) are still suspended — reinstate them before '
                        'dropping the columns that record it', v_live;
    END IF;
END
$r319$;

DROP INDEX IF EXISTS app.idx_o3c_users_suspended;

ALTER TABLE app.o3c_users
    DROP CONSTRAINT IF EXISTS o3c_users_suspended_by_fkey;

ALTER TABLE app.o3c_users
    DROP COLUMN IF EXISTS suspended_at,
    DROP COLUMN IF EXISTS suspended_by,
    DROP COLUMN IF EXISTS suspended_reason,
    DROP COLUMN IF EXISTS reinstate_code_hash,
    DROP COLUMN IF EXISTS reinstate_code_expires_at,
    DROP COLUMN IF EXISTS reinstate_code_attempts;

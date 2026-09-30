-- 319: the emergency stop for a staff account, and the short code that lifts it.
--
-- Deactivating an account already blocks the NEXT sign-in. It does not end the session the
-- person is in: AuthMiddleware only rejects a token for being denylisted, expired, or minted
-- before o3c_users.tokens_valid_from, and deactivateUser never moved that watermark. So a
-- deactivated user kept working until their token aged out. That is the gap this closes — a
-- suspension has to be immediate to be worth having, because the reason you reach for it is
-- that the account is being misused right now.
--
-- No new "suspended" boolean. is_active already means "may this account be used", and a second
-- flag would create two ways to be switched off, with precedence to get wrong. These columns
-- record WHY and BY WHOM, and hold the reinstatement code — they never gate access on their own.
--
-- The code is a recovery path for the honest case: a head suspends someone from their phone,
-- realises within the hour it was the wrong person, and can read six digits down the line
-- instead of waiting for an admin at a desk. It lifts the suspension and NOTHING ELSE: the
-- person still needs their own password to get in, so a code overheard or forwarded is not an
-- account takeover. It is stored as a bcrypt hash for the same reason a password is.

ALTER TABLE app.o3c_users
    ADD COLUMN IF NOT EXISTS suspended_at              timestamptz,
    ADD COLUMN IF NOT EXISTS suspended_by              bigint,
    ADD COLUMN IF NOT EXISTS suspended_reason          text,
    ADD COLUMN IF NOT EXISTS reinstate_code_hash       text,
    ADD COLUMN IF NOT EXISTS reinstate_code_expires_at timestamptz,
    ADD COLUMN IF NOT EXISTS reinstate_code_attempts   integer NOT NULL DEFAULT 0;

-- suspended_by is ON DELETE SET NULL, not CASCADE: losing the admin's account must never
-- delete the staff member whose suspension they recorded.
DO $fk319$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'o3c_users_suspended_by_fkey'
    ) THEN
        ALTER TABLE app.o3c_users
            ADD CONSTRAINT o3c_users_suspended_by_fkey
            FOREIGN KEY (suspended_by) REFERENCES app.o3c_users(id) ON DELETE SET NULL;
    END IF;
END
$fk319$;

-- Partial index: only suspended rows are ever looked up this way, and there should be very
-- few of them. A full index on a mostly-NULL column would be dead weight.
CREATE INDEX IF NOT EXISTS idx_o3c_users_suspended
    ON app.o3c_users (suspended_at) WHERE suspended_at IS NOT NULL;

DO $m319$
DECLARE
    v_cols int;
    v_live int;
BEGIN
    SELECT count(*) INTO v_cols
      FROM information_schema.columns
     WHERE table_schema = 'app' AND table_name = 'o3c_users'
       AND column_name IN ('suspended_at', 'suspended_by', 'suspended_reason',
                           'reinstate_code_hash', 'reinstate_code_expires_at',
                           'reinstate_code_attempts');
    IF v_cols <> 6 THEN
        RAISE EXCEPTION '319: expected 6 suspension columns, found %', v_cols;
    END IF;

    -- Nobody may arrive already suspended. Existing inactive accounts were deactivated through
    -- the ordinary route and must stay distinguishable from an emergency stop, or the first
    -- report of "who did we cut off" would name every leaver since the platform started.
    SELECT count(*) INTO v_live FROM app.o3c_users WHERE suspended_at IS NOT NULL;
    IF v_live <> 0 THEN
        RAISE EXCEPTION '319: % account(s) are already marked suspended', v_live;
    END IF;

    RAISE NOTICE '319: suspension columns in place; no account is suspended.';
END
$m319$;

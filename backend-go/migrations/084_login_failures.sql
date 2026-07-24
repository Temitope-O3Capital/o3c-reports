-- Migration 084: Per-account login failure counter for lockout enforcement.
-- After 10 consecutive failures the account is blocked for 15 minutes.
-- The row is deleted on successful login so the counter is always "consecutive".

CREATE TABLE IF NOT EXISTS login_failures (
    user_id         BIGINT PRIMARY KEY REFERENCES o3c_users(id) ON DELETE CASCADE,
    failure_count   INT NOT NULL DEFAULT 1,
    last_failure_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

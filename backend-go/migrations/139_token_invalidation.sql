-- 139_token_invalidation.sql
-- Token revocation watermark: a password reset/change advances tokens_valid_from,
-- and AuthMiddleware + the refresh handler reject any token issued before it. This
-- makes password changes actually kill existing access + refresh tokens instead of
-- only deleting a user_sessions log row.
ALTER TABLE o3c_users ADD COLUMN IF NOT EXISTS tokens_valid_from timestamptz NOT NULL DEFAULT NOW();

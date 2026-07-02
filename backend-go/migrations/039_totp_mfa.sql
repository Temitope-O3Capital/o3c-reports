-- Migration 039: TOTP / MFA columns on o3c_users
-- Idempotent: uses IF NOT EXISTS throughout.

ALTER TABLE o3c_users ADD COLUMN IF NOT EXISTS totp_secret_encrypted TEXT;
ALTER TABLE o3c_users ADD COLUMN IF NOT EXISTS totp_enabled           BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE o3c_users ADD COLUMN IF NOT EXISTS totp_verified_at       TIMESTAMPTZ;

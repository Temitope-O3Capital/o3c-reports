-- Rollback for 022_termii_sms_credentials
-- Migration 022 inserted credential rows into api_credentials.
-- Remove only the Termii rows to avoid affecting other credentials.
DELETE FROM api_credentials WHERE key_name ILIKE 'TERMII%';

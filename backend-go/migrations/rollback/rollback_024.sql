-- Rollback for 024_voice_oauth_columns
ALTER TABLE o3c_users DROP COLUMN IF EXISTS zoho_voice_refresh_token;
ALTER TABLE o3c_users DROP COLUMN IF EXISTS zoho_voice_access_token;
ALTER TABLE o3c_users DROP COLUMN IF EXISTS zoho_voice_token_expiry;
ALTER TABLE o3c_users DROP COLUMN IF EXISTS zoho_voice_connected_at;

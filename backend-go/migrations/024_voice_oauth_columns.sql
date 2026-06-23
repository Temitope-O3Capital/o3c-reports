ALTER TABLE o3c_users ADD COLUMN IF NOT EXISTS zoho_voice_refresh_token TEXT;
ALTER TABLE o3c_users ADD COLUMN IF NOT EXISTS zoho_voice_access_token TEXT;
ALTER TABLE o3c_users ADD COLUMN IF NOT EXISTS zoho_voice_token_expiry TIMESTAMPTZ;
ALTER TABLE o3c_users ADD COLUMN IF NOT EXISTS zoho_voice_connected_at TIMESTAMPTZ;

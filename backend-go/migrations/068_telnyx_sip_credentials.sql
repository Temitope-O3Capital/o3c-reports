-- Telnyx SIP credentials per user (replaces Zoho Voice per-user OAuth)
ALTER TABLE o3c_users
  ADD COLUMN IF NOT EXISTS telnyx_sip_username    VARCHAR(255),
  ADD COLUMN IF NOT EXISTS telnyx_sip_password_enc TEXT;

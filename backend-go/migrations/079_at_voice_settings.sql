-- Seed Africa's Talking voice config keys into the settings table.
-- Values default to empty; admin fills them in via Settings → Call Center.
-- at_api_key is encrypted at rest (sensitiveSettingKey matches "api_key").
INSERT INTO settings (key, value) VALUES
  ('at_api_key',      ''),
  ('at_username',     ''),
  ('at_phone_number', ''),
  ('at_agent_mobile', '')
ON CONFLICT (key) DO NOTHING;

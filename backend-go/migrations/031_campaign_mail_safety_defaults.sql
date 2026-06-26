INSERT INTO settings (key, value)
VALUES
  ('campaign_send_delay_ms', '250'),
  ('campaign_daily_email_limit', '5000')
ON CONFLICT (key) DO NOTHING;

UPDATE settings
SET value='250', updated_at=NOW()
WHERE key='campaign_send_delay_ms' AND COALESCE(NULLIF(TRIM(value), ''), '0')='0';

UPDATE settings
SET value='5000', updated_at=NOW()
WHERE key='campaign_daily_email_limit' AND COALESCE(NULLIF(TRIM(value), ''), '0')='0';

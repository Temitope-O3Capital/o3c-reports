ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS pause_reason TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS paused_until TIMESTAMPTZ;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS dispatch_lock_until TIMESTAMPTZ;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS last_dispatch_error TEXT;

CREATE INDEX IF NOT EXISTS idx_campaigns_resume_paused
  ON campaigns(status, pause_reason, paused_until)
  WHERE status='paused';

CREATE INDEX IF NOT EXISTS idx_campaigns_dispatch_lock
  ON campaigns(dispatch_lock_until)
  WHERE dispatch_lock_until IS NOT NULL;

INSERT INTO settings (key, value)
VALUES
  ('campaign_per_campaign_daily_email_limit', '5000'),
  ('campaign_warmup_mode_enabled', 'true'),
  ('campaign_warmup_daily_email_limit', '1000')
ON CONFLICT (key) DO NOTHING;

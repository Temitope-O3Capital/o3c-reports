-- Rollback for 032_campaign_operational_safety
DROP INDEX IF EXISTS idx_campaigns_resume_paused;
ALTER TABLE campaigns DROP COLUMN IF EXISTS pause_reason;
ALTER TABLE campaigns DROP COLUMN IF EXISTS paused_until;
ALTER TABLE campaigns DROP COLUMN IF EXISTS dispatch_lock_until;
ALTER TABLE campaigns DROP COLUMN IF EXISTS last_dispatch_error;

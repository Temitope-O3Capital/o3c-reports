-- Rollback for 031_campaign_mail_safety_defaults
-- This migration only set DEFAULT values on existing columns — no new DDL.
-- Reversing defaults does not affect existing data.
ALTER TABLE campaigns ALTER COLUMN pause_on_bounce_rate DROP DEFAULT;
ALTER TABLE campaigns ALTER COLUMN max_hourly_rate DROP DEFAULT;
-- Add any other altered defaults from this migration here.

-- 157_agent_presence_heartbeat.sql
--
-- Agent presence gains a heartbeat. `helpdesk_status` (available/on_call/break/offline)
-- already exists and is set manually from the workspace. This adds `helpdesk_last_seen`
-- so presence can be automatic: the open workspace pings on a timer (refreshing this
-- column and bringing an offline agent back to available), and "online" is then
-- status='available' with a fresh heartbeat. A closed tab lets the heartbeat go stale,
-- so an agent auto-reads as offline for lead/queue distribution without any background job.

ALTER TABLE o3c_users ADD COLUMN IF NOT EXISTS helpdesk_last_seen timestamptz;

-- Partial index for the "who is online right now" lookup used by distribution.
CREATE INDEX IF NOT EXISTS idx_o3c_users_helpdesk_presence
  ON o3c_users (helpdesk_last_seen)
  WHERE helpdesk_status = 'available';

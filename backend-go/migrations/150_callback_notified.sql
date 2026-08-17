-- Records the moment the assigned agent was alerted that a scheduled call-back came
-- due, so the reminder worker fires the alert exactly once per callback (not every
-- minute while it stays due). NULL = not yet alerted.
ALTER TABLE call_center_contacts ADD COLUMN IF NOT EXISTS callback_notified_at timestamptz;

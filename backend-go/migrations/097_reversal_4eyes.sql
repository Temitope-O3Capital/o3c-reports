-- 097_reversal_4eyes — M39: 4-eyes control for manual posting reversals
-- The reversal flow now requires two people:
--   1. Finance Head requests reversal → status = 'pending_reversal', reversal_requested_by set
--   2. A different Finance Head / CFO / MD confirms → actual reversal executes

-- Extend the status CHECK to include 'pending_reversal'
ALTER TABLE manual_postings DROP CONSTRAINT IF EXISTS manual_postings_status_check;
ALTER TABLE manual_postings ADD CONSTRAINT manual_postings_status_check
    CHECK (status IN ('pending','approved','rejected','reversed','pending_reversal'));

-- Track who initiated the reversal request
ALTER TABLE manual_postings
    ADD COLUMN IF NOT EXISTS reversal_requested_by  BIGINT REFERENCES o3c_users(id),
    ADD COLUMN IF NOT EXISTS reversal_requested_at  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS reversal_reason        TEXT;

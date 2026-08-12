-- 145: Make a disposition mean something.
--
-- Before this, call_center_contacts.last_disposition was free text written by exactly
-- one caller (ccLogCall) and read by a filter. Across 14,709 contacts it was NULL on
-- every single row — not one disposition had ever been recorded, because agents dial
-- through the carrier and never return to the workspace to log an outcome. The queue
-- offered a vocabulary ("Answered-Interested", "Wrong Number", "PTP"…) hardcoded twice
-- in the React page, validated nowhere, and consequential nowhere: marking a number
-- "Wrong Number" left it in the queue to be dialled again.
--
-- This gives a disposition somewhere to go and something to do:
--   * disposition_code — the canonical code (handlers/call_center_dispositions.go is
--     the single source of truth; last_disposition keeps the human label for display).
--   * callback_at      — a "Callback" is a promise to ring back at a time, so store the
--                        time and let the queue serve it when due.
--   * status widened   — 'closed' (worked out: not interested / do-not-call) and
--                        'invalid' (wrong number) join 'pending'/'skipped', so a
--                        resolved contact actually leaves the queue.

ALTER TABLE call_center_contacts
  ADD COLUMN IF NOT EXISTS disposition_code text,
  ADD COLUMN IF NOT EXISTS callback_at      timestamptz;

COMMENT ON COLUMN call_center_contacts.disposition_code IS
  'Canonical disposition code (see ccDispositions in Go). last_disposition holds the label.';
COMMENT ON COLUMN call_center_contacts.callback_at IS
  'When the customer asked to be called back. Due callbacks are served first.';

-- Due callbacks are the highest-value rows in the queue and are scanned on every load.
CREATE INDEX IF NOT EXISTS idx_cc_contacts_callback
  ON call_center_contacts (callback_at)
  WHERE callback_at IS NOT NULL AND status = 'pending';

-- Guard the status vocabulary now that handlers move rows out of 'pending'. Written as
-- a NOT VALID add + VALIDATE so the existing 14,709 rows are checked without holding an
-- ACCESS EXCLUSIVE lock across the whole scan.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'call_center_contacts_status_chk') THEN
    ALTER TABLE call_center_contacts
      ADD CONSTRAINT call_center_contacts_status_chk
      CHECK (status IN ('pending','skipped','closed','invalid')) NOT VALID;
    ALTER TABLE call_center_contacts VALIDATE CONSTRAINT call_center_contacts_status_chk;
  END IF;
END $$;

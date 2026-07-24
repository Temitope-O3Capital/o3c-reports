-- R7: Prevent duplicate bureau submissions for the same month.
-- R8: Migration 082 lacked IF NOT EXISTS guards; this migration is idempotent.

ALTER TABLE bureau_submission_logs
  ADD COLUMN IF NOT EXISTS submitted_by_user_id BIGINT REFERENCES o3c_users(id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_bureau_submission_logs_month_bureau'
  ) THEN
    ALTER TABLE bureau_submission_logs
      ADD CONSTRAINT uq_bureau_submission_logs_month_bureau UNIQUE (month, bureau);
  END IF;
END $$;

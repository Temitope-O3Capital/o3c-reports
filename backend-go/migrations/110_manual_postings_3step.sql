-- Migration 110: 3-step manual-posting workflow (raise → approve → post).
-- The UI is built for a maker/approver/poster flow with a "return to maker"
-- transition, but the table only supported pending/approved/rejected and
-- approval also wrote the GL entry. This extends the model so posting is a
-- distinct, separately-audited step.

-- 1. Allow the new statuses.
ALTER TABLE manual_postings DROP CONSTRAINT IF EXISTS manual_postings_status_check;
ALTER TABLE manual_postings
    ADD CONSTRAINT manual_postings_status_check
    CHECK (status IN ('pending','approved','posted','rejected','returned','reversed'));

-- 2. Link a posting to the approval workflow chosen at creation.
ALTER TABLE manual_postings ADD COLUMN IF NOT EXISTS workflow_template_id BIGINT REFERENCES workflow_templates(id);

-- 3. Separate audit trail for the post and return steps (approve already had columns).
ALTER TABLE manual_postings ADD COLUMN IF NOT EXISTS posted_by        BIGINT REFERENCES o3c_users(id);
ALTER TABLE manual_postings ADD COLUMN IF NOT EXISTS posted_by_name   TEXT;
ALTER TABLE manual_postings ADD COLUMN IF NOT EXISTS posted_at        TIMESTAMPTZ;
ALTER TABLE manual_postings ADD COLUMN IF NOT EXISTS rejected_by      BIGINT REFERENCES o3c_users(id);
ALTER TABLE manual_postings ADD COLUMN IF NOT EXISTS rejected_by_name TEXT;
ALTER TABLE manual_postings ADD COLUMN IF NOT EXISTS rejected_at      TIMESTAMPTZ;
ALTER TABLE manual_postings ADD COLUMN IF NOT EXISTS returned_by      BIGINT REFERENCES o3c_users(id);
ALTER TABLE manual_postings ADD COLUMN IF NOT EXISTS returned_by_name TEXT;
ALTER TABLE manual_postings ADD COLUMN IF NOT EXISTS returned_at      TIMESTAMPTZ;
ALTER TABLE manual_postings ADD COLUMN IF NOT EXISTS return_reason    TEXT;

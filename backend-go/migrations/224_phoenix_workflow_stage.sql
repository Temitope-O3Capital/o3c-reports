-- Mirror Phoenix's customer-journey stage alongside our own approval stage.
--
-- The two systems track different halves of the same application. app.stage is the
-- INTERNAL approval chain — risk review, risk head, finance, booking. Phoenix's
-- workflow_stage is the CUSTOMER journey — offer sent, offer accepted, consent
-- completed, mandate completed, card created.
--
-- Neither is a substitute for the other, and the workspace held only its own. A file
-- parked at OFFER_SENT in Phoenix looked identical to one parked at
-- MANDATE_COMPLETED: both showed "Risk Review" here, because that is genuinely where
-- OUR chain had got to. Staff could see the application was not moving without being
-- able to see what it was waiting on.
--
-- Stored, not derived. It could be fetched live from the eye-decision endpoint on
-- every render, but a list of fifty applications would then make fifty calls to
-- Phoenix to draw one column, and the queue would be unusable whenever Phoenix was
-- slow. This is a mirror of a value Phoenix owns: it is written from Phoenix's own
-- events and reads are local.

BEGIN;

ALTER TABLE app.loan_applications
  -- Phoenix's CreditRequestWorkflowStage: SUBMITTED, DATA_ANALYSIS, CRC_CHECK,
  -- PREQUALIFIED, AUTO_APPROVED, MANUAL_REVIEW, OFFER_SENT, OFFER_ACCEPTED,
  -- CONSENT_COMPLETED, MANDATE_COMPLETED, CARD_CREATED, REJECTED, EXPIRED,
  -- EXCEPTION. Deliberately untyped: Phoenix may add stages, and a CHECK constraint
  -- here would reject a legitimate new one and fail the webhook that carried it.
  ADD COLUMN IF NOT EXISTS phoenix_stage text,
  -- Phoenix's CreditRequestStatus, which is a separate axis from the stage above:
  -- DRAFT, SUBMITTED, IN_REVIEW, APPROVED, ACTIVATED, DECLINED, WITHDRAWN.
  ADD COLUMN IF NOT EXISTS phoenix_status text,
  ADD COLUMN IF NOT EXISTS phoenix_stage_at timestamptz;

COMMENT ON COLUMN app.loan_applications.phoenix_stage IS
  'Mirror of Phoenix credit_requests.workflow_stage — the customer journey. Owned by Phoenix; written from its events. Distinct from app.stage, which is our internal approval chain.';

CREATE INDEX IF NOT EXISTS idx_loan_applications_phoenix_stage
  ON app.loan_applications (phoenix_stage)
  WHERE phoenix_stage IS NOT NULL;

COMMIT;

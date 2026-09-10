-- One response per invitation. Defense-in-depth behind the row-lock in the submit
-- handler: even a race that slipped past the lock can't record two responses for
-- the same send. Anonymous/direct responses (send_id NULL) are unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS uq_survey_responses_send
  ON survey_responses(send_id) WHERE send_id IS NOT NULL;

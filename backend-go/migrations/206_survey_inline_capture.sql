-- In-email answer capture.
--
-- Customers can now answer the headline rating questions by tapping a number in
-- the email itself. The tap carries the answer to the public page, which records
-- it immediately (POST /r/{token}/capture) and lets them complete the rest. The
-- click-capture and the final page submit write to the SAME response row per
-- send, so a headline answer is durable even if the survey is never finished.
--
-- All DDL is idempotent.

-- One answer row per (response, question) so capture and submit can upsert
-- (ON CONFLICT) instead of inserting duplicates. De-dup any existing rows first
-- (keep the most recent), then add the constraint.
DELETE FROM survey_answers a
  USING survey_answers b
  WHERE a.response_id = b.response_id
    AND a.question_id = b.question_id
    AND a.id < b.id;
CREATE UNIQUE INDEX IF NOT EXISTS uq_survey_answers_resp_q ON survey_answers(response_id, question_id);

-- Distinguish a fully-completed response from a partial one captured in the
-- email. submitted_at = first touch; completed_at = they finished the whole
-- survey on the page (NULL = answered in the email but not completed).
ALTER TABLE survey_responses ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE survey_responses ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'page'; -- page | email

-- Every response that exists today came through the full page submit, so mark
-- them completed.
UPDATE survey_responses SET completed_at = submitted_at WHERE completed_at IS NULL;

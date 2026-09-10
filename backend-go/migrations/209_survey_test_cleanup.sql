-- Clean house after the in-email survey test sends. Removes the throwaway test
-- send rows (and any response/answer rows tied to them) and restores the seeded
-- Card Services survey to its pre-test state ('closed'). Idempotent.
--
-- NOTE: settings.app_base_url is intentionally LEFT set — it was blank before and
-- is genuinely required for the survey/CSAT link system to work; that's a real
-- fix, not test debris. Blank it manually only if you want the pristine original.

-- Drop answers, then responses, then the test sends themselves.
DELETE FROM survey_answers
WHERE response_id IN (
  SELECT r.id FROM survey_responses r
  JOIN survey_sends s ON s.id = r.send_id
  WHERE s.batch_id IN ('test-inline-20260908', 'test-inline-2')
);
DELETE FROM survey_responses
WHERE send_id IN (
  SELECT id FROM survey_sends WHERE batch_id IN ('test-inline-20260908', 'test-inline-2')
);
DELETE FROM survey_sends WHERE batch_id IN ('test-inline-20260908', 'test-inline-2');

-- Restore the seeded survey to how it was found before testing.
UPDATE surveys SET status = 'closed', updated_at = NOW()
WHERE category = 'card_services' AND status = 'active';

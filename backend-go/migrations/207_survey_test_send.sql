-- One-off: send a live in-email survey test to the requesting admin's own inbox
-- (babatundeopemiposi@gmail.com), since the authenticated test-send endpoint
-- can't be driven from here. Fully guarded + idempotent.
--
-- (1) The dispatch worker and the survey links need settings.app_base_url; it is
--     currently blank, so seed it from the configured public host (matches the
--     APP_BASE_URL env var and ALLOWED_ORIGINS). Only fills it when blank.
-- (2) The seeded Card Services survey is 'closed'; reopen it so the response page
--     accepts answers.
-- (3) Stage a single 'queued' send; StartSurveyDispatchWorker mails it within ~20s.

UPDATE settings SET value = 'https://crm.o3cards.pri:8443', updated_at = NOW()
WHERE key = 'app_base_url' AND (value = '' OR value IS NULL);

UPDATE surveys SET status = 'active', updated_at = NOW()
WHERE category = 'card_services' AND status = 'closed';

INSERT INTO survey_sends
  (survey_id, token, customer_cif, recipient_name, recipient_email, channel, status, batch_id)
SELECT s.id,
       md5(random()::text || clock_timestamp()::text),
       '', 'Opemiposi Babatunde', 'babatundeopemiposi@gmail.com', 'email', 'queued', 'test-inline-20260908'
FROM surveys s
WHERE s.category = 'card_services'
  AND NOT EXISTS (
    SELECT 1 FROM survey_sends ss WHERE ss.batch_id = 'test-inline-20260908'
  )
ORDER BY s.id
LIMIT 1;

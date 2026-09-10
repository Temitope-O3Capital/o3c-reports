-- Resend the in-email survey test to babatundeopemiposi@gmail.com now that the
-- address has been removed from SendGrid's global unsubscribe list. Fresh token
-- + batch id; guarded so it stages exactly one queued send. The dispatch worker
-- mails it within ~20s (survey is already active, app_base_url already set).
INSERT INTO survey_sends
  (survey_id, token, customer_cif, recipient_name, recipient_email, channel, status, batch_id)
SELECT s.id,
       md5(random()::text || clock_timestamp()::text),
       '', 'Opemiposi Babatunde', 'babatundeopemiposi@gmail.com', 'email', 'queued', 'test-inline-2'
FROM surveys s
WHERE s.category = 'card_services'
  AND NOT EXISTS (
    SELECT 1 FROM survey_sends ss WHERE ss.batch_id = 'test-inline-2'
  )
ORDER BY s.id
LIMIT 1;

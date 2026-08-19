-- 173_not_ready_is_not_a_callback.sql
--
-- "Not Ready Yet" was routed to the callback status, so leads nobody had promised
-- to ring back filled the callback queue and buried the ones who had. 9 of the 16
-- leads sitting in callback got there this way, against 6 real ones.
--
-- The rule is fixed in leadStatusFromCall; this re-derives the leads it already
-- mislabelled. They move to 'called' — contacted, still workable, re-approached in
-- a later cycle — and lose the callback time they never actually asked for.
--
-- Naturally idempotent: it selects on the state it removes, so a second run
-- matches nothing. No sentinel needed.

UPDATE app.call_center_leads l
   SET status = 'called',
       callback_at = NULL,
       updated_at = NOW()
 WHERE l.status = 'callback'
   AND (SELECT lower(TRIM(d.outcome)) FROM app.call_center_dispositions d
         WHERE d.lead_id = l.id ORDER BY d.created_at DESC LIMIT 1) = 'not ready yet';

-- Rollback 320: back to one arrears template for every borrower.
--
-- Reverses an intention (escalating copy by debt age) rather than a defect, so it is
-- worth having. Run it if the escalation reads wrong to Collections and the gentle
-- wording should go back to everyone while it is rewritten.
--
-- NOTE ON THE DELETE. app.dunning_sends.template_id is ON DELETE SET NULL, so removing
-- these five drops the link from any reminder already logged against them. The message
-- body itself is copied into dunning_sends at send time and is not lost, so the review
-- page still shows exactly what each borrower was sent. Only the pointer goes.
--
-- The currency literal is deliberately NOT restored. dunningAmount supplies the sign
-- per channel, and putting "N" back in front of {{amount}} would render "N₦100,000.00".
-- If you are reverting the Go change too, add the N back by hand.

BEGIN;

DELETE FROM app.message_templates
 WHERE category = 'collections'
   AND name IN (
     'Arrears Reminder · 31-60 Days',
     'Arrears Reminder · 61-90 Days',
     'Arrears Reminder · 91-180 Days',
     'Arrears Reminder · 181-360 Days',
     'Arrears Reminder · 360+ Days'
   );

COMMIT;

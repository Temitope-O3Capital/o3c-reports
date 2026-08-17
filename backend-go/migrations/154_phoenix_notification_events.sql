-- 154_phoenix_notification_events.sql
--
-- Registers the two Phoenix events in notification_event_config.
--
-- Notify() defaults an unconfigured event_type to in-app + email ON, so these would
-- fire regardless. The reason to register them is the other direction: an event with
-- no config row does not appear in Admin → Notification Settings, so nobody can turn
-- it down. A decision alert that cannot be tuned is how alert fatigue starts, and
-- this platform has been there before (one ticket event produced 4,133 notifications
-- for two people).
--
-- sms/whatsapp stay off — they cost money and reach people out of hours. They can be
-- switched on per event from the admin screen once the volume is understood.

BEGIN;

INSERT INTO notification_event_config (event_type, channel, enabled, label, description) VALUES
  ('loan_application_received', 'in_app', TRUE,
   'Application received from Phoenix',
   'A new application originated in Phoenix and has landed in the risk queue. Grouped, so a batch push is one alert rather than one per application.'),
  ('loan_application_received', 'email', FALSE,
   'Application received from Phoenix',
   'Email copy of the new-application alert. Off by default — the in-app digest is enough for a queue that is checked continuously.'),
  ('loan_application_received', 'sms', FALSE,
   'Application received from Phoenix', 'SMS copy. Off by default.'),
  ('loan_application_received', 'whatsapp', FALSE,
   'Application received from Phoenix', 'WhatsApp copy. Off by default.'),

  ('loan_decision_received', 'in_app', TRUE,
   'Credit decision received',
   'Phoenix returned a decision on an application you are carrying. Declines and referrals are raised at high priority.'),
  ('loan_decision_received', 'email', TRUE,
   'Credit decision received',
   'Email copy of the decision alert. On by default — a decision is the event the reviewer is waiting for and is not high volume.'),
  ('loan_decision_received', 'sms', FALSE,
   'Credit decision received', 'SMS copy. Off by default.'),
  ('loan_decision_received', 'whatsapp', FALSE,
   'Credit decision received', 'WhatsApp copy. Off by default.')
ON CONFLICT (event_type, channel) DO NOTHING;

COMMIT;

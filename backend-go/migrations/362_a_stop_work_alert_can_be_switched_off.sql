-- The stop-work alert joins the switchboard.
--
-- Migration 356 registered every event the app sends in app.notification_event_config so
-- each one appears on the notification settings screen and can be turned off. An event
-- that is not registered still delivers, on role defaults, but it is invisible there -
-- which is how the app ended up with 38 alerts nobody could switch off.
--
-- cc_lead_declined_after_handoff is new in the same work as migration 361: when the call
-- centre declines a lead a sales officer is already working, that officer is told to
-- stop. Registering it here keeps the rule 356 established - every alert is listed, and
-- every alert can be turned off - true for the one added after it.
--
-- Both channels enabled. In-app because the officer may be mid-queue, email because the
-- thing being prevented is a wasted journey to a customer we have already refused, and a
-- field officer reads mail on a phone.

INSERT INTO app.notification_event_config (event_type, channel, enabled, label, description)
SELECT e.event_type, ch.channel, TRUE, e.label, e.description
  FROM (VALUES
    ('cc_lead_declined_after_handoff', 'Lead Declined After Hand-Off',
     'The call centre declined a lead after it was handed to you. Tells you to stop work before the visit.')
  ) AS e(event_type, label, description)
  CROSS JOIN (VALUES ('in_app'), ('email')) AS ch(channel)
ON CONFLICT DO NOTHING;

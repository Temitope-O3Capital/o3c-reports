-- Migration 159: silence SLA ticket alerts on email — keep them in-app only.
--
-- The SLA monitor (StartSLABreachMonitor, handlers/helpdesk.go) fires a "warning"
-- 30 minutes before a ticket's deadline and a "breach" alert at the deadline.
-- Email was ON for both: ticket_sla_warning never had an email config row so it
-- rode the code default (email=true), and migration 125 reaffirmed email globally.
-- Combined with NotifyRoles always copying admins, leaders' inboxes filled with
-- "SLA warning: TKT-xxxx" mail as the email helpdesk backlog aged past SLA all day.
--
-- Per request: both SLA alerts now live in the in-app notification bell only. The
-- Notify() resolver reads these per-channel rows and disables email accordingly;
-- in-app stays on so agents and supervisors still see the alerts in the app.
-- A user who explicitly opts back into email (notification_preferences) is
-- unaffected — this only changes the global default.

-- Note: ticket_sla_breach also carried an sms row enabled=TRUE (see notify.go —
-- one of the channels "switched on and never noticed"). "In-app only" means SMS
-- and WhatsApp off too, so we force every non-in_app channel to FALSE here.
INSERT INTO notification_event_config (event_type, channel, enabled, label, description) VALUES
  ('ticket_sla_warning', 'in_app',   TRUE,  'SLA Warning',  'Ticket within 30 minutes of its SLA deadline'),
  ('ticket_sla_warning', 'email',    FALSE, 'SLA Warning',  'Ticket within 30 minutes of its SLA deadline'),
  ('ticket_sla_warning', 'sms',      FALSE, 'SLA Warning',  'Ticket within 30 minutes of its SLA deadline'),
  ('ticket_sla_warning', 'whatsapp', FALSE, 'SLA Warning',  'Ticket within 30 minutes of its SLA deadline'),
  ('ticket_sla_breach',  'in_app',   TRUE,  'SLA Breached', 'Ticket has passed its SLA deadline'),
  ('ticket_sla_breach',  'email',    FALSE, 'SLA Breached', 'Ticket has passed its SLA deadline'),
  ('ticket_sla_breach',  'sms',      FALSE, 'SLA Breached', 'Ticket has passed its SLA deadline'),
  ('ticket_sla_breach',  'whatsapp', FALSE, 'SLA Breached', 'Ticket has passed its SLA deadline')
ON CONFLICT (event_type, channel)
DO UPDATE SET enabled = EXCLUDED.enabled;

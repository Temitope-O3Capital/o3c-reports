-- Migration 165: stop the notification EMAIL flood — keep these operational alerts
-- in-app only.
--
-- Investigation (2026-08-18): ~89 "Ticket assigned to you" emails in 24h (plus the
-- unassigned-tickets digest and call-back-due) were flooding inboxes, because email is
-- ON for these events and NotifyRoles always copies admins. The SLA warning/breach
-- emails were already switched to in-app only (migration 159) and have not sent since.
-- These ticket/call-back events are high-volume operational signals the in-app bell
-- handles fine; email adds noise, not value. Email-worthy, low-volume events (loan
-- decisions, SAR/AML, system alerts, FD maturities, etc.) are left ON.
--
-- Notify() reads notification_event_config live, so this takes effect immediately.

INSERT INTO notification_event_config (event_type, channel, enabled, label, description) VALUES
    ('ticket_assigned',         'in_app', TRUE,  'Ticket Assigned',    'A ticket was assigned to you'),
    ('ticket_assigned',         'email',  FALSE, 'Ticket Assigned',    'A ticket was assigned to you'),
    ('ticket_replied',          'in_app', TRUE,  'Ticket Replied',     'A customer replied on a ticket'),
    ('ticket_replied',          'email',  FALSE, 'Ticket Replied',     'A customer replied on a ticket'),
    ('ticket_unassigned_alert', 'in_app', TRUE,  'Unassigned Tickets', 'Unowned tickets waiting to be picked up'),
    ('ticket_unassigned_alert', 'email',  FALSE, 'Unassigned Tickets', 'Unowned tickets waiting to be picked up'),
    ('callback_due',            'in_app', TRUE,  'Call-back Due',       'A scheduled call-back is due'),
    ('callback_due',            'email',  FALSE, 'Call-back Due',       'A scheduled call-back is due'),
    -- Re-assert the SLA events as in-app only (already set by migration 159).
    ('ticket_sla_warning',      'email',  FALSE, 'SLA Warning',  'Ticket within 30 minutes of its SLA deadline'),
    ('ticket_sla_breach',       'email',  FALSE, 'SLA Breached', 'Ticket has passed its SLA deadline')
ON CONFLICT (event_type, channel) DO UPDATE SET enabled = EXCLUDED.enabled;

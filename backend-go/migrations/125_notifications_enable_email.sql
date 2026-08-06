-- Turn on both in-app and email for all notification events.
--
-- Requested: staff should receive notifications on both channels. Email was
-- enabled for most events already (29/32); this switches on the remaining ones
-- (birthday_today, deal_stage_changed, ptp_due_today) and re-affirms in_app.
-- The code default in notify.go is also now in_app+email ON, so any event that
-- lacks an explicit config row (e.g. new_account_created, ticket_sla_warning)
-- emails too. Admins can still mute a noisy event per-channel in
-- Admin → Notification Settings.
UPDATE notification_event_config SET enabled = TRUE WHERE channel IN ('email', 'in_app');

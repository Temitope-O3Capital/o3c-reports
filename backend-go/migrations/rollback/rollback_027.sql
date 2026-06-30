-- Rollback for 027_zoho_webhook_events
DROP INDEX IF EXISTS idx_zoho_webhook_events_created;
DROP INDEX IF EXISTS idx_zoho_webhook_events_ticket;
DROP TABLE IF EXISTS zoho_webhook_events;

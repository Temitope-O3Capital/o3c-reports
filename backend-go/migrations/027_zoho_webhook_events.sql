-- Migration 027: Zoho webhook delivery monitor

CREATE TABLE IF NOT EXISTS zoho_webhook_events (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL DEFAULT '',
  zoho_ticket_id TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'received',
  detail TEXT NOT NULL DEFAULT '',
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zoho_webhook_events_created
    ON zoho_webhook_events(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_zoho_webhook_events_ticket
    ON zoho_webhook_events(zoho_ticket_id, created_at DESC);

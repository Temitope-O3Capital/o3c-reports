-- 140: Raw audit log of inbound Zoho Event Webhook POSTs. The webhook is a trigger,
-- not the source of truth — we persist the raw payload for observability/debugging
-- and immediately run a bounded incremental sync. Referenced by the (previously
-- unused) zoho_webhook_events name; created here for the real-time webhook path.

CREATE TABLE IF NOT EXISTS zoho_webhook_events (
  id           bigserial PRIMARY KEY,
  event_type   text,
  raw          jsonb,
  received_at  timestamptz NOT NULL DEFAULT NOW(),
  processed_at timestamptz
);

-- A table named zoho_webhook_events pre-existed in some environments with a
-- different shape (payload/created_at, no received_at), so CREATE TABLE IF NOT
-- EXISTS above is a no-op there. Ensure the columns this feature needs exist
-- before indexing, making the migration safe on both fresh and legacy schemas.
ALTER TABLE zoho_webhook_events ADD COLUMN IF NOT EXISTS raw          jsonb;
ALTER TABLE zoho_webhook_events ADD COLUMN IF NOT EXISTS received_at  timestamptz NOT NULL DEFAULT NOW();
ALTER TABLE zoho_webhook_events ADD COLUMN IF NOT EXISTS processed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_zoho_webhook_events_received ON zoho_webhook_events(received_at DESC);

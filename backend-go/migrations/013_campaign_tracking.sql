-- 013_campaign_tracking

-- Campaign tracking columns (per-campaign delivery metrics)
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS sent_count        INT DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS delivered_count   INT DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS open_count        INT DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS click_count       INT DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS bounce_count      INT DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS unsubscribe_count INT DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS sendgrid_batch_id TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS termii_message_id TEXT;

-- Per-recipient event tracking
CREATE TABLE IF NOT EXISTS campaign_events (
    id              BIGSERIAL PRIMARY KEY,
    campaign_id     BIGINT REFERENCES campaigns(id) ON DELETE CASCADE,
    recipient_email TEXT,
    recipient_phone TEXT,
    event_type      TEXT NOT NULL,  -- 'sent','delivered','opened','clicked','bounced','unsubscribed','failed'
    event_data      JSONB,
    occurred_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_campaign_events_campaign_id ON campaign_events(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_events_type        ON campaign_events(event_type);

-- Customer service interaction log
CREATE TABLE IF NOT EXISTS cs_interactions (
    id               BIGSERIAL PRIMARY KEY,
    cif_number       TEXT,
    agent_id         BIGINT REFERENCES users(id),
    call_type        TEXT,   -- 'inbound' | 'outbound'
    duration_seconds INT,
    outcome          TEXT,   -- 'resolved' | 'escalated' | 'callback' | 'no_answer'
    notes            TEXT,
    status           TEXT DEFAULT 'closed',  -- 'open' | 'closed' | 'escalated'
    resolved_at      TIMESTAMPTZ,
    created_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cs_interactions_cif     ON cs_interactions(cif_number);
CREATE INDEX IF NOT EXISTS idx_cs_interactions_agent   ON cs_interactions(agent_id);
CREATE INDEX IF NOT EXISTS idx_cs_interactions_created ON cs_interactions(created_at DESC);

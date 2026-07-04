-- Migration 050: Predictive dialer tables
-- Supports campaign-based auto-dialing engine with Zoho Voice integration

CREATE TABLE IF NOT EXISTS dialer_campaigns (
    id                  BIGSERIAL PRIMARY KEY,
    name                TEXT NOT NULL,
    description         TEXT,
    status              TEXT NOT NULL DEFAULT 'draft',  -- draft | active | paused | completed
    dial_ratio          NUMERIC(3,1) NOT NULL DEFAULT 1.5,
    max_abandonment_pct NUMERIC(4,1) NOT NULL DEFAULT 3.0,
    caller_id           TEXT,
    max_attempts        INT NOT NULL DEFAULT 3,
    retry_delay_minutes INT NOT NULL DEFAULT 60,
    schedule_start      TIME,
    schedule_end        TIME,
    created_by          BIGINT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dialer_queue (
    id              BIGSERIAL PRIMARY KEY,
    campaign_id     BIGINT NOT NULL REFERENCES dialer_campaigns(id) ON DELETE CASCADE,
    phone           TEXT NOT NULL,
    customer_name   TEXT,
    cif             TEXT,
    metadata        JSONB NOT NULL DEFAULT '{}',
    priority        INT NOT NULL DEFAULT 5,
    attempts        INT NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'pending',  -- pending | dialing | connected | completed | failed | dnc
    last_attempt_at TIMESTAMPTZ,
    next_attempt_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dialer_queue_campaign ON dialer_queue(campaign_id, status, priority, next_attempt_at);

CREATE TABLE IF NOT EXISTS dialer_sessions (
    id             BIGSERIAL PRIMARY KEY,
    campaign_id    BIGINT REFERENCES dialer_campaigns(id) ON DELETE SET NULL,
    agent_user_id  BIGINT NOT NULL,
    agent_name     TEXT,
    status         TEXT NOT NULL DEFAULT 'ready',  -- ready | on_call | paused | offline
    calls_made     INT NOT NULL DEFAULT 0,
    calls_answered INT NOT NULL DEFAULT 0,
    joined_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dialer_sessions_agent ON dialer_sessions(agent_user_id, status);

CREATE TABLE IF NOT EXISTS dialer_call_logs (
    id               BIGSERIAL PRIMARY KEY,
    campaign_id      BIGINT NOT NULL REFERENCES dialer_campaigns(id),
    queue_entry_id   BIGINT REFERENCES dialer_queue(id) ON DELETE SET NULL,
    agent_user_id    BIGINT,
    agent_name       TEXT,
    phone            TEXT NOT NULL,
    call_state       TEXT NOT NULL DEFAULT 'dialing',  -- dialing | ringing | answered | abandoned | voicemail | failed | busy | no_answer
    zoho_call_id     TEXT,
    started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    answered_at      TIMESTAMPTZ,
    ended_at         TIMESTAMPTZ,
    duration_sec     INT NOT NULL DEFAULT 0,
    disposition      TEXT,  -- interested | callback | not_interested | wrong_number | dnc
    notes            TEXT,
    is_abandoned     BOOL NOT NULL DEFAULT false,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dialer_call_logs_campaign ON dialer_call_logs(campaign_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dialer_call_logs_zoho ON dialer_call_logs(zoho_call_id) WHERE zoho_call_id IS NOT NULL;

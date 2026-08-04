-- Multi-step scheduled campaigns (sequence / send-calendar).
--
-- A sequence campaign has an ordered list of steps; each step sends a saved
-- template on a given channel at a time defined either as a day-offset from
-- launch or an absolute date/time. The campaign stays active until the last
-- step has sent (it no longer closes after a single send).

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS is_sequence BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS campaign_steps (
    id             BIGSERIAL PRIMARY KEY,
    campaign_id    BIGINT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    step_no        INTEGER NOT NULL DEFAULT 1,
    channel        TEXT NOT NULL,                       -- email | sms | whatsapp
    template_id    BIGINT REFERENCES message_templates(id) ON DELETE SET NULL,
    schedule_mode  TEXT NOT NULL DEFAULT 'offset',      -- offset | absolute
    offset_days    INTEGER NOT NULL DEFAULT 0,          -- days after launch (offset mode)
    send_at        TIMESTAMPTZ,                         -- absolute time (absolute mode)
    -- runtime
    status         TEXT NOT NULL DEFAULT 'pending',     -- pending | sending | sent | skipped
    scheduled_for  TIMESTAMPTZ,                         -- resolved fire time (set at launch)
    sent_at        TIMESTAMPTZ,
    sent_count     INTEGER NOT NULL DEFAULT 0,
    failed_count   INTEGER NOT NULL DEFAULT 0,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaign_steps_campaign ON campaign_steps(campaign_id, step_no);
CREATE INDEX IF NOT EXISTS idx_campaign_steps_due ON campaign_steps(status, scheduled_for);

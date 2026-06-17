-- Notification tables

CREATE TABLE IF NOT EXISTS notifications (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT NOT NULL,
    type        TEXT NOT NULL,
    title       TEXT NOT NULL,
    body        TEXT NOT NULL,
    entity_type TEXT,
    entity_id   BIGINT,
    is_read     BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notif_user   ON notifications(user_id, is_read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_entity ON notifications(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS notification_preferences (
    id         SERIAL PRIMARY KEY,
    user_id    BIGINT NOT NULL,
    event_type TEXT   NOT NULL,
    channels   JSONB  NOT NULL DEFAULT '{"in_app":true,"sms":false,"email":false}',
    is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (user_id, event_type)
);

CREATE TABLE IF NOT EXISTS notification_defaults (
    id         SERIAL PRIMARY KEY,
    role       TEXT   NOT NULL,
    event_type TEXT   NOT NULL,
    channels   JSONB  NOT NULL DEFAULT '{"in_app":true,"sms":false,"email":false}',
    is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (role, event_type)
);

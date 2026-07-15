CREATE TABLE IF NOT EXISTS notification_preferences (
    user_id    BIGINT NOT NULL REFERENCES o3c_users(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    channel    TEXT NOT NULL CHECK (channel IN ('in_app', 'email', 'sms')),
    enabled    BOOLEAN NOT NULL DEFAULT true,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, event_type, channel)
);

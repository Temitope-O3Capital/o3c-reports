-- Cryptographically random OAuth state nonces for Zoho Voice CSRF protection
CREATE TABLE IF NOT EXISTS voice_oauth_states (
    nonce      TEXT        PRIMARY KEY,
    user_id    BIGINT      NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '10 minutes')
);

CREATE INDEX IF NOT EXISTS idx_voice_oauth_states_expires
    ON voice_oauth_states (expires_at);

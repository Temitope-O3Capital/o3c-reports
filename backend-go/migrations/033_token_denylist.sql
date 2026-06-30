-- Token revocation denylist — enables server-side logout
CREATE TABLE IF NOT EXISTS token_denylists (
    jti        TEXT        PRIMARY KEY,
    user_id    BIGINT,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_token_denylists_expires
    ON token_denylists (expires_at);

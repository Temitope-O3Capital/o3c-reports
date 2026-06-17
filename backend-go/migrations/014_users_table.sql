-- Ensure o3c_users table exists (may have been created outside migrations)
CREATE TABLE IF NOT EXISTS o3c_users (
    id                  BIGSERIAL PRIMARY KEY,
    email               TEXT        NOT NULL UNIQUE,
    password_hash       TEXT        NOT NULL,
    full_name           TEXT        NOT NULL DEFAULT '',
    first_name          TEXT        NOT NULL DEFAULT '',
    last_name           TEXT        NOT NULL DEFAULT '',
    role                TEXT        NOT NULL DEFAULT 'staff',
    department          TEXT,
    phone               TEXT,
    is_active           BOOLEAN     NOT NULL DEFAULT TRUE,
    must_change_password BOOLEAN    NOT NULL DEFAULT TRUE,
    last_login          TIMESTAMPTZ,
    deleted_at          TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_o3c_users_email ON o3c_users(email);
CREATE INDEX IF NOT EXISTS idx_o3c_users_role  ON o3c_users(role);

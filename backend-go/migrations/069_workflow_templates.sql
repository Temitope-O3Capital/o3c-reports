CREATE TABLE IF NOT EXISTS workflow_templates (
    id              BIGSERIAL PRIMARY KEY,
    name            TEXT        NOT NULL,
    description     TEXT        NOT NULL DEFAULT '',
    notify_roles    TEXT[]      NOT NULL DEFAULT '{}',
    approver_roles  TEXT[]      NOT NULL DEFAULT '{}',
    poster_roles    TEXT[]      NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

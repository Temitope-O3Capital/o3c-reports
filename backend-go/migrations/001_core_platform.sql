-- Core platform tables: users, departments, grade levels, settings, sync status

-- o3c_users must exist here, not in 014: migrations 012 and 013 declare foreign
-- keys against it and run first. Production never hit this because these tables
-- predate the migration runner and were seeded as already-applied -- but a fresh
-- database (new env, disaster recovery, local dev) could not bootstrap without it.
-- 014 keeps its own IF NOT EXISTS copy, so both orders remain safe.
CREATE TABLE IF NOT EXISTS o3c_users (
    id                   BIGSERIAL PRIMARY KEY,
    email                TEXT        NOT NULL UNIQUE,
    password_hash        TEXT        NOT NULL,
    full_name            TEXT        NOT NULL DEFAULT '',
    first_name           TEXT        NOT NULL DEFAULT '',
    last_name            TEXT        NOT NULL DEFAULT '',
    role                 TEXT        NOT NULL DEFAULT 'staff',
    department           TEXT,
    phone                TEXT,
    is_active            BOOLEAN     NOT NULL DEFAULT TRUE,
    must_change_password BOOLEAN     NOT NULL DEFAULT TRUE,
    last_login           TIMESTAMPTZ,
    deleted_at           TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS departments (
    id         SERIAL PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    code       TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO departments (name, code) VALUES
    ('Finance', 'FIN'),
    ('Sales', 'SAL'),
    ('Risk', 'RSK'),
    ('Cards Operations', 'CRD'),
    ('Collections', 'COL'),
    ('Recovery', 'REC'),
    ('Call Center', 'CCA'),
    ('Human Resources', 'HHR'),
    ('Compliance', 'CMP'),
    ('Internal Control', 'ICT'),
    ('IT', 'ITT'),
    ('Executive', 'EXC')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS grade_levels (
    id              SERIAL PRIMARY KEY,
    name            TEXT NOT NULL UNIQUE,
    level_number    INT  NOT NULL,
    min_salary_kobo BIGINT NOT NULL DEFAULT 0,
    max_salary_kobo BIGINT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public_holidays (
    id         SERIAL PRIMARY KEY,
    name       TEXT NOT NULL,
    date       DATE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL DEFAULT '',
    updated_by BIGINT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO settings (key, value) VALUES
    ('storage_provider', 'r2'),
    ('r2_bucket', ''),
    ('r2_account_id', ''),
    ('r2_access_key_id', ''),
    ('r2_secret_access_key', ''),
    ('sharepoint_site_url', ''),
    ('sharepoint_client_id', ''),
    ('sharepoint_client_secret', ''),
    ('termii_api_key', ''),
    ('termii_sender_id', 'O3C Cards'),
    ('notification_sms_enabled', 'false'),
    ('notification_email_enabled', 'true')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS sync_engine_status (
    id          SERIAL PRIMARY KEY,
    started_at  TIMESTAMPTZ NOT NULL,
    finished_at TIMESTAMPTZ,
    status      TEXT NOT NULL DEFAULT 'running',
    rows_synced INT  NOT NULL DEFAULT 0,
    error_msg   TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

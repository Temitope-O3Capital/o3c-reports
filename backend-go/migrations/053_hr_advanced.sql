-- Migration 053: HR Advanced (Wave 5J)

-- Job openings
CREATE TABLE IF NOT EXISTS hr_jobs (
    id              BIGSERIAL PRIMARY KEY,
    title           TEXT        NOT NULL,
    department      TEXT        NOT NULL,
    location        TEXT        NOT NULL DEFAULT 'Lagos',
    job_type        TEXT        NOT NULL DEFAULT 'full_time', -- full_time | contract | intern
    status          TEXT        NOT NULL DEFAULT 'open',      -- open | paused | closed | filled
    description     TEXT        NOT NULL DEFAULT '',
    min_salary_kobo BIGINT,
    max_salary_kobo BIGINT,
    target_date     DATE,
    created_by      BIGINT       REFERENCES o3c_users(id),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Applicants / ATS pipeline
CREATE TABLE IF NOT EXISTS hr_applicants (
    id              BIGSERIAL PRIMARY KEY,
    job_id          BIGINT       NOT NULL REFERENCES hr_jobs(id) ON DELETE CASCADE,
    full_name       TEXT         NOT NULL,
    email           TEXT         NOT NULL,
    phone           TEXT,
    source          TEXT         NOT NULL DEFAULT 'direct', -- direct | referral | linkedin | agency | website
    stage           TEXT         NOT NULL DEFAULT 'applied', -- applied | screened | interview | offer | hired | rejected
    notes           TEXT         NOT NULL DEFAULT '',
    resume_url      TEXT,
    assigned_to     BIGINT       REFERENCES o3c_users(id),
    interview_date  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Onboarding checklists (auto-created for each new hire)
CREATE TABLE IF NOT EXISTS hr_onboarding_items (
    id              BIGSERIAL PRIMARY KEY,
    employee_id     BIGINT       NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    category        TEXT         NOT NULL DEFAULT 'general', -- it_setup | compliance | hr | finance | general
    task            TEXT         NOT NULL,
    status          TEXT         NOT NULL DEFAULT 'pending', -- pending | done | skipped
    due_date        DATE,
    assigned_to     BIGINT       REFERENCES o3c_users(id),
    completed_at    TIMESTAMPTZ,
    notes           TEXT         NOT NULL DEFAULT '',
    sort_order      INT          NOT NULL DEFAULT 0
);

-- Offboarding checklists
CREATE TABLE IF NOT EXISTS hr_offboarding_items (
    id              BIGSERIAL PRIMARY KEY,
    employee_id     BIGINT       NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    category        TEXT         NOT NULL DEFAULT 'general',
    task            TEXT         NOT NULL,
    status          TEXT         NOT NULL DEFAULT 'pending',
    due_date        DATE,
    assigned_to     BIGINT       REFERENCES o3c_users(id),
    completed_at    TIMESTAMPTZ,
    notes           TEXT         NOT NULL DEFAULT '',
    sort_order      INT          NOT NULL DEFAULT 0
);

-- Exit records
CREATE TABLE IF NOT EXISTS hr_exits (
    id              BIGSERIAL PRIMARY KEY,
    employee_id     BIGINT       NOT NULL REFERENCES employees(id),
    exit_type       TEXT         NOT NULL DEFAULT 'resignation', -- resignation | termination | retirement | redundancy
    exit_date       DATE         NOT NULL,
    interview_date  DATE,
    interview_notes TEXT         NOT NULL DEFAULT '',
    loan_cleared    BOOLEAN      NOT NULL DEFAULT FALSE,
    assets_returned BOOLEAN      NOT NULL DEFAULT FALSE,
    it_deactivated  BOOLEAN      NOT NULL DEFAULT FALSE,
    payroll_done    BOOLEAN      NOT NULL DEFAULT FALSE,
    created_by      BIGINT       REFERENCES o3c_users(id),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hr_jobs_status      ON hr_jobs(status);
CREATE INDEX IF NOT EXISTS idx_hr_applicants_job   ON hr_applicants(job_id);
CREATE INDEX IF NOT EXISTS idx_hr_applicants_stage ON hr_applicants(stage);
CREATE INDEX IF NOT EXISTS idx_hr_onboarding_emp   ON hr_onboarding_items(employee_id);
CREATE INDEX IF NOT EXISTS idx_hr_offboarding_emp  ON hr_offboarding_items(employee_id);

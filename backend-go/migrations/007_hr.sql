-- HR module tables

CREATE TABLE IF NOT EXISTS employees (
    id                BIGSERIAL PRIMARY KEY,
    staff_id          TEXT NOT NULL UNIQUE,
    user_id           BIGINT UNIQUE,
    first_name        TEXT NOT NULL,
    last_name         TEXT NOT NULL,
    middle_name       TEXT,
    email             TEXT NOT NULL UNIQUE,
    phone             TEXT,
    department_id     INT  REFERENCES departments(id),
    grade_level_id    INT  REFERENCES grade_levels(id),
    job_title         TEXT NOT NULL,
    employment_type   TEXT NOT NULL DEFAULT 'permanent',
    employment_date   DATE NOT NULL,
    confirmation_date DATE,
    exit_date         DATE,
    salary_kobo       BIGINT NOT NULL DEFAULT 0,
    bank_name         TEXT,
    account_number    TEXT,
    bvn_last4         TEXT,
    status            TEXT NOT NULL DEFAULT 'active',
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_emp_dept   ON employees(department_id, status);
CREATE INDEX IF NOT EXISTS idx_emp_status ON employees(status);

CREATE TABLE IF NOT EXISTS employee_emergency_contacts (
    id           SERIAL PRIMARY KEY,
    employee_id  BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    name         TEXT   NOT NULL,
    relationship TEXT   NOT NULL,
    phone        TEXT   NOT NULL,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS leave_types (
    id            SERIAL PRIMARY KEY,
    name          TEXT    NOT NULL UNIQUE,
    days_per_year INT     NOT NULL,
    is_paid       BOOLEAN NOT NULL DEFAULT TRUE,
    requires_docs BOOLEAN NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO leave_types (name, days_per_year, is_paid, requires_docs) VALUES
    ('Annual Leave',       20, true,  false),
    ('Sick Leave',         14, true,  true),
    ('Maternity Leave',    84, true,  true),
    ('Paternity Leave',    14, true,  false),
    ('Compassionate Leave', 5, true,  false),
    ('Study Leave',        14, false, true),
    ('Unpaid Leave',       30, false, false)
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS leave_balances (
    id              SERIAL  PRIMARY KEY,
    employee_id     BIGINT  NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    leave_type_id   INT     NOT NULL REFERENCES leave_types(id),
    year            INT     NOT NULL,
    days_total      INT     NOT NULL,
    days_used       INT     NOT NULL DEFAULT 0,
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (employee_id, leave_type_id, year)
);

CREATE TABLE IF NOT EXISTS leave_applications (
    id              BIGSERIAL PRIMARY KEY,
    employee_id     BIGINT  NOT NULL REFERENCES employees(id),
    leave_type_id   INT     NOT NULL REFERENCES leave_types(id),
    start_date      DATE    NOT NULL,
    end_date        DATE    NOT NULL,
    days_requested  INT     NOT NULL,
    reason          TEXT,
    status          TEXT    NOT NULL DEFAULT 'pending',
    approved_by     BIGINT,
    approval_notes  TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_leave_emp    ON leave_applications(employee_id, status);
CREATE INDEX IF NOT EXISTS idx_leave_status ON leave_applications(status, start_date);

CREATE TABLE IF NOT EXISTS review_cycles (
    id         SERIAL PRIMARY KEY,
    name       TEXT NOT NULL,
    start_date DATE NOT NULL,
    end_date   DATE NOT NULL,
    status     TEXT NOT NULL DEFAULT 'draft',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS appraisals (
    id           BIGSERIAL PRIMARY KEY,
    cycle_id     INT    NOT NULL REFERENCES review_cycles(id),
    employee_id  BIGINT NOT NULL REFERENCES employees(id),
    reviewer_id  BIGINT,
    status       TEXT   NOT NULL DEFAULT 'pending',
    final_score  NUMERIC(5,2),
    grade        TEXT,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    submitted_at TIMESTAMPTZ,
    UNIQUE (cycle_id, employee_id)
);
CREATE INDEX IF NOT EXISTS idx_appr_cycle ON appraisals(cycle_id, status);
CREATE INDEX IF NOT EXISTS idx_appr_emp   ON appraisals(employee_id, status);

CREATE TABLE IF NOT EXISTS appraisal_items (
    id            SERIAL PRIMARY KEY,
    appraisal_id  BIGINT  NOT NULL REFERENCES appraisals(id) ON DELETE CASCADE,
    kpi           TEXT    NOT NULL,
    target        TEXT    NOT NULL,
    actual        TEXT,
    weight        NUMERIC(4,2) NOT NULL DEFAULT 1.0,
    self_score    NUMERIC(3,1),
    manager_score NUMERIC(3,1),
    comments      TEXT
);

CREATE TABLE IF NOT EXISTS disciplinary_cases (
    id           BIGSERIAL PRIMARY KEY,
    employee_id  BIGINT NOT NULL REFERENCES employees(id),
    initiated_by BIGINT NOT NULL,
    offense_type TEXT   NOT NULL,
    description  TEXT   NOT NULL,
    status       TEXT   NOT NULL DEFAULT 'open',
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS disciplinary_hearings (
    id            SERIAL PRIMARY KEY,
    case_id       BIGINT    NOT NULL REFERENCES disciplinary_cases(id),
    scheduled_at  TIMESTAMPTZ NOT NULL,
    panel_members TEXT[]    NOT NULL DEFAULT '{}',
    outcome       TEXT,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS disciplinary_actions (
    id             SERIAL PRIMARY KEY,
    case_id        BIGINT NOT NULL REFERENCES disciplinary_cases(id),
    action_type    TEXT   NOT NULL,
    effective_date DATE   NOT NULL,
    duration_days  INT,
    notes          TEXT,
    created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS training_sessions (
    id             SERIAL PRIMARY KEY,
    title          TEXT   NOT NULL,
    facilitator    TEXT,
    start_date     DATE   NOT NULL,
    end_date       DATE   NOT NULL,
    venue          TEXT,
    status         TEXT   NOT NULL DEFAULT 'scheduled',
    max_attendees  INT,
    created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS training_attendance (
    id                 SERIAL  PRIMARY KEY,
    session_id         INT     NOT NULL REFERENCES training_sessions(id),
    employee_id        BIGINT  NOT NULL REFERENCES employees(id),
    attended           BOOLEAN NOT NULL DEFAULT FALSE,
    certificate_issued BOOLEAN NOT NULL DEFAULT FALSE,
    created_at         TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (session_id, employee_id)
);

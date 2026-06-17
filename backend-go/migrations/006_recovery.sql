-- Recovery module tables

CREATE TABLE IF NOT EXISTS recovery_cases (
    id                     BIGSERIAL PRIMARY KEY,
    case_ref               TEXT   NOT NULL UNIQUE,
    cif_number             TEXT   NOT NULL,
    account_number         TEXT,
    assigned_to_user_id    BIGINT,
    assigned_by            BIGINT,
    status                 TEXT   NOT NULL DEFAULT 'open',
    legal_stage            TEXT,
    total_outstanding_kobo BIGINT NOT NULL,
    total_recovered_kobo   BIGINT NOT NULL DEFAULT 0,
    write_off_status       TEXT,
    write_off_amount_kobo  BIGINT,
    created_at             TIMESTAMPTZ DEFAULT NOW(),
    updated_at             TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rec_cases_cif      ON recovery_cases(cif_number);
CREATE INDEX IF NOT EXISTS idx_rec_cases_status   ON recovery_cases(status);
CREATE INDEX IF NOT EXISTS idx_rec_cases_assigned ON recovery_cases(assigned_to_user_id, status);

CREATE TABLE IF NOT EXISTS recovery_payments (
    id           BIGSERIAL PRIMARY KEY,
    case_id      BIGINT NOT NULL REFERENCES recovery_cases(id),
    amount_kobo  BIGINT NOT NULL,
    payment_date DATE   NOT NULL,
    channel      TEXT   NOT NULL,
    reference    TEXT,
    notes        TEXT,
    posted_by    BIGINT NOT NULL,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rec_payments_case ON recovery_payments(case_id, payment_date DESC);

CREATE TABLE IF NOT EXISTS legal_proceedings (
    id               BIGSERIAL PRIMARY KEY,
    case_id          BIGINT NOT NULL REFERENCES recovery_cases(id),
    proceeding_type  TEXT   NOT NULL,
    court            TEXT,
    filing_date      DATE,
    next_date        DATE,
    outcome          TEXT,
    notes            TEXT,
    created_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_legal_case ON legal_proceedings(case_id, filing_date DESC);

CREATE TABLE IF NOT EXISTS recovery_field_visits (
    id         BIGSERIAL PRIMARY KEY,
    case_id    BIGINT NOT NULL REFERENCES recovery_cases(id),
    officer_id BIGINT NOT NULL,
    visit_date DATE   NOT NULL,
    address    TEXT,
    outcome    TEXT,
    notes      TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS recovery_approvals (
    id            BIGSERIAL PRIMARY KEY,
    case_id       BIGINT NOT NULL REFERENCES recovery_cases(id),
    approval_type TEXT   NOT NULL,
    approved_by   BIGINT NOT NULL,
    role_at_time  TEXT   NOT NULL,
    decision      TEXT   NOT NULL,
    notes         TEXT,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rec_approvals_case ON recovery_approvals(case_id, created_at DESC);

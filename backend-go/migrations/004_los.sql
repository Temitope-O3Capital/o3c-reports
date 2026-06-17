-- Loan Origination System tables

CREATE TABLE IF NOT EXISTS loan_applications (
    id                    BIGSERIAL PRIMARY KEY,
    reference             TEXT NOT NULL UNIQUE,
    applicant_name        TEXT NOT NULL,
    applicant_cif         TEXT,
    applicant_email       TEXT,
    applicant_phone       TEXT,
    product_type          TEXT NOT NULL,
    amount_requested_kobo BIGINT NOT NULL,
    amount_approved_kobo  BIGINT,
    tenor_months          INT  NOT NULL,
    interest_rate_bps     INT,
    purpose               TEXT,
    employer              TEXT,
    monthly_income_kobo   BIGINT,
    status                TEXT NOT NULL DEFAULT 'draft',
    stage                 TEXT NOT NULL DEFAULT 'draft',
    assigned_to_user_id   BIGINT,
    sales_officer_id      BIGINT,
    risk_officer_id       BIGINT,
    finance_officer_id    BIGINT,
    cards_ops_officer_id  BIGINT,
    request_info_count    INT  NOT NULL DEFAULT 0,
    decline_reason        TEXT,
    submitted_at          TIMESTAMPTZ,
    risk_reviewed_at      TIMESTAMPTZ,
    finance_approved_at   TIMESTAMPTZ,
    booked_at             TIMESTAMPTZ,
    created_at            TIMESTAMPTZ DEFAULT NOW(),
    updated_at            TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_loan_apps_status   ON loan_applications(status);
CREATE INDEX IF NOT EXISTS idx_loan_apps_cif      ON loan_applications(applicant_cif);
CREATE INDEX IF NOT EXISTS idx_loan_apps_assigned ON loan_applications(assigned_to_user_id);
CREATE INDEX IF NOT EXISTS idx_loan_apps_sales    ON loan_applications(sales_officer_id);

CREATE TABLE IF NOT EXISTS application_events (
    id             BIGSERIAL PRIMARY KEY,
    application_id BIGINT NOT NULL REFERENCES loan_applications(id),
    event_type     TEXT   NOT NULL,
    from_stage     TEXT,
    to_stage       TEXT,
    actor_user_id  BIGINT NOT NULL,
    notes          TEXT,
    created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_app_events_app ON application_events(application_id, created_at DESC);

CREATE TABLE IF NOT EXISTS application_conditions (
    id             BIGSERIAL PRIMARY KEY,
    application_id BIGINT  NOT NULL REFERENCES loan_applications(id),
    condition_text TEXT    NOT NULL,
    is_met         BOOLEAN NOT NULL DEFAULT FALSE,
    met_by         BIGINT,
    met_at         TIMESTAMPTZ,
    created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_app_conds_app ON application_conditions(application_id);

CREATE TABLE IF NOT EXISTS application_documents (
    id             BIGSERIAL PRIMARY KEY,
    application_id BIGINT  NOT NULL REFERENCES loan_applications(id),
    doc_type       TEXT    NOT NULL,
    document_id    BIGINT  REFERENCES documents(id),
    is_required    BOOLEAN NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS application_notes (
    id             BIGSERIAL PRIMARY KEY,
    application_id BIGINT  NOT NULL REFERENCES loan_applications(id),
    author_id      BIGINT  NOT NULL,
    body           TEXT    NOT NULL,
    is_internal    BOOLEAN NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_app_notes_app ON application_notes(application_id, created_at DESC);

CREATE TABLE IF NOT EXISTS los_config (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_by BIGINT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO los_config (key, value) VALUES
    ('sla_document_collection_hours', '48'),
    ('sla_risk_review_hours', '24'),
    ('sla_risk_head_review_hours', '4'),
    ('sla_finance_approval_hours', '24'),
    ('max_request_info_cycles', '2'),
    ('personal_loan_max_kobo', '500000000'),
    ('salary_loan_max_kobo', '1000000000'),
    ('sme_loan_max_kobo', '5000000000'),
    ('max_tenor_months_personal', '36'),
    ('max_tenor_months_salary', '60'),
    ('max_tenor_months_sme', '84')
ON CONFLICT (key) DO NOTHING;

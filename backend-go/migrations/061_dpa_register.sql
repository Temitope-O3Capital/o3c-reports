-- Migration 061: P12-07 — DPA data processing register (NDPR / FCCPC)

CREATE TABLE IF NOT EXISTS dpa_processing_register (
    id              BIGSERIAL PRIMARY KEY,
    processing_name TEXT NOT NULL,
    purpose         TEXT NOT NULL,
    legal_basis     TEXT NOT NULL CHECK (legal_basis IN ('consent','contract','legal_obligation','vital_interests','public_task','legitimate_interests')),
    data_categories TEXT[],
    data_subjects   TEXT,
    recipients      TEXT,
    third_country_transfers BOOLEAN DEFAULT FALSE,
    retention_period TEXT,
    security_measures TEXT,
    dpo_reviewed    BOOLEAN DEFAULT FALSE,
    status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','under_review','discontinued')),
    created_by      BIGINT REFERENCES o3c_users(id),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dpa_register_status ON dpa_processing_register(status);

-- Seed common O3 Capital processing activities
INSERT INTO dpa_processing_register
    (processing_name, purpose, legal_basis, data_categories, data_subjects, recipients, retention_period, status)
VALUES
    ('KYC Verification', 'Verify customer identity per CBN KYC circular', 'legal_obligation',
     ARRAY['identity','biometric','financial'], 'Loan applicants', 'CBN, Credit bureaux', '7 years', 'active'),
    ('Credit Scoring', 'Assess creditworthiness for loan decisions', 'contract',
     ARRAY['financial','behavioral'], 'Loan applicants', 'Eye service (internal)', '7 years', 'active'),
    ('Marketing Communications', 'Promotional campaigns via SMS / email / WhatsApp', 'consent',
     ARRAY['contact'], 'Opted-in customers', 'Termii, SendGrid', '2 years', 'active'),
    ('Loan Servicing', 'Manage active loan accounts, collect repayments', 'contract',
     ARRAY['financial','contact'], 'Active borrowers', 'NIBSS, payment processors', '7 years', 'active'),
    ('Helpdesk Support', 'Resolve customer queries and complaints', 'contract',
     ARRAY['contact','interaction'], 'All customers', 'None', '3 years', 'active'),
    ('Payroll Processing', 'Calculate and disburse staff salaries', 'contract',
     ARRAY['financial','identity'], 'Employees', 'PenCom, FIRS', '7 years', 'active')
ON CONFLICT DO NOTHING;

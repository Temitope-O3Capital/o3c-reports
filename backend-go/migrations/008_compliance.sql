-- Compliance and audit tables

-- Audit log: NEVER UPDATE or DELETE rows
CREATE TABLE IF NOT EXISTS audit_logs (
    id          BIGSERIAL   NOT NULL,
    actor_id    BIGINT      NOT NULL,
    actor_role  TEXT        NOT NULL,
    actor_name  TEXT        NOT NULL,
    action      TEXT        NOT NULL,
    entity_type TEXT        NOT NULL,
    entity_id   TEXT,
    changes     JSONB,
    ip_address  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE IF NOT EXISTS audit_logs_2026_06 PARTITION OF audit_logs FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE IF NOT EXISTS audit_logs_2026_07 PARTITION OF audit_logs FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE IF NOT EXISTS audit_logs_2026_08 PARTITION OF audit_logs FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE IF NOT EXISTS audit_logs_2026_09 PARTITION OF audit_logs FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE IF NOT EXISTS audit_logs_2026_10 PARTITION OF audit_logs FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE IF NOT EXISTS audit_logs_2026_11 PARTITION OF audit_logs FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE IF NOT EXISTS audit_logs_2026_12 PARTITION OF audit_logs FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE IF NOT EXISTS audit_logs_2027_01 PARTITION OF audit_logs FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE IF NOT EXISTS audit_logs_2027_02 PARTITION OF audit_logs FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');
CREATE TABLE IF NOT EXISTS audit_logs_2027_03 PARTITION OF audit_logs FOR VALUES FROM ('2027-03-01') TO ('2027-04-01');
CREATE TABLE IF NOT EXISTS audit_logs_2027_04 PARTITION OF audit_logs FOR VALUES FROM ('2027-04-01') TO ('2027-05-01');
CREATE TABLE IF NOT EXISTS audit_logs_2027_05 PARTITION OF audit_logs FOR VALUES FROM ('2027-05-01') TO ('2027-06-01');
CREATE TABLE IF NOT EXISTS audit_logs_2027_06 PARTITION OF audit_logs FOR VALUES FROM ('2027-06-01') TO ('2027-07-01');
CREATE TABLE IF NOT EXISTS audit_logs_2027_07 PARTITION OF audit_logs FOR VALUES FROM ('2027-07-01') TO ('2027-08-01');
CREATE TABLE IF NOT EXISTS audit_logs_2027_08 PARTITION OF audit_logs FOR VALUES FROM ('2027-08-01') TO ('2027-09-01');
CREATE TABLE IF NOT EXISTS audit_logs_2027_09 PARTITION OF audit_logs FOR VALUES FROM ('2027-09-01') TO ('2027-10-01');
CREATE TABLE IF NOT EXISTS audit_logs_2027_10 PARTITION OF audit_logs FOR VALUES FROM ('2027-10-01') TO ('2027-11-01');
CREATE TABLE IF NOT EXISTS audit_logs_2027_11 PARTITION OF audit_logs FOR VALUES FROM ('2027-11-01') TO ('2027-12-01');
CREATE TABLE IF NOT EXISTS audit_logs_2027_12 PARTITION OF audit_logs FOR VALUES FROM ('2027-12-01') TO ('2028-01-01');

CREATE TABLE IF NOT EXISTS audit_export_requests (
    id           BIGSERIAL PRIMARY KEY,
    requested_by BIGINT NOT NULL,
    filters      JSONB  NOT NULL DEFAULT '{}',
    status       TEXT   NOT NULL DEFAULT 'pending',
    download_url TEXT,
    row_count    INT,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    expires_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS cbn_reports (
    id           BIGSERIAL PRIMARY KEY,
    report_type  TEXT    NOT NULL,
    period_start DATE    NOT NULL,
    period_end   DATE    NOT NULL,
    status       TEXT    NOT NULL DEFAULT 'draft',
    signed_off_by BIGINT,
    submitted_at TIMESTAMPTZ,
    document_id  BIGINT  REFERENCES documents(id),
    notes        TEXT,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS compliance_checklist_templates (
    id         SERIAL PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    department TEXT NOT NULL,
    frequency  TEXT NOT NULL DEFAULT 'monthly',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS compliance_checklist_template_items (
    id            SERIAL  PRIMARY KEY,
    template_id   INT     NOT NULL REFERENCES compliance_checklist_templates(id) ON DELETE CASCADE,
    item_text     TEXT    NOT NULL,
    is_required   BOOLEAN NOT NULL DEFAULT TRUE,
    display_order INT     NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS compliance_checklists (
    id          BIGSERIAL PRIMARY KEY,
    template_id INT    NOT NULL REFERENCES compliance_checklist_templates(id),
    assigned_to BIGINT NOT NULL,
    assigned_by BIGINT NOT NULL,
    due_date    DATE   NOT NULL,
    status      TEXT   NOT NULL DEFAULT 'pending',
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS compliance_checklist_responses (
    id           BIGSERIAL PRIMARY KEY,
    checklist_id BIGINT NOT NULL REFERENCES compliance_checklists(id) ON DELETE CASCADE,
    item_id      INT    NOT NULL REFERENCES compliance_checklist_template_items(id),
    response     TEXT   NOT NULL,
    notes        TEXT,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS watch_list_entries (
    id          BIGSERIAL PRIMARY KEY,
    entity_type TEXT    NOT NULL,
    entity_name TEXT    NOT NULL,
    id_type     TEXT,
    id_value    TEXT,
    reason      TEXT    NOT NULL,
    source      TEXT    NOT NULL DEFAULT 'internal',
    added_by    BIGINT  NOT NULL,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- SARs: tipping-off prevention — subject details encrypted
CREATE TABLE IF NOT EXISTS sars (
    id                     BIGSERIAL PRIMARY KEY,
    sar_ref                TEXT NOT NULL UNIQUE,
    reporter_id            BIGINT NOT NULL,
    subject_name_encrypted TEXT NOT NULL,
    subject_id_type        TEXT,
    subject_id_encrypted   TEXT,
    account_number         TEXT,
    amount_kobo            BIGINT,
    transaction_date       DATE,
    summary_encrypted      TEXT NOT NULL,
    status                 TEXT NOT NULL DEFAULT 'draft',
    compliance_head_user_id BIGINT,
    md_user_id             BIGINT,
    nfiu_ref               TEXT,
    nfiu_submitted_at      TIMESTAMPTZ,
    created_at             TIMESTAMPTZ DEFAULT NOW(),
    updated_at             TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sar_escalation_log (
    id          SERIAL PRIMARY KEY,
    sar_id      BIGINT NOT NULL REFERENCES sars(id),
    from_status TEXT   NOT NULL,
    to_status   TEXT   NOT NULL,
    actor_id    BIGINT NOT NULL,
    notes       TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_findings (
    id             BIGSERIAL PRIMARY KEY,
    finding_ref    TEXT    NOT NULL UNIQUE,
    source         TEXT    NOT NULL DEFAULT 'internal',
    assigned_to    BIGINT  NOT NULL,
    assigned_by    BIGINT  NOT NULL,
    severity       TEXT    NOT NULL DEFAULT 'medium',
    description    TEXT    NOT NULL,
    recommendation TEXT,
    status         TEXT    NOT NULL DEFAULT 'open',
    due_date       DATE    NOT NULL,
    closed_at      TIMESTAMPTZ,
    created_at     TIMESTAMPTZ DEFAULT NOW(),
    updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_finding_responses (
    id           BIGSERIAL PRIMARY KEY,
    finding_id   BIGINT NOT NULL REFERENCES audit_findings(id),
    responder_id BIGINT NOT NULL,
    response     TEXT   NOT NULL,
    action_plan  TEXT,
    target_date  DATE,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

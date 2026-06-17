-- KPI snapshots and alerting tables

CREATE TABLE IF NOT EXISTS portfolio_daily_snapshot (
    id                      BIGSERIAL PRIMARY KEY,
    snapshot_date           DATE   NOT NULL UNIQUE,
    total_loans             INT    NOT NULL DEFAULT 0,
    total_outstanding_kobo  BIGINT NOT NULL DEFAULT 0,
    total_npls_kobo         BIGINT NOT NULL DEFAULT 0,
    npl_ratio_bps           INT    NOT NULL DEFAULT 0,
    par30_kobo              BIGINT NOT NULL DEFAULT 0,
    par60_kobo              BIGINT NOT NULL DEFAULT 0,
    par90_kobo              BIGINT NOT NULL DEFAULT 0,
    new_disbursements_kobo  BIGINT NOT NULL DEFAULT 0,
    repayments_kobo         BIGINT NOT NULL DEFAULT 0,
    created_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS collections_daily_kpi (
    id                    BIGSERIAL PRIMARY KEY,
    kpi_date              DATE   NOT NULL,
    agent_user_id         BIGINT NOT NULL,
    contacts_made         INT    NOT NULL DEFAULT 0,
    promises_obtained     INT    NOT NULL DEFAULT 0,
    promises_broken       INT    NOT NULL DEFAULT 0,
    amount_collected_kobo BIGINT NOT NULL DEFAULT 0,
    target_amount_kobo    BIGINT NOT NULL DEFAULT 0,
    created_at            TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (kpi_date, agent_user_id)
);

CREATE TABLE IF NOT EXISTS alert_rules (
    id             SERIAL  PRIMARY KEY,
    rule_name      TEXT    NOT NULL UNIQUE,
    description    TEXT,
    condition_type TEXT    NOT NULL,
    threshold      NUMERIC(15,2),
    severity       TEXT    NOT NULL DEFAULT 'warning',
    is_active      BOOLEAN NOT NULL DEFAULT TRUE,
    notify_roles   TEXT[]  NOT NULL DEFAULT '{}',
    created_at     TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO alert_rules (rule_name, description, condition_type, threshold, severity, notify_roles) VALUES
    ('npl_ratio_high',        'NPL ratio exceeds 5%',              'npl_ratio_exceeds',            5.0,  'critical', ARRAY['md','cfo','coo']),
    ('par30_spike',           'PAR30 exceeds 10%',                 'par30_exceeds',                10.0, 'warning',  ARRAY['cfo','head_collections']),
    ('dpd_90_entries',        'New DPD 90+ accounts',              'dpd_90_new_entries',           5,    'warning',  ARRAY['head_recovery','cfo']),
    ('collections_miss',      'Collections below 70% of target',   'daily_collections_below_target', 70.0, 'warning', ARRAY['head_collections']),
    ('write_off_pending',     'Write-off awaiting approval > 48h', 'write_off_pending_hours',      48,   'warning',  ARRAY['md','cfo']),
    ('sar_draft_aging',       'SAR in draft > 24h',                'sar_draft_aging_hours',        24,   'critical', ARRAY['compliance_head','md']),
    ('compliance_overdue',    'Compliance checklist overdue',      'compliance_overdue',           0,    'warning',  ARRAY['compliance_head'])
ON CONFLICT (rule_name) DO NOTHING;

CREATE TABLE IF NOT EXISTS alert_log (
    id           BIGSERIAL PRIMARY KEY,
    rule_id      INT     NOT NULL REFERENCES alert_rules(id),
    triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    details      JSONB   NOT NULL DEFAULT '{}',
    is_resolved  BOOLEAN NOT NULL DEFAULT FALSE,
    resolved_at  TIMESTAMPTZ,
    resolved_by  BIGINT
);
CREATE INDEX IF NOT EXISTS idx_alerts_rule     ON alert_log(rule_id, triggered_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_resolved ON alert_log(is_resolved, triggered_at DESC);

CREATE TABLE IF NOT EXISTS kpi_targets (
    id           SERIAL PRIMARY KEY,
    role         TEXT    NOT NULL,
    metric_name  TEXT    NOT NULL,
    period       TEXT    NOT NULL DEFAULT 'monthly',
    target_value NUMERIC(20,4) NOT NULL,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_at   TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (role, metric_name, period)
);

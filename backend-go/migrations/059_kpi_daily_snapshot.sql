-- Migration 059: P9-03 — KPI daily snapshot table
-- Populated nightly by the batch job; avoids recomputing aggregates on every dashboard load.

CREATE TABLE IF NOT EXISTS kpi_daily_snapshot (
    id                   BIGSERIAL PRIMARY KEY,
    snapshot_date        DATE NOT NULL UNIQUE,

    -- Loan Origination
    new_applications     INT  NOT NULL DEFAULT 0,
    approved_applications INT NOT NULL DEFAULT 0,
    disbursements_count  INT  NOT NULL DEFAULT 0,
    disbursements_kobo   BIGINT NOT NULL DEFAULT 0,

    -- Repayments
    repayments_count     INT  NOT NULL DEFAULT 0,
    repayments_kobo      BIGINT NOT NULL DEFAULT 0,

    -- Collections
    ptp_set              INT  NOT NULL DEFAULT 0,
    ptp_broken           INT  NOT NULL DEFAULT 0,
    collection_calls     INT  NOT NULL DEFAULT 0,

    -- Helpdesk
    tickets_opened       INT  NOT NULL DEFAULT 0,
    tickets_closed       INT  NOT NULL DEFAULT 0,

    -- Portfolio health (point-in-time)
    active_loans         INT  NOT NULL DEFAULT 0,
    total_book_kobo      BIGINT NOT NULL DEFAULT 0,
    npl_kobo             BIGINT NOT NULL DEFAULT 0,

    created_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kpi_snapshot_date ON kpi_daily_snapshot(snapshot_date DESC);

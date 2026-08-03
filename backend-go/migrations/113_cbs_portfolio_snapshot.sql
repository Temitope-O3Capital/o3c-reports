-- Migration 113: daily snapshot of the Udara/CBS loan + FD portfolio.
-- The workspace-native loan_applications / collection_assignments tables are empty
-- (the real book lives in the CBS-synced cbs_loans / cbs_fixed_deposits tables), so
-- the existing portfolio_daily_snapshot / kpi_daily_snapshot end up all-zero.
-- This table records the true Udara book once per day so the Executive Overview
-- KPI cards can show real trendlines and vs-last-period deltas as history accrues.
-- Populated by batchCBSPortfolioSnapshot in handlers/batch.go.

CREATE TABLE IF NOT EXISTS cbs_portfolio_snapshot (
    snapshot_date               DATE   PRIMARY KEY,

    -- Loan book (from cbs_loans)
    loans_total                 INT    NOT NULL DEFAULT 0,
    loans_active                INT    NOT NULL DEFAULT 0,
    borrowers_active            INT    NOT NULL DEFAULT 0,
    outstanding_principal_kobo  BIGINT NOT NULL DEFAULT 0,
    outstanding_interest_kobo   BIGINT NOT NULL DEFAULT 0,
    npl_kobo                    BIGINT NOT NULL DEFAULT 0,   -- outstanding of Defaulting/Expired loans
    performing_kobo             BIGINT NOT NULL DEFAULT 0,   -- outstanding of non-NPL open loans

    -- Fixed deposits (from cbs_fixed_deposits)
    fd_active_count             INT    NOT NULL DEFAULT 0,
    fd_principal_kobo           BIGINT NOT NULL DEFAULT 0,
    fd_ledger_balance_kobo      BIGINT NOT NULL DEFAULT 0,

    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

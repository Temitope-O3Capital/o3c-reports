-- Full Phoenix credit report (PrequalificationReport) mirrored verbatim.
--
-- Phoenix's decision.completed webhook now carries the complete prequalification report
-- as JSON (Phoenix-side change). We store it 1:1 keyed by application so the workspace
-- can render the exact same report Phoenix holds. Kept in its own table (not a JSONB
-- column on loan_applications) so the large blob never rides along on every SELECT * of
-- the application, and so it's a clean fetch for the Credit Report view.

CREATE TABLE IF NOT EXISTS app.loan_application_reports (
    application_id BIGINT PRIMARY KEY,
    source         TEXT        NOT NULL DEFAULT 'phoenix',   -- who produced the report
    report         JSONB       NOT NULL,                     -- verbatim PrequalificationReport
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

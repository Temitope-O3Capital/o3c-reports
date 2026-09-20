-- The upload ledger the Data Management page has always read, and nothing ever
-- wrote.
--
-- GET /api/uploads/audit (handlers/uploads.go) selects from upload_audit_log to
-- render "central data ingestion & upload history" on /reports/uploads. That table
-- was never created by any migration — so the endpoint has returned a 500 on every
-- request. Its only writers were two handlers (eod.go, income.go) that are
-- registered nowhere and cannot be reached.
--
-- Creating the table alone would just swap an error for a permanently empty page.
-- So the live manual importers now write to it (handlers/upload_ledger.go):
--
--   ccs_eodtxn     CCS EODTXN Report 620      handlers/interswitch.go
--   card_cycle     card cycle reports         handlers/card_cycle_import.go
--   cc_statement   credit-card statements     handlers/cc_statements.go (single + bulk)
--
-- Interswitch settlement already records its runs in interswitch_imports; the
-- endpoint unions that in rather than double-writing.
--
-- Why it matters beyond the page: three of these four manual sources had NO run
-- record of any kind. The freshness monitor (migration 238) could therefore see
-- their data age but never whether an upload had been attempted and failed — and
-- the EODTXN importer discarded every row-insert error outright.
--
-- Schema matches exactly what uploads.go selects and pages/reports/Uploads.tsx
-- renders (id, report_type, file_names, cycle_label, row_counts, status,
-- error_msg, uploaded_at, uploaded_by).

CREATE TABLE IF NOT EXISTS app.upload_audit_log (
    id           bigserial PRIMARY KEY,
    uploaded_by  bigint,
    report_type  text        NOT NULL,              -- ccs_eodtxn | card_cycle | cc_statement
    file_names   jsonb       NOT NULL DEFAULT '[]',
    cycle_label  text,                              -- e.g. the cycle date for card_cycle
    row_counts   jsonb       NOT NULL DEFAULT '{}',
    status       text        NOT NULL,              -- success | partial | error
    error_msg    text,
    uploaded_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT upload_audit_log_status_chk CHECK (status IN ('success', 'partial', 'error'))
);

CREATE INDEX IF NOT EXISTS idx_upload_audit_log_type_time
  ON app.upload_audit_log (report_type, uploaded_at DESC);

COMMENT ON TABLE app.upload_audit_log IS
  'One row per manual dataset upload attempt, including failed ones. Written by handlers/upload_ledger.go recordUpload. Interswitch settlement runs live in interswitch_imports and are unioned in by GET /api/uploads/audit. See migration 245.';
COMMENT ON COLUMN app.upload_audit_log.status IS
  'success = every file/row imported; partial = some imported, some failed; error = nothing imported.';

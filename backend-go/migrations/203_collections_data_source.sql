-- 203: mark WHERE a collections/recovery row came from, so manually-uploaded
-- spreadsheets read as distinct from the Udara core-banking feed.
--
-- Udara loans live only in app.cbs_loans (sync-worker-only, never hand-written), so
-- "from Udara" is structural. But collections/recovery rows are a mix: some are
-- generated from the live card/loan books, others were bulk-loaded from spreadsheets
-- (the July card import, the Aug loan import, and now the Loan Repayment CRM sheet).
-- Nothing on those rows said which was which. This adds an explicit provenance flag,
-- following the cc_statements.source pattern ('upload' vs feed).
--
-- Values: 'core'   — generated from a live feed / normal workflow (default)
--         'manual' — bulk-loaded from an uploaded spreadsheet, NOT from Udara
-- Additive + idempotent.

ALTER TABLE app.collection_assignments ADD COLUMN IF NOT EXISTS data_source text NOT NULL DEFAULT 'core';
ALTER TABLE app.recovery_cases         ADD COLUMN IF NOT EXISTS data_source text NOT NULL DEFAULT 'core';

-- Backfill the known one-time spreadsheet imports to 'manual' (idempotent).
-- Collections: every bulk-loaded assignment carries an 'imp:<batch>' marker in notes.
UPDATE app.collection_assignments SET data_source = 'manual'
 WHERE data_source <> 'manual' AND notes LIKE 'imp:%';

-- Recovery: the July card import tagged case_ref 'IMP2607-%'; the Aug loan import set
-- product_type='loan'. Both were spreadsheet loads, not core-fed cases.
UPDATE app.recovery_cases SET data_source = 'manual'
 WHERE data_source <> 'manual' AND (case_ref LIKE 'IMP2607-%' OR product_type = 'loan');

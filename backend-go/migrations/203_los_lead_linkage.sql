-- Lead → application on-ramp.
--
-- Links a loan_application back to the CRM lead it was raised from, so origination
-- provenance survives (which lead — and via the lead, which campaign/source — produced
-- this application) and so a PROVISIONAL application (raised for a prospect who has no
-- CIF yet: applicant_cif IS NULL, already nullable) can be reconciled to a customer
-- once that customer appears in the feed.
--
-- Soft link only (a BIGINT, no FK constraint) — mirrors how lead_source/campaign_id are
-- already carried loosely on this table, avoids a cross-table lock, and tolerates a lead
-- being pruned without orphaning the application.

ALTER TABLE app.loan_applications ADD COLUMN IF NOT EXISTS source_lead_id BIGINT;

-- Fast lookup of the applications raised from a given lead, and the reverse.
CREATE INDEX IF NOT EXISTS idx_loan_applications_source_lead
    ON app.loan_applications (source_lead_id) WHERE source_lead_id IS NOT NULL;

-- Supports the provisional-CIF reconciliation sweep (match applicant_phone → customer).
CREATE INDEX IF NOT EXISTS idx_loan_applications_provisional_phone
    ON app.loan_applications (applicant_phone) WHERE applicant_cif IS NULL;

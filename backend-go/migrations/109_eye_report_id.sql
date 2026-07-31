-- Store the Eye service's decision UUID so we can retrieve the full report without re-scoring.
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS eye_report_id TEXT;

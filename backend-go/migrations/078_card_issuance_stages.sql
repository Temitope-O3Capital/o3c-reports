-- Add intermediate card issuance workflow stages so the overview pipeline bar
-- can show doc_review, credit_check, and risk_review counts instead of zeros.
-- No schema change is needed (status is a plain TEXT column with no CHECK constraint);
-- this migration records the addition of these stage values as a tracked change.
-- The application now accepts: pending | doc_review | credit_check | risk_review | approved | processing | dispatched | rejected
SELECT 'card_issuance_stages_v2' AS migration_note;

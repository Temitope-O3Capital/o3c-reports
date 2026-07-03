-- Replace COUNT-based loan reference with a sequence to prevent duplicates under concurrent load.
CREATE SEQUENCE IF NOT EXISTS loan_ref_seq START 1;

-- Seed the sequence from the current max to avoid collisions with existing references.
SELECT setval('loan_ref_seq', GREATEST(COALESCE((SELECT COUNT(*) FROM loan_applications), 0), 1));

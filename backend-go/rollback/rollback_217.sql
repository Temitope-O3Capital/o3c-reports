-- Reverse of 217. Restoring NOT NULL requires a value in every row, so the
-- sentinel has to come back first -- which is exactly the misinformation 217
-- removed. Only run this if something downstream turns out to depend on the
-- column being NOT NULL.
UPDATE app.loan_applications SET tenor_months = 0 WHERE tenor_months IS NULL;
ALTER TABLE app.loan_applications ALTER COLUMN tenor_months SET NOT NULL;

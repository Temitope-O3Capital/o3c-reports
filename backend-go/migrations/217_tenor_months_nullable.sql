-- A revolving product has no tenor. A credit card is a limit the customer draws
-- against and repays at their own pace; there is no term. The column was NOT NULL
-- with no default, so every card application had to store 0 -- a sentinel that
-- reads as "zero months" everywhere it is used. AVG(tenor_months) across a mixed
-- book is dragged toward zero by every card in it, and the UI renders "0 months"
-- as though it were a fact about the product.
--
-- NULL is the honest value: no tenor applies. Aggregates skip it, and the UI
-- already renders a missing value as a dash.
--
-- Idempotent: safe to re-run.

ALTER TABLE app.loan_applications ALTER COLUMN tenor_months DROP NOT NULL;

-- Existing zeros are the sentinel, not real data: a nought-month loan does not
-- exist, so every 0 in this column means "unset".
UPDATE app.loan_applications SET tenor_months = NULL WHERE tenor_months = 0;

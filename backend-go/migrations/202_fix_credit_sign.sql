-- Make amount_credit a positive magnitude, matching amount_debit.
--
-- app.transactions carried TWO sign conventions in one column. The baseline
-- import (cfile_catchup) stored credits as NEGATIVE; the feed loader
-- (txnfeed/txnfeed.go, which documents "money_in => amount negative,
-- amount_credit = magnitude") writes them POSITIVE. Summing across both nets one
-- era against the other, so every consumer -- handlers/finance.go,
-- handlers/bi.go, the BI export datasets and the AI assistant -- reported money
-- in as a NEGATIVE number: -101,451,568.98 over 90 days and -16,879,891,687.33
-- all time. Nobody caught it because a negative inflow still renders as a figure.
--
-- The rule is unambiguous. Every row with amount_credit < 0 also has amount < 0
-- (169,021 of 169,021), so all of them are genuine inflows under the signed
-- `amount` convention, and `amount` IS consistent across both eras. amount_debit
-- is already a positive magnitude in every row but one. Making amount_credit a
-- magnitude too is what the schema always meant, and it is what makes
-- finance.go's "SUM(amount_credit) - SUM(amount_debit) AS net_flow" arithmetic
-- correct -- with negative credits that expression computed -inflow-outflow.
--
-- `amount` is deliberately NOT touched: it stays negative for money in, so
-- anything reading the signed column is unaffected.
--
-- Expected effect: 90-day money in -101,451,568.98 -> 752,130,643.46;
-- all-time money in -16,879,891,687.33 -> 18,145,717,208.49.
--
-- REVERSIBLE: every changed txn_id and its original value are recorded in
-- app.transactions_credit_sign_fix. See rollback/rollback_202.sql.

CREATE TABLE IF NOT EXISTS app.transactions_credit_sign_fix (
    txn_id     TEXT PRIMARY KEY,
    old_credit NUMERIC     NOT NULL,
    fixed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO app.transactions_credit_sign_fix (txn_id, old_credit)
SELECT txn_id, amount_credit
FROM   app.transactions
WHERE  amount_credit < 0
ON CONFLICT (txn_id) DO NOTHING;

UPDATE app.transactions
SET    amount_credit = ABS(amount_credit)
WHERE  amount_credit < 0;

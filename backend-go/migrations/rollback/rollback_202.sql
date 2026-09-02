-- Undo 202_fix_credit_sign.sql: restore the original negative amount_credit
-- values from the ledger written by that migration.
--
-- Restores from the recorded original rather than negating in place, so it is
-- correct even if some rows were touched again in between.

UPDATE app.transactions t
SET    amount_credit = f.old_credit
FROM   app.transactions_credit_sign_fix f
WHERE  f.txn_id = t.txn_id;

DELETE FROM schema_migrations WHERE filename = '202_fix_credit_sign.sql';

-- The audit table is kept deliberately: it is the only record of what was
-- changed. Drop it manually if the fix is being abandoned for good.
-- DROP TABLE app.transactions_credit_sign_fix;

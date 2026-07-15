-- Rollback for 072_loan_repayments
DROP INDEX IF EXISTS idx_loan_repayments_date;
DROP INDEX IF EXISTS idx_loan_repayments_loan;
DROP TABLE IF EXISTS loan_repayments;

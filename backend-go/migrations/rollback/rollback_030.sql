-- Rollback for 030_customer_statement_runs
DROP INDEX IF EXISTS idx_customer_statement_run_recipients_run;
DROP INDEX IF EXISTS idx_customer_statement_runs_status;
DROP TABLE IF EXISTS customer_statement_run_recipients;
DROP TABLE IF EXISTS customer_statement_runs;

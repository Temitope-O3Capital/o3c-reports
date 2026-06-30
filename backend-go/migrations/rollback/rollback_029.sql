-- Rollback for 029_customer_statement_emails
DROP INDEX IF EXISTS idx_customer_statement_emails_cif;
DROP INDEX IF EXISTS idx_customer_statement_emails_mail;
DROP INDEX IF EXISTS idx_customer_statement_emails_status;
DROP TABLE IF EXISTS customer_statement_emails;

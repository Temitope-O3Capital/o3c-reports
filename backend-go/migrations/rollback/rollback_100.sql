-- Rollback for 100_fd_cif_officer
DROP INDEX IF EXISTS idx_fd_txn_sales_officer;
DROP INDEX IF EXISTS idx_fd_txn_cif;
ALTER TABLE fd_transactions
  DROP COLUMN IF EXISTS sales_officer_id,
  DROP COLUMN IF EXISTS cif_number;

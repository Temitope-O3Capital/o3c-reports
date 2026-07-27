-- 100: Link fixed deposits to customers and sourcing Sales officer.
--
-- fd_transactions previously only had customer_name (free text) and account_officer (free text).
-- This migration adds proper relational columns so:
--   • FDs can be tied to a CRM contact / core-banking CIF
--   • Sales officers are credited for FDs they source (for My Accounts / AM portfolio view)

ALTER TABLE fd_transactions
  ADD COLUMN IF NOT EXISTS cif_number       TEXT,
  ADD COLUMN IF NOT EXISTS sales_officer_id BIGINT REFERENCES o3c_users(id);

CREATE INDEX IF NOT EXISTS idx_fd_txn_cif           ON fd_transactions(cif_number) WHERE cif_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fd_txn_sales_officer ON fd_transactions(sales_officer_id) WHERE sales_officer_id IS NOT NULL;

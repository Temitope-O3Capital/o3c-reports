-- Rollback for 073_debt_sales_soft_delete
DROP INDEX IF EXISTS idx_debt_sales_active;
ALTER TABLE debt_sales DROP COLUMN IF EXISTS deleted_by;
ALTER TABLE debt_sales DROP COLUMN IF EXISTS deleted_at;

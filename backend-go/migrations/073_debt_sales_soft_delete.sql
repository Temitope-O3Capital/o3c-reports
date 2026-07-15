ALTER TABLE debt_sales ADD COLUMN IF NOT EXISTS deleted_at  TIMESTAMPTZ;
ALTER TABLE debt_sales ADD COLUMN IF NOT EXISTS deleted_by  BIGINT REFERENCES o3c_users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_debt_sales_active ON debt_sales(deleted_at) WHERE deleted_at IS NULL;

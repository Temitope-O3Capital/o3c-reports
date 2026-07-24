-- L9: Auto-update payroll_items.updated_at on every row modification.
-- The column already has DEFAULT NOW() for inserts (migration 090);
-- this trigger covers UPDATE so callers don't need to set it manually.

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payroll_items_updated_at ON payroll_items;
CREATE TRIGGER trg_payroll_items_updated_at
  BEFORE UPDATE ON payroll_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

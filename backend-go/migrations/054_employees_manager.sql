-- Migration 054: Add manager_id and employee_number to employees

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS manager_id      BIGINT REFERENCES employees(id),
  ADD COLUMN IF NOT EXISTS employee_number TEXT;

CREATE INDEX IF NOT EXISTS idx_employees_manager ON employees(manager_id);

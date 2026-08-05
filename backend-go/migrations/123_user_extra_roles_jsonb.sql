-- Reconcile extra_roles to JSONB.
--
-- Migration 122 was applied on some environments while it still declared the
-- column as TEXT[] (a concurrent deploy raced the switch to JSONB). Because
-- 122 is already recorded as applied there, ADD COLUMN IF NOT EXISTS will never
-- change the type. Convert any TEXT[] instance to JSONB so the column matches
-- how the app reads/writes it. No-op where 122 already created it as JSONB.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'o3c_users' AND column_name = 'extra_roles' AND data_type = 'ARRAY'
  ) THEN
    ALTER TABLE o3c_users ALTER COLUMN extra_roles DROP DEFAULT;
    ALTER TABLE o3c_users ALTER COLUMN extra_roles TYPE JSONB USING to_jsonb(extra_roles);
    ALTER TABLE o3c_users ALTER COLUMN extra_roles SET DEFAULT '[]'::jsonb;
    ALTER TABLE o3c_users ALTER COLUMN extra_roles SET NOT NULL;
  END IF;
END $$;

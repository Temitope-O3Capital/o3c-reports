-- 152_sector_code_registry.sql
--
-- Turns app.cbn_sector_codes from a placeholder stub into a maintainable registry that
-- O3 owns, because Udara does not publish sector names.
--
-- Udara sends economic_sector as a bare CBN numeric code ('41000') with no label
-- anywhere in the payload, and nothing else in the database carries a sector
-- vocabulary (app.employers.sector is empty, loan_applications.sector_code is empty).
-- Migration 151 seeded literal 'Sector 41000' strings as a stopgap; that conflates
-- "we named this" with "nobody has named this yet", so names are now NULLABLE and the
-- placeholder rows are reset to NULL. A NULL name means unmapped, full stop.
--
-- Codes are registered automatically as they appear on the book (app.sync_sector_codes,
-- called on read), so the Risk team always sees the complete list of what needs naming
-- rather than discovering gaps one chart at a time.

BEGIN;

-- name NULL = registered but not yet named by us.
ALTER TABLE app.cbn_sector_codes ALTER COLUMN name DROP NOT NULL;

-- Clear the 151 placeholders so they are not mistaken for real names.
UPDATE app.cbn_sector_codes
SET name = NULL
WHERE name = 'Sector ' || code;

ALTER TABLE app.cbn_sector_codes
  ADD COLUMN IF NOT EXISTS description    text,
  -- 'udara'  — code observed on the CBS book
  -- 'manual' — added by hand in the workspace (a code we expect but have not seen yet)
  ADD COLUMN IF NOT EXISTS source         text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS is_active      boolean NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS first_seen_at  timestamptz,
  ADD COLUMN IF NOT EXISTS updated_by     bigint;

-- Anything already present came from the book.
UPDATE app.cbn_sector_codes SET source = 'udara' WHERE source = 'manual' AND first_seen_at IS NULL;
UPDATE app.cbn_sector_codes SET first_seen_at = COALESCE(first_seen_at, updated_at);

-- ── Auto-registration ────────────────────────────────────────────────────────
-- Registers any code present on the loan book that is not yet in the table. Cheap
-- (one anti-joined insert over a small table) and idempotent, so it can be called on
-- every read of the sector admin screen. New Udara codes therefore surface as
-- "unmapped" rather than silently rendering as a number in a chart.
CREATE OR REPLACE FUNCTION app.sync_sector_codes()
RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  v_added int;
BEGIN
  INSERT INTO app.cbn_sector_codes (code, name, source, first_seen_at)
  SELECT DISTINCT cl.economic_sector, NULL, 'udara', NOW()
  FROM cbs_loans cl
  WHERE NULLIF(cl.economic_sector, '') IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM app.cbn_sector_codes c WHERE c.code = cl.economic_sector)
  ON CONFLICT (code) DO NOTHING;
  GET DIAGNOSTICS v_added = ROW_COUNT;
  RETURN v_added;
END $$;

-- ── Resolution ───────────────────────────────────────────────────────────────
-- An unmapped code reads as "Unmapped (41000)" — visibly a gap to be filled, not a
-- sector name. Charts stay readable and nobody mistakes a code for a classification.
CREATE OR REPLACE FUNCTION app.cbn_sector_name(p_code text)
RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN NULLIF(p_code, '') IS NULL THEN 'Unclassified'
    ELSE COALESCE(
      (SELECT NULLIF(TRIM(name), '') FROM app.cbn_sector_codes WHERE code = p_code),
      'Unmapped (' || p_code || ')'
    )
  END
$$;

-- True only when a human has actually named the code — lets the UI count and flag gaps.
CREATE OR REPLACE FUNCTION app.cbn_sector_is_mapped(p_code text)
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.cbn_sector_codes
    WHERE code = NULLIF(p_code, '') AND NULLIF(TRIM(name), '') IS NOT NULL
  )
$$;

SELECT app.sync_sector_codes();

COMMIT;

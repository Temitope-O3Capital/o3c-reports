-- Staff → office location, so the book can be split by branch (Lagos, Abuja, …).
--
-- A customer's office follows their account officer: whatever office the assigned staff
-- member sits in, that customer's relationship belongs to. There is therefore nothing to
-- store on the customer — the office lives on the staff record and is read through
-- customer_officers at query time.
--
-- Free text on purpose: O3's branch list is a business fact we don't have here, so we do
-- not seed a hardcoded enum that would go stale. The admin picker offers the offices
-- already in use plus free entry; app.staff_offices() surfaces the live distinct list.

ALTER TABLE o3c_users ADD COLUMN IF NOT EXISTS office_location TEXT;

-- Distinct offices currently assigned — powers the admin datalist without a fixed enum.
CREATE OR REPLACE FUNCTION app.staff_offices()
RETURNS TABLE (office_location TEXT, staff_count BIGINT)
LANGUAGE sql STABLE AS $$
    SELECT NULLIF(TRIM(office_location), '') AS office_location, COUNT(*) AS staff_count
      FROM o3c_users
     WHERE deleted_at IS NULL
       AND NULLIF(TRIM(office_location), '') IS NOT NULL
     GROUP BY 1
     ORDER BY staff_count DESC, office_location
$$;

-- 129: Link historical calls to customers by phone so the Customer 360 timeline
-- is populated. Only unambiguous phone→customer matches are applied (a phone that
-- maps to exactly one CIF), so we never mis-attribute a call. Idempotent.

WITH uniq AS (
  SELECT app.norm_phone(phone) AS p, min(cif) AS cif
  FROM app.customers
  WHERE app.norm_phone(phone) <> '' AND cif IS NOT NULL AND cif <> ''
  GROUP BY app.norm_phone(phone)
  HAVING count(DISTINCT cif) = 1
)
UPDATE app.helpdesk_calls h
SET customer_cif = uniq.cif
FROM uniq
WHERE (h.customer_cif IS NULL OR h.customer_cif = '')
  AND app.norm_phone(h.customer_phone) = uniq.p;

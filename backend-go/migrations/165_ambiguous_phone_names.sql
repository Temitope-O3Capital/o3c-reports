-- 165_ambiguous_phone_names.sql
--
-- Undoes a bad name match I made in migration 164.
--
-- 164 named a call by looking up its number in the customer master with LIMIT 1.
-- That is only safe when the number identifies one person, and often it does not:
--
--   08012345678   4,008 different customers   (a placeholder everyone types)
--   08000000000   1,196
--   0000000000      243
--   07017323707   Norah Ikoh AND Chinyere Ikoh — family sharing a line
--
-- 216 numbers carry exactly 2 names, 51 carry 3-9, and 16 carry 10 or more. On a
-- shared line LIMIT 1 is a coin flip, and the result is an agent reading a
-- stranger's name to a customer. A call with no name is honest; a call with the
-- wrong name is not.
--
-- resolveCallCustomerName() now requires COUNT(DISTINCT name) = 1 before it will
-- assert anything. This clears the names that were asserted where the number
-- identifies 10 or more people, which cannot be right under any reading.
--
-- The 2-9 cases are deliberately LEFT ALONE: many are the same person under two
-- CIFs (a CIF is a card, not a person) or a household, so the name is plausibly
-- correct, and blanking would also destroy names Zoho supplied from its own
-- contact record — which are trustworthy. Those are flagged for review rather
-- than guessed at in either direction.
--
-- Idempotent: safe to re-run.

WITH junk AS (
  SELECT right(regexp_replace(COALESCE(phone,''),'\D','','g'),10) AS ph
    FROM app.customers
   WHERE right(regexp_replace(COALESCE(phone,''),'\D','','g'),10) <> ''
     AND NULLIF(TRIM(full_name),'') IS NOT NULL
   GROUP BY 1
  HAVING COUNT(DISTINCT NULLIF(TRIM(full_name),'')) >= 10
)
UPDATE app.helpdesk_calls h
   SET customer_name = '', customer_cif = ''
  FROM junk j
 WHERE right(regexp_replace(COALESCE(h.customer_phone,''),'\D','','g'),10) = j.ph;

-- A view so the shared-line cases can be reviewed rather than silently trusted.
CREATE OR REPLACE VIEW app.calls_on_shared_numbers AS
SELECT h.id, h.started_at, h.customer_phone, h.customer_name, h.agent_name,
       (SELECT COUNT(DISTINCT NULLIF(TRIM(c.full_name),''))
          FROM app.customers c
         WHERE right(regexp_replace(COALESCE(c.phone,''),'\D','','g'),10)
             = right(regexp_replace(COALESCE(h.customer_phone,''),'\D','','g'),10)) AS people_on_this_number
  FROM app.helpdesk_calls h
 WHERE NULLIF(TRIM(h.customer_name),'') IS NOT NULL;

COMMENT ON VIEW app.calls_on_shared_numbers IS
  'Calls whose number belongs to more than one customer. people_on_this_number > 1 '
  'means the name may be the wrong member of a household or a duplicate CIF.';

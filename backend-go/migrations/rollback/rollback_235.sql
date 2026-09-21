-- The UPDATE that populated these from `raw` is not reversed: the values are
-- copies of what is still in cbs_customers.raw, so dropping the columns loses
-- nothing. raw is untouched by migration 235.
COMMENT ON COLUMN app.cbs_customers.city IS NULL;

ALTER TABLE app.cbs_customers
  DROP COLUMN IF EXISTS religion,
  DROP COLUMN IF EXISTS hometown,
  DROP COLUMN IF EXISTS nok_gender;

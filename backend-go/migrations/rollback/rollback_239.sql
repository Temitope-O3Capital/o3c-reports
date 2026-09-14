-- Rollback 239_card_product_definition.sql
--
-- Order matters: Blink must go back to 'prepaid' BEFORE the old CHECK is
-- restored, or the constraint is rejected by the row it was widened for.

DROP INDEX IF EXISTS app.idx_card_products_category;
DROP INDEX IF EXISTS app.idx_card_products_core_product;

UPDATE app.card_products SET category = 'prepaid' WHERE category = 'blink';

ALTER TABLE app.card_products DROP CONSTRAINT IF EXISTS card_products_category_check;
ALTER TABLE app.card_products
  ADD CONSTRAINT card_products_category_check
  CHECK (category IN ('prepaid', 'credit'));

ALTER TABLE app.card_products
  DROP COLUMN IF EXISTS core_product_id,
  DROP COLUMN IF EXISTS scheme,
  DROP COLUMN IF EXISTS currency,
  DROP COLUMN IF EXISTS loan_linked,
  DROP COLUMN IF EXISTS pre_issued,
  DROP COLUMN IF EXISTS pinless,
  DROP COLUMN IF EXISTS contactless,
  DROP COLUMN IF EXISTS fx_funded,
  DROP COLUMN IF EXISTS is_temporary,
  DROP COLUMN IF EXISTS is_cooperative;

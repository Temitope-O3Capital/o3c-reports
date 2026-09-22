-- Rollback for 241_card_sale_attribution
--
-- Order matters: the view reads both tables, so it goes first.
DROP VIEW IF EXISTS app.v_card_sale_officer;

DROP INDEX IF EXISTS app.idx_card_sale_attr_cif;
DROP INDEX IF EXISTS app.idx_card_sale_attr_officer;
DROP TABLE IF EXISTS app.card_sale_attributions;

DROP INDEX IF EXISTS app.idx_card_iss_account;
DROP INDEX IF EXISTS app.idx_card_iss_officer;
ALTER TABLE app.card_issuance_requests
  DROP COLUMN IF EXISTS card_pan,
  DROP COLUMN IF EXISTS account_no,
  DROP COLUMN IF EXISTS introducer,
  DROP COLUMN IF EXISTS sales_officer_id;

-- One-time consolidation: core.* -> clean app.customers/accounts/transactions.
-- Collapses the raw/src/core/hist duplication into one clean set; keeps the app
-- working via rebased compat views + a recon bridge. Atomic: readers see old or new.
-- Run once against the production DB (Sage/ingest already being retired).
BEGIN;

-- 1. Fold the two columns the views borrow from src into core (before dropping src)
ALTER TABLE core.customer ADD COLUMN IF NOT EXISTS job_title text;
UPDATE core.customer c SET job_title = sc.job_title
  FROM src.contact sc WHERE sc.contact_id = c.contact_id AND (c.job_title IS NULL OR c.job_title = '');

ALTER TABLE core.account ADD COLUMN IF NOT EXISTS card_product text;
UPDATE core.account a SET card_product = sa.card_product
  FROM src.account sa WHERE sa.account_id = a.account_id AND (a.card_product IS NULL OR a.card_product = '');

-- 2. Enrichments carried from the feed.* design
ALTER TABLE core.account ADD COLUMN IF NOT EXISTS product_line text;
UPDATE core.account SET product_line = CASE
  WHEN product_name = 'PREP' THEN 'prepaid'
  WHEN product_name ILIKE 'Amex%' THEN 'credit_card'
  WHEN product_name ILIKE '%COOP%' OR product_name ILIKE '%MEMCOS%' OR product_name ILIKE '%NIMCOS%'
       OR product_name ILIKE '%NOHIL%' OR product_name ILIKE '%Deposit%' THEN 'deposit'
  WHEN product_name ILIKE '%Classic%' OR product_name ILIKE '%Prestige%' OR product_name ILIKE '%Platinum%'
       OR product_name ILIKE '%Charge%' OR product_name ILIKE '%Business%' OR product_name ILIKE 'BB %'
       OR product_name ILIKE '%Financial Inclusion%' THEN 'credit_card'
  ELSE 'other' END
  WHERE product_line IS NULL;

ALTER TABLE core.transaction ADD COLUMN IF NOT EXISTS channel text;
UPDATE core.transaction SET channel = CASE
  WHEN txn_code IN ('300','200','423','903','303','202','302','250','252','350','352','353','472','473') THEN 'interswitch'
  WHEN txn_code IN ('402','400','401','403','405','411','412','413','414','415','416','452') THEN 'collection'
  ELSE 'internal' END
  WHERE channel IS NULL;

-- 3. Drop the views that bind to core.*/src.* (recreated after the rename)
DROP VIEW IF EXISTS app."Accounts";
DROP VIEW IF EXISTS app."Products";
DROP VIEW IF EXISTS app."Transactions";
DROP VIEW IF EXISTS app."CIF Table";
DROP VIEW IF EXISTS core.v_account;
DROP VIEW IF EXISTS core.v_customer;
DROP VIEW IF EXISTS core.v_transaction;
DROP VIEW IF EXISTS core.v_data_quality;
DROP VIEW IF EXISTS core.v_orphan;

-- 4. Rename core.* -> clean app.* names
ALTER TABLE core.customer    SET SCHEMA app;  ALTER TABLE app.customer    RENAME TO customers;
ALTER TABLE core.account     SET SCHEMA app;  ALTER TABLE app.account     RENAME TO accounts;
ALTER TABLE core.transaction SET SCHEMA app;  ALTER TABLE app.transaction RENAME TO transactions;

-- 5. Recon bridge — the deployed binary still reads core.transaction until Stage 2 deploy
CREATE VIEW core.transaction AS SELECT * FROM app.transactions;

-- 6. Rebase the compat views onto the clean tables (identical output columns → handlers unchanged)
CREATE VIEW app."Accounts" AS
  SELECT cif AS "CIF Number", account_created AS "Account Created Date", first_name AS "First Name",
         last_name AS "Last Name", full_address AS "Full Address", birthday AS "Birthday",
         email AS "Email", phone AS "Phone Number", job_title AS "Job Title", state AS "State", city AS "City"
  FROM app.customers WHERE cif IS NOT NULL;

CREATE VIEW app."Products" AS
  SELECT cif AS "CIF Number", name_on_card AS "Name On Card", NULL::text AS "Account Manager",
         product_name AS "Product Name", status AS "Account Status",
         COALESCE(card_product, card_program) AS "Card Product", opened_date AS "Account Created Date"
  FROM app.accounts WHERE cif IS NOT NULL;

CREATE VIEW app."Transactions" AS
  SELECT txn_date AS "Transaction Date", amount AS "Amount", description AS "Description",
         merchant_name AS "Merchant_Name", cif AS "CIF Number"
  FROM app.transactions WHERE cif IS NOT NULL;

CREATE VIEW app."CIF Table" AS
  SELECT c.cif AS "CIF Number",
         COALESCE(c.account_created, mo.first_open::timestamp without time zone)::date AS "Cohort Date",
         to_char(COALESCE(c.account_created, mo.first_open::timestamp without time zone), 'YYYY-MM') AS "Cohort Label"
  FROM app.customers c
  LEFT JOIN (SELECT cif, min(opened_date) AS first_open FROM app.accounts WHERE cif IS NOT NULL GROUP BY cif) mo
    ON mo.cif = c.cif
  WHERE c.cif IS NOT NULL;

-- 7. Drop the redundant duplicate pipeline schemas (data now lives in app.*)
DROP SCHEMA src  CASCADE;
DROP SCHEMA raw  CASCADE;
DROP SCHEMA hist CASCADE;

COMMIT;

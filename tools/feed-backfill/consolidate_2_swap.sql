-- Part 2 of 2: the fast atomic swap. Run AFTER consolidate_1_enrich.sql.
-- Renames core.* -> clean app.* names, rebases the compat views, bridges recon,
-- and drops the redundant src/raw/hist schemas. All DDL — commits in seconds.
BEGIN;

DROP VIEW IF EXISTS app."Accounts";
DROP VIEW IF EXISTS app."Products";
DROP VIEW IF EXISTS app."Transactions";
DROP VIEW IF EXISTS app."CIF Table";
DROP VIEW IF EXISTS core.v_account;
DROP VIEW IF EXISTS core.v_customer;
DROP VIEW IF EXISTS core.v_transaction;
DROP VIEW IF EXISTS core.v_data_quality;
DROP VIEW IF EXISTS core.v_orphan;

ALTER TABLE core.customer    SET SCHEMA app;  ALTER TABLE app.customer    RENAME TO customers;
ALTER TABLE core.account     SET SCHEMA app;  ALTER TABLE app.account     RENAME TO accounts;
ALTER TABLE core.transaction SET SCHEMA app;  ALTER TABLE app.transaction RENAME TO transactions;

-- recon bridge — deployed binary keeps reading core.transaction until Stage 2 deploy
CREATE VIEW core.transaction AS SELECT * FROM app.transactions;

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

DROP SCHEMA src  CASCADE;
DROP SCHEMA raw  CASCADE;
DROP SCHEMA hist CASCADE;

COMMIT;

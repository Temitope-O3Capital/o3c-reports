-- 213: exclude test/dummy/vendor records at the legacy view layer.
--
-- app."Accounts" and app."Products" are VIEWS that already read the new base tables
-- (app.customers / app.accounts) — the identity read-lineage is already unified. This
-- adds the same test/dummy/vendor exclusion the feed loaders and the customer directory
-- use, so every remaining consumer of these views (CBS reconcile, statement emails) also
-- sees a clean customer/card set. Views only: no data is changed and it is fully
-- reversible. Tables are schema-qualified (the originals relied on search_path).

CREATE OR REPLACE VIEW app."Accounts" AS
 SELECT cif             AS "CIF Number",
        account_created AS "Account Created Date",
        first_name      AS "First Name",
        last_name       AS "Last Name",
        full_address    AS "Full Address",
        birthday        AS "Birthday",
        email           AS "Email",
        phone           AS "Phone Number",
        job_title       AS "Job Title",
        state           AS "State",
        city            AS "City"
   FROM app.customers
  WHERE cif IS NOT NULL
    AND (COALESCE(full_name,'') || ' ' || COALESCE(first_name,'') || ' ' || COALESCE(last_name,''))
        !~* '\m(test|bevertec|dummy)\M|testcard|questtest';

CREATE OR REPLACE VIEW app."Products" AS
 SELECT cif                                  AS "CIF Number",
        name_on_card                         AS "Name On Card",
        NULL::text                           AS "Account Manager",
        product_name                         AS "Product Name",
        status                               AS "Account Status",
        COALESCE(card_product, card_program) AS "Card Product",
        opened_date                          AS "Account Created Date"
   FROM app.accounts
  WHERE cif IS NOT NULL
    AND COALESCE(name_on_card,'') !~* '\m(test|bevertec|dummy)\M';

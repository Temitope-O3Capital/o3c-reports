-- 214: extend the legacy-view test-record exclusion to the "Fastest *" demo card batch.
--
-- Follows migration 213. "Fastest Male/Female/Snr/Jnr" (CIF block 00003294-00003300) is a
-- contiguous demo/test card set, so 'fastest' joins the whole-word exclusion. Same pattern
-- is applied in the feed loaders and the customer directory/search (code). Views only,
-- reversible, no data change.

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
        !~* '\m(test|bevertec|dummy|fastest)\M|testcard|questtest';

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
    AND COALESCE(name_on_card,'') !~* '\m(test|bevertec|dummy|fastest)\M|testcard|questtest';

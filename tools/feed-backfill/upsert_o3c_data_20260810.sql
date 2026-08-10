-- ============================================================================
-- Upsert app.customers / app.accounts from "O3C Data.xlsx" (cust_file.20260714)
-- Policy: enrich + safe overwrites on existing (protect cleaned state); insert
-- new customers + accounts; derive & clean COUNTRY. Card-only / CIF-keyed file.
-- Backups: app.customers_bak_20260810, app.accounts_bak_20260810.
-- Staging: app.stg_o3c_data (already loaded, cif normalized to 8-digit).
-- ============================================================================

-- ── Reference A: foreign token → country ───────────────────────────────────
-- Contains BOTH region tokens (used to detect foreign contacts from the file's
-- state/city) AND country-name variants (used to canonicalise the existing
-- dirty app.customers.country). Anything NOT matched here is treated as Nigeria.
DROP TABLE IF EXISTS app.ref_foreign;
CREATE TABLE app.ref_foreign (token text PRIMARY KEY, country text);
INSERT INTO app.ref_foreign(token,country) VALUES
 -- country-name variants (existing db values)
 ('UNITED KINGDOM','United Kingdom'),('UK','United Kingdom'),('ENGLAND','United Kingdom'),('GB','United Kingdom'),
 ('UNITED STATES','United States'),('USA','United States'),('US','United States'),('UNITED STATES OF AMERICA','United States'),
 ('CANADA','Canada'),('KENYA','Kenya'),('IRELAND','Ireland'),('GHANA','Ghana'),
 ('SOUTH AFRICA','South Africa'),('GERMANY','Germany'),('INDIA','India'),
 ('UNITED ARAB EMIRATES','United Arab Emirates'),('UAE','United Arab Emirates'),
 -- United Kingdom regions
 ('ESSEX','United Kingdom'),('KENT','United Kingdom'),('HOVE','United Kingdom'),('LONDON','United Kingdom'),
 ('BUCKINGHAMSHIRE','United Kingdom'),('EAST SUSSEX','United Kingdom'),('WARWICKSHIRE','United Kingdom'),
 ('SURREY','United Kingdom'),('HERTFORDSHIRE','United Kingdom'),('MANCHESTER','United Kingdom'),
 ('BIRMINGHAM','United Kingdom'),('BN3 7QT','United Kingdom'),
 -- United States regions
 ('MASSACHUSETTS','United States'),('GEORGIA','United States'),('NEW JERSEY','United States'),('ARIZONA','United States'),
 ('TEXAS','United States'),('CALIFORNIA','United States'),('DELAWARE','United States'),('MARYLAND','United States'),('NEW YORK','United States'),
 -- Canada regions
 ('ONTARIO','Canada'),('TORONTO','Canada'),('ALBERTA','Canada'),('QUEBEC','Canada'),
 -- Kenya regions
 ('NAIROBI','Kenya'),('NAIRAOBI','Kenya'),('MOMBASA','Kenya'),
 -- South Africa regions
 ('KWAZULU-NATAL','South Africa'),('GAUTENG','South Africa'),('JOHANNESBURG','South Africa'),('CAPE TOWN','South Africa'),
 -- India / Ireland / Ghana / UAE / Germany regions
 ('MAHARASHTRA','India'),('DELHI','India'),
 ('COUNTY CLARE','Ireland'),('COUNTY DUBLIN','Ireland'),('DUBLIN','Ireland'),
 ('GREATER ACCRA REGION','Ghana'),('ACCRA','Ghana'),
 ('DUBAI','United Arab Emirates'),('ABU DHABI','United Arab Emirates'),
 ('BADEN-WÜRTTEMBERG','Germany');

-- ── Reference B: Nigerian state/locality token → canonical state ────────────
DROP TABLE IF EXISTS app.ref_ng_state;
CREATE TABLE app.ref_ng_state (token text PRIMARY KEY, canonical text);
INSERT INTO app.ref_ng_state(token,canonical) VALUES
 ('LAGOS','Lagos'),('LAGOS STATE','Lagos'),('LAGOD','Lagos'),('LAOS','Lagos'),('LAGIS','Lagos'),
 ('LAGOSA','Lagos'),('LAGIOS','Lagos'),('LAGOOS','Lagos'),('LAGSO','Lagos'),('LAGOPS','Lagos'),
 ('LAGOSLAGOS','Lagos'),('LOGOS','Lagos'),('LAGGOS','Lagos'),('LAGOS`','Lagos'),('IKOYI LAGOS','Lagos'),
 ('LEKKI','Lagos'),('IKOYI','Lagos'),('ALAUSA','Lagos'),('IGANMU','Lagos'),('SANGOTEDO','Lagos'),('APAPA','Lagos'),
 ('FCT','FCT'),('ABUJA','FCT'),('FCT ABUJA','FCT'),('ABUJA FCT','FCT'),('FEDERAL CAPITAL TERRITORY','FCT'),
 ('WUSE ZONE 5 ABUJA','FCT'),('ABUJA2','FCT'),('KARMO','FCT'),
 ('OYO','Oyo'),('OYO STATE','Oyo'),('OYO STAE','Oyo'),('IBADAN','Oyo'),('OGBOMOSHO','Oyo'),('AJIBADE','Oyo'),
 ('OGUN','Ogun'),('OGUN STATE','Ogun'),('OGU N','Ogun'),
 ('RIVERS','Rivers'),('RIVERS STATE','Rivers'),('RIVER STATE','Rivers'),('PORT HARCOURT','Rivers'),
 ('AKWA IBOM','Akwa Ibom'),('AKWA IBOM STATE','Akwa Ibom'),
 ('NASARAWA','Nasarawa'),('NASSARAWA','Nasarawa'),('NASARRAWA','Nasarawa'),('NASARAWA STATE','Nasarawa'),
 ('DELTA','Delta'),('DELTA STATE','Delta'),
 ('ENUGU','Enugu'),('ENUGU STATE','Enugu'),
 ('EDO','Edo'),('EDO STATE','Edo'),
 ('KWARA','Kwara'),('KWARA STATE','Kwara'),
 ('KANO','Kano'),('KANO STATE','Kano'),('KANOO','Kano'),
 ('KOGI','Kogi'),('KOGI STATE','Kogi'),
 ('BENUE','Benue'),('BENUE STATE','Benue'),
 ('CROSS RIVER','Cross River'),('CROSS RIVER STATE','Cross River'),
 ('OSUN','Osun'),('OSUN STATE','Osun'),
 ('TARABA','Taraba'),('TARABA STATE','Taraba'),
 ('ADAMAWA','Adamawa'),('ADAMAWA STATE','Adamawa'),('YOLA','Adamawa'),
 ('SOKOTO','Sokoto'),('SOKOTO STATE','Sokoto'),
 ('ABIA','Abia'),('ABIA STATE','Abia'),
 ('IMO','Imo'),('IMO STATE','Imo'),
 ('ANAMBRA','Anambra'),('ANAMBRA STATE','Anambra'),
 ('KADUNA','Kaduna'),('KADUNA STATE','Kaduna'),('ZARIA','Kaduna'),
 ('KATSINA','Katsina'),('KATSINA STATE','Katsina'),
 ('NIGER','Niger'),('NIGER STATE','Niger'),
 ('EKITI','Ekiti'),('ONDO','Ondo'),('EBONYI','Ebonyi'),('BORNO','Borno'),('BAUCHI','Bauchi'),
 ('PLATEAU','Plateau'),('GOMBE','Gombe'),('BAYELSA','Bayelsa'),('JIGAWA','Jigawa'),('KEBBI','Kebbi'),
 ('YOBE','Yobe'),('ZAMFARA','Zamfara');

-- ============================================================================
-- Normalized view of the staged file (one row per CIF)
-- ============================================================================
DROP VIEW IF EXISTS app.v_o3c_norm;
CREATE VIEW app.v_o3c_norm AS
SELECT
  s.cif,
  s.acct_number                                                      AS account_no,
  nullif(trim(s.product),'')                                         AS product_name,
  initcap(regexp_replace(trim(s.first_name),'\s+',' ','g'))          AS first_name,
  initcap(regexp_replace(trim(s.last_name),'\s+',' ','g'))           AS last_name,
  initcap(regexp_replace(trim(s.first_name||' '||s.last_name),'\s+',' ','g')) AS full_name,
  nullif(trim(s.address_1),'')                                       AS address_1,
  nullif(trim(s.address_2),'')                                       AS address_2,
  lower(nullif(trim(s.email),''))                                    AS email,
  CASE
    WHEN length(regexp_replace(coalesce(nullif(s.phone2,''),s.phone1,''),'\D','','g')) >= 10
      THEN '0'||right(regexp_replace(coalesce(nullif(s.phone2,''),s.phone1,''),'\D','','g'),10)
    WHEN regexp_replace(coalesce(nullif(s.phone2,''),s.phone1,''),'\D','','g') <> ''
      THEN regexp_replace(coalesce(nullif(s.phone2,''),s.phone1,''),'\D','','g')
    ELSE NULL
  END                                                                AS phone,
  ns.canonical                                                       AS state_canon,
  CASE WHEN fr.country IS NULL THEN initcap(nullif(trim(s.city),'')) ELSE NULL END AS city_canon,
  fr.country                                                         AS foreign_country
FROM app.stg_o3c_data s
LEFT JOIN app.ref_ng_state ns ON ns.token = upper(trim(coalesce(s.state,'')))
LEFT JOIN app.ref_foreign  fr ON fr.token = upper(trim(coalesce(s.state,'')))
                              OR fr.token = upper(trim(coalesce(s.city,'')))
WHERE s.cif IS NOT NULL;

BEGIN;

-- 1. UPDATE existing customers (enrich + safe overwrites; protect state) ─────
UPDATE app.customers c SET
  email      = CASE WHEN n.email IS NOT NULL AND (c.email IS NULL OR c.email='' OR lower(c.email)<>n.email)
                    THEN n.email ELSE c.email END,
  phone      = CASE WHEN n.phone IS NOT NULL
                     AND (c.phone IS NULL OR c.phone=''
                          OR right(regexp_replace(c.phone,'\D','','g'),10) <> right(regexp_replace(n.phone,'\D','','g'),10))
                    THEN n.phone ELSE c.phone END,
  full_name  = CASE WHEN n.full_name IS NOT NULL AND lower(n.full_name)<>lower(coalesce(c.full_name,''))
                    THEN n.full_name ELSE c.full_name END,
  first_name = CASE WHEN n.full_name IS NOT NULL AND lower(n.full_name)<>lower(coalesce(c.full_name,''))
                    THEN n.first_name ELSE c.first_name END,
  last_name  = CASE WHEN n.full_name IS NOT NULL AND lower(n.full_name)<>lower(coalesce(c.full_name,''))
                    THEN n.last_name ELSE c.last_name END,
  address_1  = CASE WHEN n.address_1 IS NOT NULL AND lower(coalesce(c.address_1,''))<>lower(n.address_1)
                    THEN n.address_1 ELSE c.address_1 END,
  address_2  = CASE WHEN n.address_2 IS NOT NULL AND lower(coalesce(c.address_2,''))<>lower(n.address_2)
                    THEN n.address_2 ELSE c.address_2 END,
  city       = CASE WHEN n.city_canon IS NOT NULL AND lower(coalesce(c.city,''))<>lower(n.city_canon)
                    THEN n.city_canon ELSE c.city END,
  state      = CASE WHEN (c.state IS NULL OR trim(c.state)='') AND n.state_canon IS NOT NULL
                    THEN n.state_canon ELSE c.state END,
  country    = COALESCE(n.foreign_country,
                        (SELECT f.country FROM app.ref_foreign f WHERE f.token = upper(trim(coalesce(c.country,'')))),
                        'Nigeria'),
  last_seen  = now()
FROM app.v_o3c_norm n
WHERE c.cif = n.cif;

-- 2. INSERT new customers (CIF not present) ─────────────────────────────────
WITH base AS (SELECT ('x'||max(contact_id))::bit(64)::bigint AS maxid FROM app.customers),
newc AS (
  SELECT n.*, row_number() OVER (ORDER BY n.cif) AS rn
  FROM app.v_o3c_norm n
  WHERE NOT EXISTS (SELECT 1 FROM app.customers c WHERE c.cif = n.cif)
)
INSERT INTO app.customers
  (contact_id, cif, full_name, first_name, last_name, email, phone,
   address_1, address_2, city, state, country, source, source_file, last_seen, created_at)
SELECT
  upper(lpad(to_hex((SELECT maxid FROM base) + rn), 16, '0')),
  newc.cif, newc.full_name, newc.first_name, newc.last_name, newc.email, newc.phone,
  newc.address_1, newc.address_2, newc.city_canon, newc.state_canon,
  COALESCE(newc.foreign_country,'Nigeria'),
  'o3c_data_20260714', 'O3C Data.xlsx', now(), now()
FROM newc;

-- 3. INSERT new accounts (account_no not present); link contact_id by CIF ────
WITH pmap AS (
  SELECT DISTINCT ON (product_name) product_name, product_id
  FROM app.accounts WHERE product_name IS NOT NULL AND product_id IS NOT NULL
  ORDER BY product_name, product_id
),
base AS (SELECT ('x'||max(account_id))::bit(64)::bigint AS maxid FROM app.accounts),
newa AS (
  SELECT DISTINCT ON (s.account_no)
         s.account_no, s.cif, s.product_name,
         row_number() OVER (ORDER BY s.account_no) AS rn
  FROM app.v_o3c_norm s
  WHERE s.account_no IS NOT NULL AND s.account_no <> ''
    AND NOT EXISTS (SELECT 1 FROM app.accounts a WHERE a.account_no = s.account_no)
  ORDER BY s.account_no
)
INSERT INTO app.accounts
  (account_id, account_no, contact_id, cif, product_id, product_name,
   status, source, source_file, last_seen)
SELECT
  upper(lpad(to_hex((SELECT maxid FROM base) + newa.rn), 16, '0')),
  newa.account_no, c.contact_id, newa.cif, pmap.product_id,
  COALESCE(newa.product_name, pmap.product_name),
  'active', 'o3c_data_20260714', 'O3C Data.xlsx', now()
FROM newa
LEFT JOIN app.customers c ON c.cif = newa.cif
LEFT JOIN pmap ON pmap.product_name = newa.product_name;

-- 4. Clean COUNTRY for every customer the file didn't touch (foreign set → its
--    country; everything else — Nigeria misspellings, places, junk, blank →
--    Nigeria). Rows updated in step 1/2 already carry a clean value.
UPDATE app.customers c
SET country = COALESCE((SELECT f.country FROM app.ref_foreign f WHERE f.token = upper(trim(coalesce(c.country,'')))),
                       'Nigeria')
WHERE c.country IS DISTINCT FROM
      COALESCE((SELECT f.country FROM app.ref_foreign f WHERE f.token = upper(trim(coalesce(c.country,'')))),
               'Nigeria');

COMMIT;

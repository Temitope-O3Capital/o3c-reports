-- Part 1 of 2: additive enrichment (idempotent, no long locks — safe to run slowly).
-- Adds the columns the compat views need + the feed.* enrichments, on core.* in place.
-- Run this BEFORE consolidate_2_swap.sql.

ALTER TABLE core.customer ADD COLUMN IF NOT EXISTS job_title text;
UPDATE core.customer c SET job_title = sc.job_title
  FROM src.contact sc WHERE sc.contact_id = c.contact_id AND (c.job_title IS NULL OR c.job_title = '');

ALTER TABLE core.account ADD COLUMN IF NOT EXISTS card_product text;
UPDATE core.account a SET card_product = sa.card_product
  FROM src.account sa WHERE sa.account_id = a.account_id AND (a.card_product IS NULL OR a.card_product = '');

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

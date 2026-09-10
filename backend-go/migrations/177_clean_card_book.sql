-- 177_clean_card_book.sql
--
-- Cleans app.accounts (the card book) and gives the Card Operations module a
-- card state it can trust.
--
-- What was wrong, by source — each contributed one distinct defect:
--
--   feed (187 rows, live)     100% blank status. acct_file has no status field at
--                             all (DATA_FEED_INGESTION §3.2 lists 20 positional
--                             fields; none is a status), so the feed CANNOT
--                             populate it and this will keep happening.
--   o3c_data_20260714 (541)   status written lower-case ('active' vs 'Active').
--   mssql_baseline (19,935)   'LEGAL ACTI' — a truncated 'LEGAL ACTION' — plus 425
--                             card_pan values that are the literal 'XXXXXXXXX'.
--
-- And across all sources: 17,984 of 20,663 cards (87%) are past their expiry date,
-- of which 16,215 still say Open or Active. The status column simply does not
-- track expiry, so the module could not tell a live card from a dead one.
--
-- Safe to normalise in place: the acct_file upsert never writes `status`,
-- `collection_type` or `product_line` (they are absent from its ON CONFLICT SET
-- list), so the feed cannot undo any of this on its next run.
--
-- Reversible: scrap.bk20260820_accounts_full.

CREATE SCHEMA IF NOT EXISTS scrap;
CREATE TABLE IF NOT EXISTS scrap.bk20260820_accounts_full AS SELECT * FROM app.accounts;

-- 1. Status vocabulary. Casing is a source artefact, not a distinction: the same
--    word arrived capitalised from one feed and lower-case from another. Open and
--    Active are deliberately NOT merged — they are different populations (Open
--    averages a 180k limit and is 6% unexpired; Active averages 670k and 20%), and
--    collapsing them would destroy a distinction the business may rely on.
UPDATE app.accounts SET status = 'LEGAL ACTION'
 WHERE TRIM(status) = 'LEGAL ACTI';                       -- truncated in the extract
UPDATE app.accounts SET status = NULL
 WHERE upper(TRIM(COALESCE(status,''))) IN ('UNDEFINED','');  -- a literal 'UNDEFINED' is not a status
UPDATE app.accounts
   SET status = upper(left(TRIM(status),1)) || lower(substr(TRIM(status),2))
 WHERE status IS NOT NULL
   AND TRIM(status) <> ''
   AND status <> upper(left(TRIM(status),1)) || lower(substr(TRIM(status),2))
   AND upper(TRIM(status)) NOT IN ('LEGAL ACTION');       -- keep the two-word label as-is

-- 2. collection_type: NIBBS is a misspelling of NIBSS (128 vs 1).
UPDATE app.accounts SET collection_type = 'NIBSS' WHERE TRIM(collection_type) = 'NIBBS';

-- 3. product_line. 'credit_card' is a stray alias for 'card'; blanks are derivable
--    from the product name using the same rule the Go feed applies (acctfeed.ProductLine).
UPDATE app.accounts SET product_line = 'card' WHERE product_line = 'credit_card';
UPDATE app.accounts
   SET product_line = CASE
         WHEN upper(product_name) LIKE '%PREP%'                                     THEN 'prepaid'
         WHEN upper(product_name) LIKE '%COOP%' OR upper(product_name) LIKE '%MEMCOS%' THEN 'deposit'
         ELSE 'card' END
 WHERE COALESCE(TRIM(product_line),'') = ''
   AND COALESCE(TRIM(product_name),'') <> '';

-- 4. 'XXXXXXXXX' is a placeholder, not a card number. Held by 425 rows across 415
--    different CIFs, so it also made the PAN look non-unique. NULL states the truth.
UPDATE app.accounts SET card_pan = NULL WHERE TRIM(COALESCE(card_pan,'')) = 'XXXXXXXXX';

-- 5. The state the module should actually read.
--
--    Expiry beats status. A card past its expiry date is not open whatever the
--    status column says, and 16,215 rows assert exactly that. Ordering matters:
--    a terminated card stays terminated even if it also expired, because how it
--    ended is more informative than that it lapsed.
CREATE OR REPLACE VIEW app.card_book AS
SELECT a.*,
       CASE
         WHEN upper(COALESCE(a.status,'')) = 'TERMINATED'   THEN 'Terminated'
         WHEN upper(COALESCE(a.status,'')) = 'LEGAL ACTION' THEN 'Legal action'
         WHEN upper(COALESCE(a.status,'')) = 'SUSPENDED'    THEN 'Suspended'
         WHEN upper(COALESCE(a.status,'')) = 'HOT'          THEN 'Hot listed'
         WHEN a.card_expiry_date IS NOT NULL
              AND a.card_expiry_date < CURRENT_DATE        THEN 'Expired'
         WHEN upper(COALESCE(a.status,'')) = 'INACTIVE'     THEN 'Inactive'
         WHEN COALESCE(TRIM(a.status),'') = ''              THEN 'Unknown'
         ELSE 'Live'
       END AS card_state,
       (a.card_expiry_date IS NOT NULL AND a.card_expiry_date < CURRENT_DATE) AS is_expired
  FROM app.accounts a;

COMMENT ON VIEW app.card_book IS
  'The card book with a trustworthy card_state. Read this, not app.accounts.status: '
  'status does not track expiry, and 87% of the book is past its expiry date while '
  'still marked Open or Active.';

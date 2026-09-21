-- 241: Attribute card sales to the person who brought them in.
--
-- Cards were the only product with no owner. Fixed deposits credit an officer through
-- fd_transactions.sales_officer_id (migration 100) and loans through cbs_officer_map on
-- the CBS officer name. Cards had neither, so every card-per-officer figure fell back to
-- customer_officers -- the CIF book -- and came out empty: 0 of the 486 card and prepaid
-- accounts opened this year resolved to an officer, because cards are not in CBS and the
-- acct_file feed carries no officer column at all.
--
-- Two ways in, because both are real:
--
--   * card_issuance_requests gains the seller at the point of sale, for cards the
--     workspace originates from here on.
--   * card_sale_attributions records the seller against an already-issued card, for the
--     17,755 cards that exist today and for anything sold outside the workspace. Keyed
--     on account_no (unique across app.accounts, 0 duplicates) rather than CIF, because
--     a card holder need not be a fully registered customer.
--
-- introducer is free text and deliberately mirrors credit_applications.introducer: the
-- person who brought the business when they are not the booking officer. That is how
-- non-sales staff get credited without being given a sales target.

-- Point of sale -------------------------------------------------------------------
ALTER TABLE app.card_issuance_requests
  ADD COLUMN IF NOT EXISTS sales_officer_id BIGINT REFERENCES app.o3c_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS introducer       TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS account_no       TEXT,
  ADD COLUMN IF NOT EXISTS card_pan         TEXT;

CREATE INDEX IF NOT EXISTS idx_card_iss_officer
  ON app.card_issuance_requests(sales_officer_id) WHERE sales_officer_id IS NOT NULL;

-- One issuance request per issued card, so the resolution view cannot fan out.
CREATE UNIQUE INDEX IF NOT EXISTS idx_card_iss_account
  ON app.card_issuance_requests(account_no) WHERE account_no IS NOT NULL;

-- Already-issued cards ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.card_sale_attributions (
  id               BIGSERIAL PRIMARY KEY,
  account_no       TEXT NOT NULL UNIQUE,
  cif              TEXT,
  sales_officer_id BIGINT REFERENCES app.o3c_users(id) ON DELETE SET NULL,
  introducer       TEXT NOT NULL DEFAULT '',
  -- manual: set by a person in the workspace. issuance: carried over when an issuance
  -- request was matched to the issued account. import: bulk-assigned from a file.
  basis_source     TEXT NOT NULL DEFAULT 'manual',
  issuance_id      BIGINT REFERENCES app.card_issuance_requests(id) ON DELETE SET NULL,
  note             TEXT NOT NULL DEFAULT '',
  attributed_by    BIGINT REFERENCES app.o3c_users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_card_sale_attr_officer
  ON app.card_sale_attributions(sales_officer_id) WHERE sales_officer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_card_sale_attr_cif
  ON app.card_sale_attributions(cif) WHERE cif IS NOT NULL;

-- Resolution ----------------------------------------------------------------------
-- One place that decides who owns a card sale, so the reports, the workspace and any
-- later consumer cannot drift apart. Priority: an explicit attribution beats the
-- issuance record, which beats the legacy CIF book. basis is exposed so a report can
-- say how a number was arrived at instead of implying all three are equally solid.
--
-- LATERAL ... LIMIT 1 on both joins: customer_officers has no uniqueness guarantee on
-- cif, and a duplicate there would otherwise silently double-count a card.
CREATE OR REPLACE VIEW app.v_card_sale_officer AS
SELECT a.account_no,
       a.cif,
       a.opened_date,
       a.product_line,
       a.product_name,
       a.status,
       COALESCE(sa.sales_officer_id, ir.sales_officer_id, co.officer_id) AS officer_id,
       NULLIF(COALESCE(NULLIF(sa.introducer, ''), NULLIF(ir.introducer, ''), ''), '') AS introducer,
       CASE
         WHEN sa.sales_officer_id IS NOT NULL THEN 'attributed'
         WHEN ir.sales_officer_id IS NOT NULL THEN 'issuance'
         WHEN co.officer_id       IS NOT NULL THEN 'legacy_book'
         ELSE 'unattributed'
       END AS basis
  FROM app.accounts a
  LEFT JOIN app.card_sale_attributions sa ON sa.account_no = a.account_no
  LEFT JOIN LATERAL (
       SELECT i.sales_officer_id, i.introducer
         FROM app.card_issuance_requests i
        WHERE i.account_no = a.account_no
        LIMIT 1) ir ON TRUE
  LEFT JOIN LATERAL (
       SELECT c.officer_id
         FROM app.customer_officers c
        WHERE c.cif = a.cif
        LIMIT 1) co ON TRUE
 WHERE a.product_line IN ('card', 'prepaid');

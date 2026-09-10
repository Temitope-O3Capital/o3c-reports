-- Customer ID becomes the root key for the credit book.
--
-- The agreed model: if you hold a loan or a card with us you have a CUSTOMER ID, and
-- every other identifier hangs under it. There are exactly three ids worth showing —
--
--   Customer ID  CUST-<party_id>   the person/company (app.parties)
--   CIF          00008136          a CARD, from CCS. One card = one CIF.
--   Udara id     00000637 / acct   the core-banking customer and loan account
--
-- Everything else was scaffolding. In particular the 41 `W0000000000000nn` handles
-- minted by the Loan Repayment CRM import (2026-09-07) for borrowers who hold a loan
-- and no card, and therefore had no CIF to be keyed by. They were never real ids: they
-- exist only in app.customers.contact_id and in the three columns below, all of which
-- are named "cif" but have always meant "customer key". `Z…` handles are the same idea
-- for feed-created card customers (there the real CIF is present alongside).
--
-- This migration stops those columns being the identity. party_id is added to the three
-- credit tables and backfilled, so reads can key on the customer and treat CIF and the
-- Udara id as attributes of that customer rather than as competing primary keys.
--
-- The account_cif columns are deliberately LEFT AS THEY ARE. They still carry the W
-- handles and are still what collection_payments/collection_assignments join on. Moving
-- the storage key is a second step that has to move every reader with it; this
-- migration makes the customer id available and correct first, additively and with no
-- behaviour change if a reader ignores it.

-- ── Columns ──────────────────────────────────────────────────────────────────
ALTER TABLE app.collection_assignments ADD COLUMN IF NOT EXISTS party_id BIGINT;
ALTER TABLE app.collection_payments    ADD COLUMN IF NOT EXISTS party_id BIGINT;
ALTER TABLE app.recovery_cases         ADD COLUMN IF NOT EXISTS party_id BIGINT;

COMMENT ON COLUMN app.collection_assignments.party_id IS
  'Customer ID (app.parties.party_id) — the root identity. account_cif is a CARD cif only when the borrower holds one; for loan-only borrowers it is an internal W handle with no external meaning.';
COMMENT ON COLUMN app.collection_payments.party_id IS
  'Customer ID (app.parties.party_id) — the root identity behind account_cif.';
COMMENT ON COLUMN app.recovery_cases.party_id IS
  'Customer ID (app.parties.party_id) — the root identity behind account_cif/cif_number.';

-- ── Backfill ─────────────────────────────────────────────────────────────────
-- app.customers is the crosswalk: its row key is the CIF when the customer holds a
-- card, and contact_id (W…/Z…) otherwise; party_id is the customer they resolve to.
UPDATE app.collection_assignments a
   SET party_id = c.party_id
  FROM app.customers c
 WHERE COALESCE(NULLIF(c.cif,''), c.contact_id) = a.account_cif
   AND c.party_id IS NOT NULL
   AND a.party_id IS DISTINCT FROM c.party_id;

UPDATE app.collection_payments p
   SET party_id = c.party_id
  FROM app.customers c
 WHERE COALESCE(NULLIF(c.cif,''), c.contact_id) = p.account_cif
   AND c.party_id IS NOT NULL
   AND p.party_id IS DISTINCT FROM c.party_id;

UPDATE app.recovery_cases r
   SET party_id = c.party_id
  FROM app.customers c
 WHERE COALESCE(NULLIF(c.cif,''), c.contact_id) = COALESCE(NULLIF(r.account_cif,''), r.cif_number)
   AND c.party_id IS NOT NULL
   AND r.party_id IS DISTINCT FROM c.party_id;

-- ── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_coll_assign_party ON app.collection_assignments (party_id);
CREATE INDEX IF NOT EXISTS idx_coll_pay_party    ON app.collection_payments (party_id);
CREATE INDEX IF NOT EXISTS idx_recovery_party    ON app.recovery_cases (party_id);

-- ── Identity resolution view ─────────────────────────────────────────────────
-- One row per customer, carrying the three ids that are allowed to be shown. Readers
-- use this instead of assembling identity from whatever column is to hand.
CREATE OR REPLACE VIEW app.credit_customer_ids AS
SELECT p.party_id,
       'CUST-' || LPAD(p.party_id::text, 6, '0')                      AS customer_id,
       MAX(p.full_name)                                               AS full_name,
       -- Real card CIFs only. W…/Z… handles are internal and never surface.
       ARRAY_REMOVE(ARRAY_AGG(DISTINCT NULLIF(c.cif,'')), NULL)       AS cifs,
       ARRAY_REMOVE(ARRAY_AGG(DISTINCT ul.cbs_customer_id), NULL)     AS udara_customer_ids,
       ARRAY_REMOVE(ARRAY_AGG(DISTINCT ul.cbs_account_number), NULL)  AS udara_loan_accounts
  FROM app.parties p
  LEFT JOIN app.customers c ON c.party_id = p.party_id
  LEFT JOIN cbs_loans   ul ON ul.cbs_customer_id = COALESCE(NULLIF(c.cif,''), c.contact_id)
                          AND ul.status NOT IN ('Closed','Revoked')
 GROUP BY p.party_id;

COMMENT ON VIEW app.credit_customer_ids IS
  'The only three identifiers the workspace shows for a credit customer: Customer ID (canonical), card CIFs, and Udara customer/loan accounts. Internal W/Z handles are excluded by construction.';

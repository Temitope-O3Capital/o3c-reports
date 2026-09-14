-- Card products get a real definition: three funding families, the attributes
-- that have been living in free text, and a bridge to core.product.
--
-- WHY THIS EXISTS
--
-- "What kind of card is this?" had eight different answers in this codebase, and
-- they disagree with each other on live rows:
--
--   1. app.card_products.category            the catalogue (this table)
--   2. handlers/eod.go:49                    hardcoded map of 10 codes -> legacy names
--   3. handlers/stubs.go:132                 Blink = product_name ILIKE '%blink%'
--   4. acctfeed.ProductLine (acctfeed.go)    name contains PREP -> prepaid, COOP -> deposit
--   5. migrations/177_clean_card_book.sql:52 the same rule again, in SQL
--   6. handlers/cards.go:132 + card_ops.go:732  a hardcoded 4-product list
--   7. handlers/products.go:41               regex classifier, falls through to credit_card
--   8. the ops tables' free-text card_type    no FK, no CHECK
--
-- The cost is not cosmetic. overview.go and executive.go string-match
-- product_name LIKE '%classic%' OR '%credit%' for "credit cards" while
-- cards_credit.go joins category='credit' — so the same phrase means different
-- populations on different screens. And #7 classifies anything containing
-- "card" as credit_card, which means the string "Blink Card" is a CREDIT CARD
-- to the Sales taxonomy today.
--
-- BLINK IS ITS OWN FAMILY, NOT A NOTE
--
-- Blink is one row (product_code 003, 'PREP Temporary Virtual') whose entire
-- identity is notes='Blink'. It is not a prepaid variant: the customer funds it
-- in foreign currency and is credited the naira equivalent, and the card is
-- temporary. That is a third funding model, so category gains 'blink' rather
-- than Blink continuing to hide inside 'prepaid'.
--
-- THE COOPERATIVES STAY 'credit'
--
-- LBIC / LIRS / INSIGHT / NOHIL / MEMCOS / NIMCOS / SSANU-UI are cooperative
-- schemes, and the instinct to call them prepaid is about how they are REPAID
-- (salary deduction through the co-op), not what the instrument is. The cycle
-- data settles it — at cycle 2026-07-14:
--
--   LIRS COOP    1,356 of 1,356 accounts carry a credit limit (N137.7m), N4.83m interest
--   MEMCOS       1,280 of 1,291 (N135.1m), N5.29m interest
--   SSANU-UI       137 of   274 (N14.8m),  N3.56m interest
--
-- against real prepaid, which carries no limits and charges no interest (PREP:
-- 1 limit in 12,475 accounts, zero interest) and holds NEGATIVE balances,
-- because a prepaid balance is the customer's own float. Reclassifying them
-- would have moved 3,229 of 5,073 accounts and N317.9m of receivables out of
-- the credit book. So they keep category='credit' and gain is_cooperative,
-- which is the fact anyone actually wants to filter on.
--
-- NIMCOS is the one exception worth watching: 0 limits and 0 interest across
-- 275 accounts, which looks prepaid. It is deliberately NOT reclassified here —
-- that needs a business answer, not a guess in a migration.

-- ── 1. Three funding families ───────────────────────────────────────────────
ALTER TABLE app.card_products DROP CONSTRAINT IF EXISTS card_products_category_check;
ALTER TABLE app.card_products
  ADD CONSTRAINT card_products_category_check
  CHECK (category IN ('prepaid', 'credit', 'blink'));

COMMENT ON COLUMN app.card_products.category IS
  'Funding family: credit (revolving, has a limit and charges interest) | prepaid (stored value, customer''s own float, negative balances) | blink (FX-funded temporary virtual card). Join this — never string-match product_name.';

-- ── 2. The attributes that were free text in notes ──────────────────────────
-- notes carried five distinct concepts as English: Contactless, Pinless,
-- Blink, Loan, "Pre-issued cards". Nothing can filter on English, so every
-- consumer string-matched instead. Each becomes a column; notes stays as the
-- human remark it was meant to be.
ALTER TABLE app.card_products
  ADD COLUMN IF NOT EXISTS is_cooperative  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_temporary    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS fx_funded       boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS contactless     boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pinless         boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pre_issued      boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS loan_linked     boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS currency        text,
  ADD COLUMN IF NOT EXISTS scheme          text,
  ADD COLUMN IF NOT EXISTS core_product_id integer;

COMMENT ON COLUMN app.card_products.is_cooperative IS
  'Cooperative scheme card (LBIC, LIRS, INSIGHT, NOHIL, MEMCOS, NIMCOS, SSANU-UI). These are credit products repaid by salary deduction through the co-op — the flag exists so they can be reported separately without misclassifying the funding family.';
COMMENT ON COLUMN app.card_products.is_temporary IS
  'Card is issued with a deliberately short life (Blink). Distinct from expiry: every card expires, a temporary one is MEANT to.';
COMMENT ON COLUMN app.card_products.fx_funded IS
  'Customer funds the card in foreign currency and is credited the equivalent in the card''s own currency. True for Blink. Note the platform converts nowhere (see frontend/src/lib/currency.ts) — rates live in app.fx_parallel_rates and any conversion must be shown as a rate-stamped estimate, never as a stored figure.';
COMMENT ON COLUMN app.card_products.contactless IS 'Contactless-enabled card (was notes=''Contactless'').';
COMMENT ON COLUMN app.card_products.pinless IS 'PIN-less card, used for financial-inclusion issuance (was notes=''Pinless'').';
COMMENT ON COLUMN app.card_products.pre_issued IS 'Stock issued ahead of a named customer and assigned later (was notes=''Pre-issued cards'').';
COMMENT ON COLUMN app.card_products.loan_linked IS 'Card is the disbursement instrument for a loan product rather than a revolving line of its own (was notes=''Loan'').';
COMMENT ON COLUMN app.card_products.currency IS
  'ISO-4217 alpha currency the product is denominated in. NGN unless the product name says USD. Pairs with the numeric codes arriving on app.accounts.currency_code (566 = NGN, 840 = USD, migration 233).';
COMMENT ON COLUMN app.card_products.scheme IS
  'Card scheme where the product is scheme-defined (Amex). NULL where the scheme is decided per card by the PAN''s BIN rather than by the product — Verve/Visa/Mastercard are detected from the PAN, not stored here.';
COMMENT ON COLUMN app.card_products.core_product_id IS
  'Bridge to core.product.product_id — the catalogue app.card_book.product_id actually points at. Without this the book and the catalogue cannot be joined: core.product uses its own id space and unpadded codes (''1'') while this table uses padded ones (''001'').';

-- ── 3. Blink becomes its own family ─────────────────────────────────────────
UPDATE app.card_products
   SET category     = 'blink',
       is_temporary = true,
       fx_funded    = true
 WHERE product_code = '003';

-- ── 4. Backfill the attributes from the notes they were hiding in ───────────
UPDATE app.card_products SET contactless = true WHERE notes ILIKE '%contactless%';
UPDATE app.card_products SET pinless     = true WHERE notes ILIKE '%pinless%';
UPDATE app.card_products SET pre_issued  = true WHERE notes ILIKE '%pre-issued%' OR notes ILIKE '%pre issued%';
UPDATE app.card_products SET loan_linked = true WHERE notes ILIKE '%loan%';

-- ── 5. Cooperative schemes ──────────────────────────────────────────────────
-- Matched on product_code, not on a name pattern: '%COOP%' would miss MEMCOS,
-- NIMCOS and SSANU-UI, which is exactly the class of near-miss that produced
-- the eight competing definitions in the first place.
UPDATE app.card_products
   SET is_cooperative = true
 WHERE product_code IN ('410', '220', '170', '301', '210', '305', '415');

-- ── 6. Currency and scheme ──────────────────────────────────────────────────
UPDATE app.card_products
   SET currency = CASE WHEN product_name ILIKE '%USD%' THEN 'USD' ELSE 'NGN' END;

-- The O3 Green/Gold/Platinum family was Amex-branded and renamed; system_name
-- still carries the original, which is why the scheme is recoverable at all.
UPDATE app.card_products SET scheme = 'Amex' WHERE system_name ILIKE 'Amex%';

-- ── 7. Bridge to core.product ───────────────────────────────────────────────
-- core.product stores the code unpadded ('1'), this table zero-pads it ('001').
UPDATE app.card_products cp
   SET core_product_id = p.product_id
  FROM core.product p
 WHERE cp.product_code IS NOT NULL
   AND lpad(p.product_code, 3, '0') = cp.product_code;

CREATE INDEX IF NOT EXISTS idx_card_products_core_product ON app.card_products (core_product_id);
CREATE INDEX IF NOT EXISTS idx_card_products_category     ON app.card_products (category, is_active);

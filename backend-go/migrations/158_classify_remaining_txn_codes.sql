-- 158_classify_remaining_txn_codes.sql
--
-- Migration 157 seeded the 45 transaction codes with more than 50 occurrences,
-- then app.sync_card_txn_codes() auto-registered 24 more as 'unclassified'.
-- Several of those low-volume codes ARE income — mostly fee reversals plus a few
-- rarely-charged fees — so leaving them unclassified understates revenue.
--
-- The amounts are small (the largest is code 822 Penalty Adjustment Debit at
-- ₦1.65m over 46 postings), but a revenue figure that quietly omits categories is
-- worse than a small one, and the classification is unambiguous from the
-- descriptions CCS already writes.
--
-- Only rows still marked 'unclassified' are touched, so a classification the
-- business has since corrected is never overwritten.
--
-- Idempotent: safe to re-run.

-- Fees and fee reversals. Reversals carry negative amounts, so they net correctly
-- against the charge without needing a sign rule.
UPDATE app.card_txn_codes SET category = 'fee', counts_in_total = TRUE, updated_at = NOW()
WHERE category = 'unclassified' AND code IN (
  '103',  -- Replacement Fee
  '110',  -- Purchase Txn Fee
  '113',  -- Foreign Cash Adv Fee
  '150',  -- Membership Fee Reversal
  '154',  -- Re-Issue Fee Reversal
  '155',  -- Joining Fee Reversal
  '158',  -- Acct Maintenance Fee Reversal
  '162',  -- Foreign Purchase Fee Reversal
  '804'   -- Interest/Fee Adjustment Debit
);

UPDATE app.card_txn_codes SET category = 'penalty', counts_in_total = TRUE, updated_at = NOW()
WHERE category = 'unclassified' AND code = '822';  -- Penalty Adjustment Debit

-- Interest component reversals. These mirror 600 and 601, which are components of
-- the 604 "Total Interest" rollup — so like their charges they must NOT count
-- toward the total, or the reversal is applied twice.
UPDATE app.card_txn_codes SET category = 'interest', counts_in_total = FALSE, updated_at = NOW()
WHERE category = 'unclassified' AND code IN (
  '650',  -- Purchase Txn Interest Reversal  (mirrors 600)
  '651'   -- Advance Txn Interest Reversal   (mirrors 601)
);

-- Not income: repayments, transfers and credit-line changes.
UPDATE app.card_txn_codes SET category = 'payment', updated_at = NOW()
WHERE category = 'unclassified' AND code IN (
  '400',  -- Cash Payment - ATM
  '401',  -- Cheque Payment ATM
  '403',  -- Cheque Payment Bank
  '405'   -- Manual Payment
);

UPDATE app.card_txn_codes SET category = 'transfer', updated_at = NOW()
WHERE category = 'unclassified' AND code IN (
  '240',  -- Fund Transfer Out Purchase
  '241',  -- Fund Transfer Out Cash Advance
  '351',  -- EFT Transfer Out Reversal
  '472'   -- Web Transfer In Reversal
);

UPDATE app.card_txn_codes SET category = 'purchase', updated_at = NOW()
WHERE category = 'unclassified' AND code IN (
  '203',  -- Credit Voucher-Purchase Reversal
  '253'   -- Credit Voucher Reversal
);

UPDATE app.card_txn_codes SET category = 'non_financial', updated_at = NOW()
WHERE category = 'unclassified' AND code = '813';  -- Change in Temporary LOC

-- Code 654 is deliberately left unclassified.
--
-- It has a BLANK description in the book (3 postings, ₦150,562). The 65x range is
-- interest reversals, so it is very probably "Total Interest Reversal" — which
-- would need counts_in_total = TRUE to offset 604. But "very probably" is not a
-- basis for a revenue classification, and an unclassified code is visible on the
-- registry screen whereas a wrong one is not. ₦150k is immaterial and, left out,
-- is auditable. Confirm with CCS and classify it.

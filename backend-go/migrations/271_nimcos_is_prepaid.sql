-- NIMCOS (product_code 305) moves from category 'credit' to 'prepaid'.
--
-- Migration 239 defined the three funding families and deliberately left this one
-- alone: "NIMCOS is the one exception worth watching: 0 limits and 0 interest across
-- 275 accounts, which looks prepaid. It is deliberately NOT reclassified here — that
-- needs a business answer, not a guess in a migration."
--
-- The business answer, 2026-09-22: it is prepaid. The evidence that prompted the
-- question stands — across 275 accounts NIMCOS carries no credit limits and has never
-- charged interest, which is the definition of the prepaid family (stored value, the
-- customer's own float) rather than the credit family (a revolving line that is billed
-- and charges interest).
--
-- WHAT THIS CHANGES
--
-- The product is is_active = false, so nothing new is issued on it and no live
-- operation is affected. What moves is history: 275 accounts and their balances leave
-- the credit book and join the prepaid book wherever a report groups by
-- card_products.category. Card revenue does not move, because NIMCOS has never
-- produced interest.
--
-- is_cooperative stays TRUE. The co-op schemes were kept in 'credit' in 239 because
-- salary-deduction repayment describes how a card is REPAID, not what the instrument
-- is; that reasoning is untouched for the other six schemes (LBIC, LIRS, INSIGHT,
-- NOHIL, MEMCOS, SSANU-UI), which do carry limits and do charge interest. NIMCOS is
-- reclassified on its own evidence, not because it is a cooperative.
UPDATE app.card_products
   SET category = 'prepaid'
 WHERE product_code = '305'
   AND category = 'credit';

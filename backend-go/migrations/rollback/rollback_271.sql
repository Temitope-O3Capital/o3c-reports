-- Reverse 271: NIMCOS goes back to the credit family.
--
-- Use this if the business answer changes. Note that 239's evidence has not changed —
-- the product still carries no limits and no interest — so reverting restores the
-- discrepancy that prompted the original question rather than fixing anything.
UPDATE app.card_products
   SET category = 'credit'
 WHERE product_code = '305'
   AND category = 'prepaid';

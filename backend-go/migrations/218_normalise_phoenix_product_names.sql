-- Phoenix-originated applications were mirrored in carrying Phoenix's DISPLAY
-- name ("Credit Card") rather than the workspace's product code
-- ("credit_card"). The outbound path translated code -> name; there was no
-- inverse on the way back, so mirrored rows landed in a vocabulary nothing
-- else on this side speaks. The product-line classifier, Sales, BI and
-- phoenixIsRevolving all key off the code, so those rows silently fell out of
-- every one of them.
--
-- phoenixProductCode now translates on the way in. This corrects the rows
-- written before it existed.
--
-- Case-insensitive and idempotent: rows already holding a code do not match.

UPDATE app.loan_applications SET product_type = 'credit_card'
 WHERE lower(product_type) = 'credit card';

UPDATE app.loan_applications SET product_type = 'salary_loan'
 WHERE lower(product_type) = 'salary loan';

UPDATE app.loan_applications SET product_type = 'business_loan'
 WHERE lower(product_type) = 'business loan';

-- Migration 160: give a lead a product dimension.
--
-- Sales works three product lines (Cards, Loans, Fixed Deposit). Until now a lead
-- in crm_contacts carried no indication of WHICH product it was an opportunity for,
-- so the pipeline could not be read by product. product_interest stores a canonical
-- sub-code from the shared taxonomy (handlers/products.go / lib/products.ts):
-- 'prepaid' | 'credit_card' | 'salary_loan' | 'business_loan' | 'fixed_deposit'.
-- Nullable — historical leads simply have none until an officer tags them.

ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS product_interest TEXT;

-- Partial index: the pipeline-by-product queries only ever look at rows that are
-- tagged, so index just those.
CREATE INDEX IF NOT EXISTS idx_crm_contacts_product_interest
    ON crm_contacts (product_interest)
    WHERE product_interest IS NOT NULL;

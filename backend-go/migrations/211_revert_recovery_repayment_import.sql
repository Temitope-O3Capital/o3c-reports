-- Reverse migration 210: those repayments (from LOAN REPAYMENT CRM.xlsx) belong
-- to COLLECTIONS, not recovery. Remove the wrongly-imported rows. Safe because
-- every imported row was tagged channel='crm_import' with an LRCRM: reference.
DELETE FROM app.recovery_payments
WHERE channel = 'crm_import' AND reference LIKE 'LRCRM:%';

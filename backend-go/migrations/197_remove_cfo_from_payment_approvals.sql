-- 197_remove_cfo_from_payment_approvals.sql
--
-- CFO is removed from COLLECTION and RECOVERY PAYMENT approvals; the COO becomes the
-- final approver (and posts the GL). Write-offs and debt sales keep the CFO stage.
--
-- The approve handlers now drive payments with paymentStageProgressions (HOP → COO →
-- approved). Any payment sitting at the retired 'pending_cfo' stage would strand (that
-- status is no longer a valid key in the payment chain), so move it back to 'pending_coo'
-- where the COO can approve and post it. Idempotent.

UPDATE app.collection_payments SET status = 'pending_coo' WHERE status = 'pending_cfo';

UPDATE recovery_payments SET status = 'pending_coo' WHERE status = 'pending_cfo';

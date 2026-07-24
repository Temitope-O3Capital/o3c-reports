-- Migration 083: Add 'reversed' as a valid status for manual_postings.
-- The reversal workflow in finPostingsReverse was failing with a DB constraint error
-- because the CHECK only allowed pending/approved/rejected.

ALTER TABLE manual_postings
    DROP CONSTRAINT IF EXISTS manual_postings_status_check;

ALTER TABLE manual_postings
    ADD CONSTRAINT manual_postings_status_check
    CHECK (status IN ('pending', 'approved', 'rejected', 'reversed'));

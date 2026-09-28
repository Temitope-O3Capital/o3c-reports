-- 305 — The last six collections rows stop holding a Udara id as though it were a CIF.
--
-- Migration 267 gave collection_assignments and recovery_cases the 'UD-' convention so a
-- Udara customer id can never be mistaken for a cards CIF (every cards CIF is exactly 8
-- digits, so the prefix cannot collide). Six rows escaped it because they were keyed
-- data_source='manual' and 267 only rewrote the machine-loaded ones.
--
-- NOBODY IS LOOKING AT THE WRONG PERSON TODAY. Checked before writing: all six already
-- carry the correct party_id, and none of their four distinct ids collides with a live
-- app.customers.cif — so unlike the 31 rows migration 299 dealt with, these are not
-- resolving to a stranger. This is normalisation, and it removes a trap rather than
-- closing a live wound: the moment CCS issues a card under CIF 00000632, that bare id in
-- account_cif starts matching a real cardholder who is not KEMDIO TECHNICAL LIMITED.
--
--     id   | account_cif | customer_name            | status | party_id
--     1738 | 00000632    | KEMDIO TECHNICAL LIMITED | active | 227330
--     1748 | 00000660    | INTERIOR BAZAR NIGERIA   | active | 407828
--     1762 | 00000637    | AJAYI JOSEPH O           | active | 227332
--     1774 | 00000654    | PAUBEE GLOBAL VENTURE    | active | 227338
--     1787 | 00000632    | KEMDIO TECHNICAL LIMITED | closed | 227330
--     1799 | 00000637    | AJAYI JOSEPH             | closed | 227332
--
-- THE THING THAT MAKES THIS MORE THAN A ONE-LINE UPDATE. Other tables key on the same
-- string, and re-keying the assignment alone would detach them:
--
--     collection_payments.account_cif    7 rows   ← MONEY. Orphaning these would be
--                                                   worse than the inconsistency.
--     collections_dedup_audit.account_cif 4 rows
--     credit_activity_log.account_cif     1 row
--
-- Every one moves in the same transaction. The two audit-ish tables are re-keyed as well:
-- their account_cif is a REFERENCE to an account, not a recorded historical value, so
-- leaving it behind would preserve the text while breaking the pointer. Nothing about what
-- those rows assert changes.
--
-- Verified empty and therefore untouched: collection_contacts, collection_promises,
-- collections_watchlist, collections_writeoff_requests, dunning_sends, recovery_cases
-- (both columns), repayment_plans, collection_assignments.cif_number.
--
-- SAFE TO RE-RUN: every clause requires the id to be un-prefixed and to exist in
-- cbs_loans, which stops being true once the prefix is applied.

BEGIN;

-- The ids being re-keyed, pinned once so every table below moves exactly the same set.
-- The three conditions together are what make an id unambiguously Udara's: not already
-- prefixed, known to the core-banking loan book, and NOT a cards CIF.
CREATE TEMP TABLE m305 ON COMMIT DROP AS
SELECT DISTINCT ca.account_cif AS bare, 'UD-' || ca.account_cif AS prefixed
  FROM app.collection_assignments ca
 WHERE ca.account_cif !~ '^UD-'
   AND EXISTS (SELECT 1 FROM app.cbs_loans  cl WHERE cl.cbs_customer_id = ca.account_cif)
   AND NOT EXISTS (SELECT 1 FROM app.customers c WHERE c.cif = ca.account_cif);

DO $guard$
DECLARE n int;
BEGIN
    SELECT COUNT(*) INTO n FROM m305;
    -- Four distinct ids across six rows when this was written. A wildly different number
    -- means the shape has changed and the blast radius needs re-deriving, not applying.
    IF n > 25 THEN
        RAISE EXCEPTION '305: % ids selected, expected a handful — refusing until re-checked', n;
    END IF;
    RAISE NOTICE '305: re-keying % Udara id(s)', n;
END $guard$;

-- MONEY FIRST. If anything in this migration is going to fail, it must fail before the
-- assignment moves, never after — a committed re-key with detached payments would be the
-- one outcome worse than doing nothing.
UPDATE app.collection_payments p SET account_cif = m.prefixed
  FROM m305 m WHERE p.account_cif = m.bare;

UPDATE app.collections_dedup_audit a SET account_cif = m.prefixed
  FROM m305 m WHERE a.account_cif = m.bare;

UPDATE app.credit_activity_log l SET account_cif = m.prefixed
  FROM m305 m WHERE l.account_cif = m.bare;

UPDATE app.collection_assignments ca SET account_cif = m.prefixed, updated_at = NOW()
  FROM m305 m WHERE ca.account_cif = m.bare;

DO $m305$
DECLARE n_left int; n_orphan int; n_moved int;
BEGIN
    -- No collections row may still hold a bare Udara id.
    SELECT COUNT(*) INTO n_left
      FROM app.collection_assignments ca
     WHERE ca.account_cif !~ '^UD-'
       AND EXISTS (SELECT 1 FROM app.cbs_loans cl WHERE cl.cbs_customer_id = ca.account_cif)
       AND NOT EXISTS (SELECT 1 FROM app.customers c WHERE c.cif = ca.account_cif);
    IF n_left > 0 THEN
        RAISE EXCEPTION '305: % assignment(s) still hold a bare Udara id — refusing', n_left;
    END IF;

    -- And no payment may now point at an account that does not exist. This is the guard
    -- the whole migration is shaped around.
    SELECT COUNT(*) INTO n_orphan
      FROM app.collection_payments p
      JOIN m305 m ON p.account_cif = m.prefixed
     WHERE NOT EXISTS (SELECT 1 FROM app.collection_assignments ca
                        WHERE ca.account_cif = p.account_cif);
    IF n_orphan > 0 THEN
        RAISE EXCEPTION '305: % payment(s) left pointing at no account — refusing', n_orphan;
    END IF;

    SELECT COUNT(*) INTO n_moved FROM app.collection_assignments ca
      JOIN m305 m ON ca.account_cif = m.prefixed;
    RAISE NOTICE '305: % assignment row(s) now carry the UD- convention, with their '
        'payments, dedup audit and activity log moved with them', n_moved;
END $m305$;

COMMIT;

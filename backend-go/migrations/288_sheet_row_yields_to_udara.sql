-- 288 — A second sheet row for a borrower Udara already carries yields to Udara.
--
-- THE REMAINING CASE. Migration 287 removed the 22 borrowers who sat on the queue twice,
-- but it could only act on sheet rows that were LINKED to a Udara loan. FINTRAK had a
-- third row that was not:
--
--     id 1747  sheet  N40,000,000.00  linked to Udara 21000004240  -> closed by 287
--     id 1812  udara  N40,000,000.00  UD-00000424, live            -> carries the debt
--     id 1778  sheet  N60,000,000.00  NOT linked                   -> still on the queue
--
-- Udara holds exactly ONE FINTRAK facility: account 21000004240, N80,000,000.00
-- disbursed with N40,000,000.00 outstanding. The sheet's N60,000,000.00 is not a second
-- facility Udara is missing; it is an older figure for that same loan. Confirmed by the
-- business: follow Udara's own.
--
-- THE RULE, stated generally rather than patched at one id. Where a sheet row's borrower
-- is ALREADY carried by a live Udara row — established through a sibling row on the same
-- account_cif that is linked to a Udara loan — the sheet row is a second reading of a
-- debt Udara is already reporting, and Udara is the book of record. It closes.
--
-- This deliberately does NOT reach rows whose borrower has no Udara loan at all. Six of
-- those remain and they are correct as they stand: AKARA AND CO and CHIKEZIE DAVID OKEKE
-- have no Udara customer, and ISAAC SIAKA SALIFU, ONAH KENECHUKWU and ANYANWU MARTINS
-- each match a Udara CUSTOMER by name exactly while holding ZERO loans there. A matching
-- customer is not a matching facility, and those are precisely the sheet-only rows the
-- uploaded book exists to carry.
--
-- Dry-run whole before writing: 1 row matched, 0 borrowers left uncovered.

BEGIN;

UPDATE app.collection_assignments ca
   SET status     = 'closed',
       updated_at = NOW()
 WHERE ca.data_source = 'manual'
   AND ca.product_type = 'loan'
   AND ca.status IN ('active','sent_to_recovery')
   AND ca.duplicate_of_cbs_id IS NULL
   AND EXISTS (
         SELECT 1
           FROM app.collection_assignments sib
           JOIN app.cbs_loans cl ON cl.cbs_id::text = sib.duplicate_of_cbs_id::text
           JOIN app.collection_assignments u
             ON u.account_cif = 'UD-' || cl.cbs_customer_id
            AND u.status IN ('active','sent_to_recovery')
          WHERE sib.account_cif = ca.account_cif
            AND sib.id <> ca.id
            AND sib.duplicate_of_cbs_id IS NOT NULL);

DO $m288$
DECLARE orphaned int;
BEGIN
    -- Every account_cif touched must still be represented somewhere on the queue.
    SELECT COUNT(*) INTO orphaned FROM (
        SELECT DISTINCT ca.account_cif
          FROM app.collection_assignments ca
         WHERE ca.data_source='manual' AND ca.product_type='loan' AND ca.status='closed'
           AND ca.updated_at > NOW() - INTERVAL '1 minute'
    ) x
    WHERE NOT EXISTS (
        SELECT 1 FROM app.collection_assignments q
         WHERE q.status IN ('active','sent_to_recovery')
           AND (q.account_cif = x.account_cif
                OR q.account_cif IN (SELECT 'UD-'||cl.cbs_customer_id
                                       FROM app.collection_assignments s
                                       JOIN app.cbs_loans cl ON cl.cbs_id::text = s.duplicate_of_cbs_id::text
                                      WHERE s.account_cif = x.account_cif)));
    IF orphaned > 0 THEN
        RAISE EXCEPTION '288: % borrower(s) would be left with nothing on the queue — refusing', orphaned;
    END IF;
    RAISE NOTICE '288: sheet rows yielded to Udara';
END $m288$;

COMMIT;

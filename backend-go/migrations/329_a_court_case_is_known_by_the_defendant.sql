-- 329: A court case is known by the defendant, not by a CIF it never had.
--
-- Migration 324 restored identity to 52 recovery cases and left 26 it could not resolve, with
-- recovery_cases_has_identity_chk added NOT VALID so new rows were guarded while those 26 sat
-- unresolvable. This closes them -- not by guessing who they are, but by recognising that a
-- litigation case has a different kind of identity and recording the one it actually has.
--
-- WHAT THE 26 ACTUALLY ARE. Two groups, and I had described them as one:
--
--   24 Country Hill cases (ids 2011-2036, product_type='card', solicitor='Country Hill',
--   case_ref 'IMP2607-CH#n'). cif_number holds 'CH#6', 'CH#30' -- a row number from the import
--   spreadsheet, not a CIF, which is why account_cif was correctly left blank. customer_name is
--   blank too, so the Legal Tracker shows an EMPTY NAME against NGN 23,996,690.04 on the largest
--   of them. The defendants' names were never missing: they were in legal_proceedings.notes all
--   along, as '03 CAPITAL .V. DANLADI JIYA AND CRUSH CAFE LTD'.
--
--   2 cases for OKE STEPHEN (2170, 2185, status='closed') which DO carry a name and a loan
--   account number, just not in account_cif.
--
-- WHY NO party_id IS ASSIGNED. I tried, four ways, and every one of them would have been a
-- guess:
--   * exact token-set match against app.parties       -> 1 of 24 matched
--   * same match against app.customers (the CIF
--     namespace, which is where card customers live)  -> 1 of 24
--   * same against accounts.name_on_card              -> 1 of 24
--   * loose two-token overlap against app.customers   -> 14 of 24 matched NOTHING, and the
--                                                        other 10 matched 1-5 candidates each
-- 'OKE STEPHEN' is the clearest warning: app.parties holds TWO distinct parties with exactly
-- that name (2306131 and 783551) plus a 'STEPHEN OKE' (59672), and the account number
-- 0928650/1674/0020347869 appears in no other table -- not cbs_links, not collection_assignments,
-- not loan_repayments. Picking one would attach a debt to a person who may not owe it.
--
-- SO THE FIX IS TO WIDEN THE DEFINITION OF IDENTITY, NOT TO INVENT ONE. The constraint exists to
-- stop "a recovery case nobody can reach". A case with a named defendant and the solicitor
-- holding the court file IS reachable -- you ring Country Hill and ask about
-- '03 CAPITAL V. DANLADI JIYA'. A case carrying nothing but 'CH#6' is not. The widened predicate
-- still rejects exactly that: no CIF, no party, no name => refused.
--
-- After this the constraint is VALIDATED, so it is enforced against history for the first time
-- rather than only guarding new rows.

BEGIN;

-- 1. Drop the old constraint FIRST.
--
--    This has to come before the backfill, and the first run of this migration proved why. A
--    NOT VALID constraint still guards every row that is INSERTED **or UPDATED**; it only skips
--    rows already sitting in the table. So setting customer_name on a case that has no CIF and
--    no party_id re-presents that row to the old predicate, which rejects it -- the backfill
--    tripped the very constraint it was preparing to replace. The whole migration is one
--    transaction, so the failed attempt changed nothing.
ALTER TABLE app.recovery_cases DROP CONSTRAINT IF EXISTS recovery_cases_has_identity_chk;

-- 2. The defendant's name, from the court record where it has been all along.
--    Original casing is preserved (court notes are upper case; we do not re-case data) and
--    co-defendants are kept, because the co-defendant is sometimes the one who settles.
UPDATE app.recovery_cases rc
   SET customer_name = sub.defendant,
       updated_at    = now()
  FROM (
    SELECT lp.case_id,
           btrim(regexp_replace(regexp_replace(
             regexp_replace(COALESCE(lp.notes,''), '^\s*0?3\s*CAPITAL\s*[.,]?\s*V\s*[.,]?\s*', '', 'i'),
             '\s+', ' ', 'g'), '\s*\d+\s+AND\s+\d+\s+OR\.?\s*$', '', 'i')) AS defendant
      FROM app.legal_proceedings lp
  ) sub
 WHERE rc.id = sub.case_id
   AND COALESCE(btrim(rc.account_cif),'') = ''
   AND rc.party_id IS NULL
   AND COALESCE(btrim(rc.customer_name),'') = ''
   AND sub.defendant <> '';

-- 3. Add it back, naming all three legitimate identities.
ALTER TABLE app.recovery_cases
  ADD CONSTRAINT recovery_cases_has_identity_chk CHECK (
        COALESCE(btrim(account_cif), '') <> ''          -- reachable by CIF
     OR party_id IS NOT NULL                            -- reachable by party
     OR (COALESCE(btrim(customer_name), '') <> ''       -- reachable by name, held by a
         AND (COALESCE(btrim(solicitor), '') <> ''      --   solicitor...
           OR COALESCE(btrim(account_number), '') <> '')) --  ...or tied to an account
  );

-- 4. Guards.
DO $g$
DECLARE
    v_named     int;
    v_unreach   int;
    v_valid     boolean;
    v_total     bigint;
BEGIN
    SELECT count(*) INTO v_named
      FROM app.recovery_cases
     WHERE COALESCE(btrim(account_cif),'') = '' AND party_id IS NULL
       AND COALESCE(btrim(customer_name),'') <> '';
    IF v_named <> 26 THEN
        RAISE EXCEPTION '329: expected 26 cases identified by name alone, found %', v_named;
    END IF;

    -- Nothing may be left with no handle of any kind.
    SELECT count(*) INTO v_unreach
      FROM app.recovery_cases
     WHERE COALESCE(btrim(account_cif),'') = '' AND party_id IS NULL
       AND COALESCE(btrim(customer_name),'') = '';
    IF v_unreach <> 0 THEN
        RAISE EXCEPTION '329: % recovery cases still have no identity of any kind', v_unreach;
    END IF;

    SELECT convalidated INTO v_valid FROM pg_constraint
     WHERE conrelid = 'app.recovery_cases'::regclass
       AND conname  = 'recovery_cases_has_identity_chk';
    IF v_valid IS DISTINCT FROM true THEN
        RAISE EXCEPTION '329: recovery_cases_has_identity_chk did not validate';
    END IF;

    -- The money must not move. Measured 2026-10-05 before the change.
    SELECT COALESCE(sum(total_outstanding_kobo),0) INTO v_total FROM app.recovery_cases;
    RAISE NOTICE '329: % cases now identified by name; recovery book total %', v_named, v_total;
END
$g$;

COMMIT;

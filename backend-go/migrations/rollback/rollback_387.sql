-- Rollback for 387_a_placeholder_is_not_an_identity.sql
--
-- WHAT THIS UNDOES. Two collections assignments, their payments and their recovery cases are
-- re-pointed from the real Udara-backed party back to the empty placeholder party minted from
-- their spreadsheet handle.
--
-- WHAT YOU ARE ROLLING BACK TO. A debt record that names a borrower through an identity
-- derived from a fabricated id: ISAAC SIAKA SALIFU loses the phone, email, address and BVN
-- that reached him through Udara customer 00000545, and both accounts go back to a party key
-- of the form 'cid:W0000000000000NN' which exists only because an upload had no real identity
-- to use. Roll back only if 387 connected the wrong person to the wrong debt — which is the
-- one failure mode that matters here, and the reason the guard in 387 checks the name and the
-- Udara link rather than trusting the party id alone.
--
-- 387 MOVED NO MONEY. No amount, status, payment or case total changed; only which party row
-- the records point at. So this rollback cannot alter a reported figure either.
--
-- The placeholder parties were never deleted, which is what makes this reversible at all.

BEGIN;

DO $guard$
DECLARE
  n INT;
BEGIN
  SELECT COUNT(*) INTO n FROM app.parties WHERE party_id IN (708795, 708772);
  IF n <> 2 THEN
    RAISE EXCEPTION
      'rollback 387: the placeholder parties 708795 and 708772 are not both present (found %), so there is nothing to point back at.', n;
  END IF;
END $guard$;

UPDATE app.collection_assignments
   SET party_id = 708795, updated_at = NOW()
 WHERE account_cif = 'W000000000000031' AND party_id = 783592;

UPDATE app.collection_assignments
   SET party_id = 708772, updated_at = NOW()
 WHERE account_cif = 'W000000000000008' AND party_id = 783510;

UPDATE app.collection_payments
   SET party_id = 708795
 WHERE account_cif = 'W000000000000031' AND party_id = 783592;

UPDATE app.collection_payments
   SET party_id = 708772
 WHERE account_cif = 'W000000000000008' AND party_id = 783510;

UPDATE app.recovery_cases
   SET party_id = 708795
 WHERE COALESCE(NULLIF(account_cif,''), cif_number) = 'W000000000000031' AND party_id = 783592;

UPDATE app.recovery_cases
   SET party_id = 708772
 WHERE COALESCE(NULLIF(account_cif,''), cif_number) = 'W000000000000008' AND party_id = 783510;

-- Restore the comment to something that does not describe a state we have just left. The
-- placeholder note is removed because after this rollback they are live again, not superseded.
COMMENT ON TABLE app.parties IS
  'One person or organisation, across every id namespace. Parties keyed cid:W... or p:W... '
  'generally carry no profile and exist only because an upload had no real identity to use.';

DO $assert$
DECLARE
  n INT;
BEGIN
  SELECT COUNT(*) INTO n
    FROM app.collection_assignments
   WHERE account_cif IN ('W000000000000031','W000000000000008')
     AND party_id IN (708795, 708772);
  IF n <> 2 THEN
    RAISE EXCEPTION 'rollback 387: expected both assignments back on their placeholder party, found %', n;
  END IF;

  IF EXISTS (
    SELECT 1 FROM app.collection_assignments
     WHERE account_cif IN ('W000000000000031','W000000000000008')
       AND party_id IN (783592, 783510)
  ) THEN
    RAISE EXCEPTION 'rollback 387: an assignment still points at the Udara-backed party';
  END IF;
END $assert$;

COMMIT;

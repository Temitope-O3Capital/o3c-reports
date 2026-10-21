-- 387: A placeholder is not an identity
--
-- Eight collections assignments are keyed on a fabricated 'W0000000000000NN' handle minted
-- by a spreadsheet upload. Each carries a party record whose key is 'cid:W0000000000000NN'
-- — an identity derived from the placeholder, which means it names nobody and carries no
-- phone, no email, no address and no BVN. The Credit File therefore opens on a borrower it
-- cannot describe.
--
-- This migration deals ONLY with the four of those eight whose loan is real and is NOT
-- booked in Udara. The other four are the same loan twice and are a separate decision —
-- see the note at the end, which is deliberately not acted on here.
--
-- WHAT IS BEING FIXED, AND WHAT CANNOT BE
--
-- Two of the four borrowers exist as real Udara customers with a real party record. The
-- loan was never booked against them, which is why nothing in the module ever connected
-- the two: there is no loan to join through. Matching therefore had to be done on the
-- borrower, not the facility, and was verified on three or more shared name tokens plus
-- the absence of any competing candidate:
--
--   W000000000000031  ISAAC SIAKA SALIFU    -> Udara 00000545  SALIFU SIAKA ISAAC
--                     party 708795 (empty)  -> party 783592 'CBS:00000545'
--                     gains phone 2347039077016, isaaceve2014@gmail.com,
--                     HOUSE 10 SECOND STREET NAF ESTATE KUJE ABUJA, BVN 22339207325
--
--   W000000000000008  ANYANWU MARTINS       -> Udara 00000182  ANYANWU MARTINS (exact)
--                     party 708772 (empty)  -> party 783510 'CBS:00000182'
--                     gains a real customer id; Udara holds no contact detail for them,
--                     so the profile stays empty and is not invented.
--
-- The remaining two have NO Udara customer and no loan application on file, so there is no
-- real identity in this database to give them:
--
--   W000000000000005  AKARA AND CO          LRC0036  N1,750,000
--   W000000000000014  CHIKEZIE DAVID OKEKE  LRC0031  N466,668  (party already holds a phone)
--
-- They are left exactly as they are. Writing a plausible-looking id or profile for a real
-- borrower who owes real money would be a fabrication in a debt record, and the absence is
-- a fact worth seeing: both need onboarding in Udara, which is somebody's decision and not
-- a migration's.
--
-- WHY account_cif IS NOT TOUCHED, WHICH LOOKS LIKE THE OBVIOUS FIX
--
-- Re-keying these rows to 'UD-00000545' would be wrong twice over. The uploaded loan is
-- filed under the W handle, and so are its collection_payments, its recovery_cases rows and
-- its credit_activity_log entries — re-keying orphans all of them. And a 'UD-' key makes the
-- dossier resolve the row through the Udara facility master, which holds no loan for either
-- borrower, so the page would lose the only facility it can show. party_id is the right
-- lever: it is what debtorNameSQL leads with and what the Credit File resolves identity
-- through, so fixing it gives the real name, the real customer id and the real profile while
-- the loan stays where it is. isInternalId() already stops the W handle being printed as a
-- CIF, so nothing shows a fabricated id to a user.

BEGIN;

-- Guard: refuse if the target parties are not the ones this file was written against, or if
-- the Udara bridge they depend on has gone. Re-pointing a debt record at a party chosen by
-- id alone, without re-checking what that id now holds, is how the wrong person gets dunned.
DO $guard$
DECLARE
  n INT;
BEGIN
  SELECT COUNT(*) INTO n
    FROM app.parties p
    JOIN app.cbs_links lk ON lk.entity_type = 'party' AND lk.entity_id = p.party_id
   WHERE (p.party_id = 783592 AND p.party_key = 'CBS:00000545' AND lk.cbs_customer_id = '00000545'
          AND upper(btrim(p.full_name)) = 'SALIFU SIAKA ISAAC')
      OR (p.party_id = 783510 AND p.party_key = 'CBS:00000182' AND lk.cbs_customer_id = '00000182'
          AND upper(btrim(p.full_name)) = 'ANYANWU MARTINS');
  IF n <> 2 THEN
    RAISE EXCEPTION
      'migration 387: expected both Udara-backed parties (783592/00000545 and 783510/00000182) to exist with their recorded names and links, found %. Re-verify the match before re-pointing a debt record.', n;
  END IF;

  -- And refuse if either assignment has stopped being the placeholder row we measured.
  SELECT COUNT(*) INTO n
    FROM app.collection_assignments
   WHERE (account_cif = 'W000000000000031' AND party_id = 708795 AND outstanding_kobo = 1375000000)
      OR (account_cif = 'W000000000000008' AND party_id = 708772 AND outstanding_kobo =   29500000);
  IF n <> 2 THEN
    RAISE EXCEPTION
      'migration 387: the two assignments no longer match what was measured (W031 party 708795 at N13,750,000 and W008 party 708772 at N295,000); found %. Something else has changed them.', n;
  END IF;
END $guard$;

UPDATE app.collection_assignments
   SET party_id   = 783592,
       updated_at = NOW()
 WHERE account_cif = 'W000000000000031'
   AND party_id    = 708795;

UPDATE app.collection_assignments
   SET party_id   = 783510,
       updated_at = NOW()
 WHERE account_cif = 'W000000000000008'
   AND party_id    = 708772;

-- The payments already booked against these two accounts should resolve to the same person
-- as the assignment above them, or the Credit File and the approvals screen will name the
-- customer differently on the same money. Only rows still pointing at the placeholder party
-- are moved.
UPDATE app.collection_payments
   SET party_id = 783592
 WHERE account_cif = 'W000000000000031' AND party_id = 708795;

UPDATE app.collection_payments
   SET party_id = 783510
 WHERE account_cif = 'W000000000000008' AND party_id = 708772;

UPDATE app.recovery_cases
   SET party_id = 783592
 WHERE COALESCE(NULLIF(account_cif,''), cif_number) = 'W000000000000031' AND party_id = 708795;

UPDATE app.recovery_cases
   SET party_id = 783510
 WHERE COALESCE(NULLIF(account_cif,''), cif_number) = 'W000000000000008' AND party_id = 708772;

-- The two superseded placeholder parties are left in place, not deleted. They are referenced
-- by history this migration has not rewritten, and a party row costs nothing; what mattered
-- was that nothing live still points at them. Recorded so the next reader knows they are
-- dead rather than wondering whether they are a second customer.
COMMENT ON TABLE app.parties IS
  'One person or organisation, across every id namespace. Parties 708795 and 708772 are '
  'SUPERSEDED placeholders minted from spreadsheet handles W000000000000031 and '
  'W000000000000008 (migration 387); the live records for those borrowers are 783592 '
  '(CBS:00000545) and 783510 (CBS:00000182). Parties keyed cid:W... or p:W... generally '
  'carry no profile and exist only because an upload had no real identity to use.';

DO $assert$
DECLARE
  n INT;
BEGIN
  -- Both assignments now resolve a real, Udara-backed party.
  SELECT COUNT(*) INTO n
    FROM app.collection_assignments ca
    JOIN app.parties p ON p.party_id = ca.party_id
   WHERE ca.account_cif IN ('W000000000000031','W000000000000008')
     AND p.party_key LIKE 'CBS:%';
  IF n <> 2 THEN
    RAISE EXCEPTION 'migration 387: expected 2 assignments on a CBS-backed party, found %', n;
  END IF;

  -- Nothing live still points at either superseded placeholder party.
  SELECT COUNT(*) INTO n FROM (
    SELECT 1 FROM app.collection_assignments WHERE party_id IN (708795, 708772)
    UNION ALL
    SELECT 1 FROM app.collection_payments    WHERE party_id IN (708795, 708772)
    UNION ALL
    SELECT 1 FROM app.recovery_cases         WHERE party_id IN (708795, 708772)
  ) x;
  IF n <> 0 THEN
    RAISE EXCEPTION 'migration 387: % live row(s) still point at a superseded placeholder party', n;
  END IF;

  -- The name actually improved. This is the point of the exercise, so it is asserted rather
  -- than assumed: a profile with a phone on it now reaches the Salifu account.
  IF NOT EXISTS (
    SELECT 1 FROM app.collection_assignments ca
      JOIN app.parties p ON p.party_id = ca.party_id
     WHERE ca.account_cif = 'W000000000000031'
       AND length(COALESCE(p.primary_phone,'')) >= 10
  ) THEN
    RAISE EXCEPTION 'migration 387: the Salifu assignment still resolves no phone number';
  END IF;

  -- And the two with no real identity were NOT given one.
  SELECT COUNT(*) INTO n
    FROM app.collection_assignments ca
    JOIN app.parties p ON p.party_id = ca.party_id
   WHERE ca.account_cif IN ('W000000000000005','W000000000000014')
     AND p.party_key LIKE 'CBS:%';
  IF n <> 0 THEN
    RAISE EXCEPTION
      'migration 387: % assignment(s) with no Udara customer were given a CBS-backed party. Nothing should have invented an identity for AKARA AND CO or CHIKEZIE DAVID OKEKE.', n;
  END IF;
END $assert$;

COMMIT;

-- NOT DONE HERE, ON PURPOSE. The other four W-handles are the SAME LOAN as a Udara-keyed
-- assignment already live in the queue, proved on the exact outstanding amount against the
-- Udara loan rather than on a name:
--
--   W000000000000034 -> UD-00000673 VITAL RELIEF WELLNESS     N15,750,000
--   W000000000000027 -> UD-00000670 GOKE DOUBLE AUTOS          N6,666,667
--   W000000000000028 -> UD-00000679 GREY LOFT HOTEL LIMITED    N5,200,000
--   W000000000000029 -> UD-00000671 HENGOOB MULTI-SERVICES       N416,666
--
-- The spreadsheet filed each as 'PERSON/BUSINESS' while Udara holds the person and the
-- business as separate customers and books the loan against the BUSINESS — which is why the
-- person-side Udara records (00000665, 00000677) hold no loan at all. Retiring the four
-- placeholders removes N28,033,333 of double-counted exposure from the queue, but it moves a
-- reported figure, so it waits for a decision rather than riding along with an identity fix.

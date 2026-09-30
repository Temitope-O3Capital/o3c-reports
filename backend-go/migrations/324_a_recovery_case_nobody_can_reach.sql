-- 324: give 52 recovery cases back their identity, and stop the 79th being created.
--
-- 78 rows in recovery_cases carry NO identity at all — account_cif NULL and party_id NULL —
-- worth NGN 946,994,206. Nothing joins to them: they are unreachable from Customer 360, from the
-- delinquency book, from the party layer, and from every namespace-correct query.
--
-- FIRST, A CORRECTION worth recording, because it is the mistake this codebase keeps producing.
-- These were reported as "55 cases, NGN 638,599,606.56, and growing — now 78". They are not
-- growing. The newest one was created 2026-08-24 16:40:48 and NOTHING has inserted into
-- recovery_cases since 2026-09-12. The 55 figure — hardcoded in the comment at
-- handlers/collections_ops.go:1116 — counts only the non-closed subset, and
-- `status <> 'closed'` over these same rows returns 55 and NGN 638,599,606.56 to the kobo. A
-- filtered count was compared against a total and the difference read as growth. Same defect
-- shape as everything else in the handover doc: the number was right, the predicate was not.
--
-- WHERE THEY CAME FROM. Two ad-hoc SQL runs on 2026-08-24, both tagged data_source='manual', in
-- one transaction that is the last writer of exactly these 78 rows and nothing else:
--
--   24 rows  13:26  case_ref IMP2607-CH#1..CH#32   cif_number holds 'CH#1'..'CH#32' — Country
--                                                  Hill's SPREADSHEET ROW NUMBERS in a CIF column
--   54 rows  16:40  case_ref RC-000982..RC-001035   cif_number holds raw sheet text: dashed
--                                                  account numbers, slash-joined pairs, and the
--                                                  literal strings 'NO MANDATE' and 'IAGREE'
--
-- No Go code can produce them: all three INSERT sites leave data_source at its 'core' default.
-- This was hand-run SQL, which is exactly why the guard added below belongs in the DATABASE.
--
-- WHY 52 ARE FIXABLE. The same loan book was re-loaded CORRECTLY on 2026-09-07 into
-- app.collection_assignments (data_source='manual', product_type='loan') with party_id resolved
-- on every row. Matching on the customer name, normalised to upper-case alphanumerics, gives
-- exactly ONE party and ONE account key for 52 of the 78 — NGN 835,805,723.80 — with zero
-- ambiguous matches. Verified name-for-name: RC-000983 'DOOSHIMA CAROLINE FAGGA' -> party
-- 708780 of the same name; RC-000984 'ADELOYE BAYONLE' -> party 18754 'Bayonle Adeloye' on real
-- CIF 00034189.
--
-- WHAT IS DELIBERATELY LEFT ALONE. The remaining 26 (NGN 111,188,482.11) have no assignment row.
-- 24 are the Country Hill legal book, whose only identifying text is a court note
-- ('03 CAPITAL .V. <DEFENDANT>'); trigram similarity offers single candidates for six of them
-- and several candidates for four more. Name similarity is a guess, and this migration does not
-- guess about who owes NGN 946m — that is the same rule that stopped migration 318 inventing a
-- match from a shared phone number. They stay unidentified and visible.
--
-- cif_number is NOT touched. It is NOT NULL, holds the raw spreadsheet text, and is the only
-- record of what the sheet actually said. account_cif is the join key, and that is what is set.

-- ---------------------------------------------------------------------------
-- The backfill
-- ---------------------------------------------------------------------------

WITH orphan AS (
    SELECT id,
           upper(regexp_replace(COALESCE(customer_name, ''), '[^A-Za-z0-9]', '', 'g')) AS nkey
      FROM recovery_cases
     WHERE COALESCE(account_cif, '') = ''
       AND party_id IS NULL
), asg AS (
    SELECT upper(regexp_replace(COALESCE(customer_name, ''), '[^A-Za-z0-9]', '', 'g')) AS nkey,
           min(party_id)                AS party_id,
           min(account_cif)             AS account_cif,
           count(DISTINCT party_id)     AS parties,
           count(DISTINCT account_cif)  AS keys
      FROM app.collection_assignments
     WHERE data_source = 'manual'
       AND product_type = 'loan'
       AND party_id IS NOT NULL
       AND COALESCE(account_cif, '') <> ''
     GROUP BY 1
)
UPDATE recovery_cases rc
   SET account_cif = a.account_cif,
       party_id    = a.party_id,
       updated_at  = now()
  FROM orphan o
  JOIN asg a ON a.nkey = o.nkey
 WHERE rc.id = o.id
   AND a.parties = 1          -- one person, or no claim
   AND a.keys    = 1          -- one account key, or no claim
   AND o.nkey <> '';          -- a blank name matches every other blank name

-- ---------------------------------------------------------------------------
-- The guard the table never had
-- ---------------------------------------------------------------------------
--
-- NOT VALID on purpose, and this is the interesting part. 26 rows still have neither key, and
-- they cannot be identified without guessing. A validating constraint would therefore have to be
-- refused, or the 26 deleted, or a fake key invented — all three worse than the truth. NOT VALID
-- enforces the rule on every INSERT and UPDATE from now on while leaving the existing 26 visible
-- exactly as they are.
--
-- Validate it later with `ALTER TABLE recovery_cases VALIDATE CONSTRAINT
-- recovery_cases_has_identity_chk;` once somebody has decided what those 26 are. It will fail
-- until then, and that failure is the outstanding work, not a bug.

ALTER TABLE recovery_cases DROP CONSTRAINT IF EXISTS recovery_cases_has_identity_chk;
ALTER TABLE recovery_cases ADD CONSTRAINT recovery_cases_has_identity_chk
    CHECK (COALESCE(btrim(account_cif), '') <> '' OR party_id IS NOT NULL) NOT VALID;

COMMENT ON CONSTRAINT recovery_cases_has_identity_chk ON recovery_cases IS
    'A recovery case must be reachable: an account key or a party. NOT VALID because 26 pre-existing rows from a 2026-08-24 ad-hoc import cannot be identified without guessing (migration 324). VALIDATE once they are resolved.';

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------

DO $m324$
DECLARE
    v_left      int;
    v_left_naira numeric;
    v_fixed     int;
    v_total     numeric;
    v_contra    int;
BEGIN
    SELECT count(*), COALESCE(sum(outstanding_kobo), 0) / 100.0
      INTO v_left, v_left_naira
      FROM recovery_cases WHERE COALESCE(account_cif, '') = '' AND party_id IS NULL;

    SELECT count(*) INTO v_fixed
      FROM recovery_cases WHERE data_source = 'manual' AND party_id IS NOT NULL
        AND account_cif IS NOT NULL;

    -- The money may not move. This migration restores identity; it does not touch a balance.
    -- 453,842,066,817 kobo = NGN 4,538,420,668.17, measured 2026-09-30.
    SELECT COALESCE(sum(outstanding_kobo), 0) INTO v_total FROM recovery_cases;
    IF v_total <> 453842066817 THEN
        RAISE EXCEPTION '324: recovery_cases outstanding totals % kobo, expected 453842066817 — a balance changed', v_total;
    END IF;

    IF v_left <> 26 THEN
        RAISE EXCEPTION '324: % cases still have no identity, expected exactly 26 (the Country Hill legal book plus 2 same-named borrowers)', v_left;
    END IF;

    -- Nothing may now name a party that does not exist.
    SELECT count(*) INTO v_contra
      FROM recovery_cases rc
     WHERE rc.party_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM app.parties p WHERE p.party_id = rc.party_id);
    IF v_contra > 0 THEN
        RAISE EXCEPTION '324: % case(s) point at a party_id that is not in app.parties', v_contra;
    END IF;

    RAISE NOTICE '324: 52 cases reunited with their party; % left unidentified (NGN %), guarded NOT VALID.',
        v_left, round(v_left_naira, 2);
END
$m324$;

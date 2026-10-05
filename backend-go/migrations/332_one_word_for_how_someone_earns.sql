-- 332: One word for how someone earns a living -- and the word Phoenix actually understands.
--
-- Two forms offered two lists for app.loan_applications.employment_type, neither validated
-- anywhere, and the value is forwarded to a second system that accepts neither in full:
--
--   los/NewApplication.tsx             'permanent' | 'contract' | 'self_employed'
--   components/NewApplicationModal.tsx 'salaried' | 'self_employed' | 'contract' |
--                                      'retired' | 'unemployed'
--
-- 'permanent' and 'salaried' are one thing under two names, which splits any GROUP BY. The
-- expensive half was downstream. phoenixSubmitOne forwarded the value raw, and Phoenix's
-- resolveEmploymentType accepts EXACTLY four words -- employed / self_employed / business_owner
-- / unemployed -- deriving from borrower_category otherwise. We send no borrower_category, so
-- anything else became "not_specified", and the scorer then picks an income-variance threshold
-- by that word (intelligence-api _VARIANCE_THRESHOLDS):
--
--     employed       0.15   "salaried, very predictable"
--     self_employed  0.25
--     business_owner 0.30
--     contract       0.25
--     (unknown)      0.20   middle ground
--
-- So a salaried borrower sent as 'salaried' or 'permanent' was scored at 0.20 rather than 0.15 --
-- income judged less predictable than the model intends, on the commonest borrower type in the
-- book. phoenixProductName already existed for exactly this boundary translation; employment_type
-- never got one. It does now (phoenixEmploymentType), and it is where the mapping belongs: the
-- DATABASE keeps our word, the WIRE gets Phoenix's, because 'retired' and 'contract' are real
-- distinctions for our own reporting that Phoenix has no category for.
--
-- 'business_owner' is NEW in the vocabulary. Phoenix scores a business owner (0.30) differently
-- from a self-employed trader (0.25) and until now neither form could say which.
--
-- THE ONE EXISTING VALUE. 8 rows in the table, 7 with employment_type NULL and one holding
-- 'FULL_TIME' (application 18, "Ngozi Okafor", 2026-09-09). That string appears NOWHERE in the
-- codebase -- not in either form, not in Go, not in any migration -- so it was inserted by hand.
-- Mapped to 'salaried' as the only reading of "full time" that is a real employment type here.
-- One row, and it is named in full so the judgement is visible rather than buried in a count.

BEGIN;

UPDATE app.loan_applications
   SET employment_type = 'salaried', updated_at = now()
 WHERE employment_type = 'FULL_TIME';

-- Legacy rows from the form that said 'permanent'. None exist today; included because this is
-- the migration that defines the vocabulary, and a later row carrying the old word would fail
-- the constraint with no clue where it came from.
UPDATE app.loan_applications
   SET employment_type = 'salaried', updated_at = now()
 WHERE employment_type = 'permanent';

ALTER TABLE app.loan_applications
  ADD CONSTRAINT loan_applications_employment_type_chk CHECK (
    employment_type IS NULL OR employment_type = ANY (ARRAY[
      'salaried', 'self_employed', 'business_owner', 'contract', 'retired', 'unemployed'
    ])
  );

COMMENT ON COLUMN app.loan_applications.employment_type IS
  'How the applicant earns. Our vocabulary, not Phoenix''s -- phoenixEmploymentType translates it on the wire. See handlers/employment_vocab.go.';

DO $g$
DECLARE
    v_bad      int;
    v_salaried int;
    v_valid    boolean;
BEGIN
    SELECT count(*) INTO v_bad FROM app.loan_applications
     WHERE employment_type IS NOT NULL
       AND employment_type NOT IN ('salaried','self_employed','business_owner','contract','retired','unemployed');
    IF v_bad <> 0 THEN
        RAISE EXCEPTION '332: % rows hold an employment_type outside the vocabulary', v_bad;
    END IF;

    SELECT count(*) INTO v_salaried FROM app.loan_applications WHERE employment_type = 'salaried';
    IF v_salaried <> 1 THEN
        RAISE EXCEPTION '332: expected exactly 1 salaried row (the remapped FULL_TIME), found %', v_salaried;
    END IF;

    SELECT convalidated INTO v_valid FROM pg_constraint
     WHERE conrelid = 'app.loan_applications'::regclass
       AND conname  = 'loan_applications_employment_type_chk';
    IF v_valid IS DISTINCT FROM true THEN
        RAISE EXCEPTION '332: employment_type CHECK did not validate';
    END IF;

    RAISE NOTICE '332: employment_type settled; FULL_TIME -> salaried; CHECK validated';
END
$g$;

COMMIT;

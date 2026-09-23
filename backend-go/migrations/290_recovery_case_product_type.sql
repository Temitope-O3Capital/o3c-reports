-- 290 — A loan handed to recovery must not be filed as a card.
--
-- THE DEFECT. Neither path that opens a recovery case ever wrote product_type:
-- openRecoveryCase and the inline INSERT in collectionsOpsSendToRecovery both omitted
-- it, leaving NULL. Recovery then reads the column as COALESCE(product_type,'card'), so
-- the absence was silently rendered as a positive claim: this is a card debt.
--
-- Every case handed over from a loan assignment was affected — 9 of them, 9 labelled
-- card, 0 labelled loan.
--
-- ODOMETA ONOME is the case that exposed it. Case RC-001060 was opened from collections
-- assignment 1741, which is product_type='loan', data_source='manual' — an uploaded LOAN
-- row. It arrived in recovery labelled 'card' against a party that holds ZERO card
-- accounts and a N0.00 card balance. An agent working that case looks for a card that
-- does not exist; the write-off and legal paths treat the wrong product; and the case
-- cannot be reconciled against the loan it actually came from.
--
-- THE FIX. Carry product_type from the source assignment, which already knows which arm
-- the debt came from. Where a case has no source assignment the column is left alone
-- rather than guessed — those are watchlist and manual escalations whose arm is not
-- recorded anywhere, and inventing one would repeat the original mistake in the opposite
-- direction.
--
-- The code-side fix lands with this so new cases carry it; this statement corrects the
-- rows already written.

BEGIN;

UPDATE app.recovery_cases rc
   SET product_type = ca.product_type,
       updated_at   = NOW()
  FROM app.collection_assignments ca
 WHERE ca.id = rc.source_assignment_id
   AND ca.product_type IS NOT NULL
   AND rc.product_type IS DISTINCT FROM ca.product_type;

DO $m290$
DECLARE wrong int; fixed_n int;
BEGIN
    SELECT COUNT(*) INTO wrong
      FROM app.recovery_cases rc JOIN app.collection_assignments ca ON ca.id = rc.source_assignment_id
     WHERE ca.product_type IS NOT NULL AND rc.product_type IS DISTINCT FROM ca.product_type;
    IF wrong > 0 THEN
        RAISE EXCEPTION '290: % case(s) still disagree with their source assignment — refusing', wrong;
    END IF;
    SELECT COUNT(*) INTO fixed_n
      FROM app.recovery_cases rc JOIN app.collection_assignments ca ON ca.id = rc.source_assignment_id
     WHERE ca.product_type = 'loan';
    RAISE NOTICE '290: % recovery case(s) from loan assignments now carry product_type=loan', fixed_n;
END $m290$;

COMMIT;

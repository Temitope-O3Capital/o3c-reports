-- 280 — Retire the 487 empty recovery cases that shadow the real, worked ones.
--
-- WHAT HAPPENED. On 2026-08-24 two things ran against the same customers. The 02:00
-- auto-escalation opened a case for every account past 90 DPD, writing 'RC-%' refs. Later
-- the same day the legacy recovery book was imported, writing 'IMP2607-%' refs and
-- bringing its history with it — assigned agents, legal stage, logged payments. The
-- escalation worker's own guard (the NOT EXISTS in escalateSevereToRecovery) could not
-- help: it had already run, and the import carried no such guard of its own.
--
-- The result is exactly 487 debtors holding two open cases each, and the split between
-- them is total:
--
--                        cases   assigned   in legal   payments   recovered
--     RC-%   (escalation)  487          0          0          0           0
--     IMP%   (import)      487        269        211         66          66
--
-- Every case anyone has actually worked is on the import side. Every 'RC-%' twin is an
-- empty shell. They are not harmless: a debtor appears twice in the queue, and the open
-- recovery book reads N4,228,971,918.91 when the real figure is N2,859,878,845.62 —
-- N1,369,093,073.29 of double-count, which goes out in the daily management email.
--
-- WHY CLOSE AND NOT DELETE. These rows are business records. Closing them keeps the
-- audit trail, keeps the id valid for anything that references it, and makes the change
-- reversible in one statement (see migrations/rollback/280_*.sql). duplicate_of_case_id
-- records which case survived, so the pairing can be re-read later without guessing.
--
-- SAFETY. The predicate below closes a row ONLY when it is provably untouched — no
-- agent, no legal stage, no solicitor or agency, no recovered or written-off money, and
-- no child row in any of the four recovery child tables — AND a live import sibling
-- exists for the same account_cif. Verified in a rolled-back dry run before writing:
-- 487 matched, 0 lacked a surviving sibling, and 0 debtors were left with no open case.

BEGIN;

ALTER TABLE app.recovery_cases
  ADD COLUMN IF NOT EXISTS duplicate_of_case_id BIGINT REFERENCES app.recovery_cases(id);

WITH doomed AS (
    SELECT rc.id,
           (SELECT k.id FROM app.recovery_cases k
             WHERE k.account_cif = rc.account_cif AND k.id <> rc.id
               AND k.case_ref LIKE 'IMP%'
               AND k.status NOT IN ('closed','recovered','written_off')
             ORDER BY k.opened_at LIMIT 1) AS keep_id
      FROM app.recovery_cases rc
     WHERE rc.status NOT IN ('closed','recovered','written_off')
       AND rc.case_ref LIKE 'RC-%'
       AND COALESCE(rc.recovered_kobo,0)        = 0
       AND COALESCE(rc.total_recovered_kobo,0)  = 0
       AND COALESCE(rc.write_off_amount_kobo,0) = 0
       AND rc.assigned_agent_id   IS NULL
       AND rc.assigned_to_user_id IS NULL
       AND rc.legal_stage         IS NULL
       AND rc.status <> 'legal'
       AND rc.tpa_agency_id IS NULL
       AND rc.solicitor     IS NULL
       AND NOT EXISTS (SELECT 1 FROM app.recovery_payments             p  WHERE p.case_id  = rc.id)
       AND NOT EXISTS (SELECT 1 FROM app.recovery_field_visits         v  WHERE v.case_id  = rc.id)
       AND NOT EXISTS (SELECT 1 FROM app.recovery_write_off_approvals  w  WHERE w.case_id  = rc.id)
       AND NOT EXISTS (SELECT 1 FROM app.recovery_approvals            ap WHERE ap.case_id = rc.id)
       AND EXISTS (SELECT 1 FROM app.recovery_cases k
                    WHERE k.account_cif = rc.account_cif AND k.id <> rc.id
                      AND k.case_ref LIKE 'IMP%'
                      AND k.status NOT IN ('closed','recovered','written_off'))
)
UPDATE app.recovery_cases rc
   SET status               = 'closed',
       closed_at            = NOW(),
       closed_reason        = 'Duplicate of case ' || k.case_ref ||
                              ' — opened by the 02:00 auto-escalation on the same day the legacy'
                              || ' recovery book was imported. This shell was never worked; the'
                              || ' import case carries the history. Retired by migration 280.',
       duplicate_of_case_id = d.keep_id,
       updated_at           = NOW()
  FROM doomed d
  JOIN app.recovery_cases k ON k.id = d.keep_id
 WHERE rc.id = d.id
   AND d.keep_id IS NOT NULL;   -- belt and braces: never close a case with no survivor

-- Refuse to commit if any of the affected debtors lost their last open case.
DO $$
DECLARE orphaned int;
BEGIN
    SELECT COUNT(*) INTO orphaned
      FROM (SELECT DISTINCT account_cif FROM app.recovery_cases
             WHERE duplicate_of_case_id IS NOT NULL) x
     WHERE NOT EXISTS (SELECT 1 FROM app.recovery_cases k
                        WHERE k.account_cif = x.account_cif
                          AND k.status NOT IN ('closed','recovered','written_off'));
    IF orphaned > 0 THEN
        RAISE EXCEPTION '280: % debtor(s) would be left with no open recovery case — refusing', orphaned;
    END IF;
    RAISE NOTICE '280: retired % duplicate recovery case(s)',
        (SELECT COUNT(*) FROM app.recovery_cases WHERE duplicate_of_case_id IS NOT NULL);
END $$;

COMMIT;

-- 322: one definition of "in legal", because there were three and all three were wrong.
--
-- `recovery_cases.legal_stage` progresses recovery -> legal -> court -> judgment. The FIRST of
-- those, 'recovery', is the PRE-legal stage: ordinary chasing, no lawyer involved. Every reader
-- tested `legal_stage IS NOT NULL` instead, which answers "has this case a stage recorded at
-- all" — a different question, and true for cases that are explicitly not in legal.
--
-- Measured 2026-09-30 against the live book:
--
--   recovery.go accounts_in_legal KPI   legal_stage IS NOT NULL          526 cases  NGN 1,466,169,599
--   recovery.go legal-kpis CTE          legal_stage IS NOT NULL          526 cases
--   recovery.go legal tracker list      legal_stage IS NOT NULL          526 rows listed
--   executive.go legal funnel           + status IN ('active','legal')   420 cases  NGN 1,213,527,192
--   ACTUALLY past the recovery stage    legal/court/judgment, open       275 cases  NGN   873,666,833
--
-- So the headline overstated by **251 cases and NGN 592,502,766** — 145 cases sitting at the
-- pre-legal 'recovery' milestone plus 106 CLOSED cases, which the Legal Tracker was listing as
-- live legal matters.
--
-- No Go code has ever written 'recovery' into that column: the only writer is
-- recoveryAddLegalMilestone, which sets legal_stage together with status='legal'. The 251 came
-- from an import. That is the strongest evidence for this reading — the application's own write
-- path treats a legal_stage as meaning "a proceeding was filed", and 'recovery' never was one.
--
-- WHY A FUNCTION AND NOT A COPIED PREDICATE. This is the same class of defect as the test-card
-- regex (seven copies, two stale) and NPL (a count-weighted sibling publishing 9.8% where the
-- canonical rule said 79.1%). Four readers each spelling out the rule is four chances to drift.
-- Call app.is_in_legal and never inline it — and if you add a reader, call it there too.
--
-- WHAT THIS DOES NOT CHANGE. The Executive "legal pipeline" breakdown groups BY legal_stage and
-- prints the stage name on every row, so showing a 'recovery' bucket there states a fact rather
-- than making a claim. A breakdown that names each stage may show all stages; a single number
-- labelled "in legal" may not. That line is deliberate.

CREATE OR REPLACE FUNCTION app.is_in_legal(p_legal_stage text, p_status text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $fn$
    -- Past the pre-legal milestone, and not already finished with.
    SELECT COALESCE(p_legal_stage, '') IN ('legal', 'court', 'judgment')
       AND COALESCE(p_status, '')  NOT IN ('closed', 'recovered', 'written_off')
$fn$;

COMMENT ON FUNCTION app.is_in_legal(text, text) IS
    'Canonical "this case is in legal": legal_stage past the pre-legal ''recovery'' milestone AND the case not closed/recovered/written_off. Added by migration 322 after three readers each tested legal_stage IS NOT NULL and overstated the figure by 251 cases / NGN 592.5m. Never inline this rule.';

DO $m322$
DECLARE
    v_in_legal   int;
    v_value      bigint;
    v_old_way    int;
    v_prelegal   int;
    v_closed     int;
    v_inlined    text;
BEGIN
    SELECT count(*), COALESCE(sum(outstanding_kobo), 0)
      INTO v_in_legal, v_value
      FROM recovery_cases WHERE app.is_in_legal(legal_stage, status);

    SELECT count(*) INTO v_old_way
      FROM recovery_cases WHERE legal_stage IS NOT NULL AND legal_stage <> '';

    SELECT count(*) INTO v_prelegal FROM recovery_cases WHERE legal_stage = 'recovery';
    SELECT count(*) INTO v_closed
      FROM recovery_cases
     WHERE legal_stage IN ('legal','court','judgment') AND status IN ('closed','recovered','written_off');

    -- Pin the correction. If these move, the data changed and the numbers in the comment above
    -- are stale — which matters, because those figures are what justified the change.
    IF v_in_legal <> 275 THEN
        RAISE EXCEPTION '322: app.is_in_legal counts % cases, expected 275 — re-measure before trusting the header', v_in_legal;
    END IF;
    IF v_old_way - v_in_legal <> 251 THEN
        RAISE EXCEPTION '322: the old predicate over-counted by %, expected 251', v_old_way - v_in_legal;
    END IF;
    IF v_prelegal <> 251 - v_closed THEN
        RAISE EXCEPTION '322: pre-legal count % and closed-in-legal count % do not add to the 251 over-count', v_prelegal, v_closed;
    END IF;

    -- Nobody may inline the rule. Same guard shape as migration 316's, for the same reason.
    SELECT string_agg(obj, ', ' ORDER BY obj) INTO v_inlined FROM (
        SELECT n.nspname || '.' || c.relname AS obj
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('v','m')
           AND lower(pg_get_viewdef(c.oid)) ~ 'legal_stage[[:space:]]+is[[:space:]]+not[[:space:]]+null'
        UNION ALL
        SELECT n.nspname || '.' || p.proname
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE p.prokind = 'f'
           AND lower(p.prosrc) ~ 'legal_stage[[:space:]]+is[[:space:]]+not[[:space:]]+null'
           AND NOT (n.nspname = 'app' AND p.proname = 'is_in_legal')
    ) s;
    IF v_inlined IS NOT NULL THEN
        RAISE EXCEPTION '322: these objects still test legal_stage IS NOT NULL instead of app.is_in_legal: %', v_inlined;
    END IF;

    RAISE NOTICE '322: in legal = % cases, NGN %. The old predicate counted % (% pre-legal + % closed).',
        v_in_legal, round(v_value / 100.0, 2), v_old_way, v_prelegal, v_closed;
END
$m322$;

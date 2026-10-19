-- A state is one state, however it was typed.
--
-- The Report Builder can now group a lead hand-off by State, and the moment it could,
-- the data showed what had never been grouped before: of 364 hand-offs, Lagos arrives
-- as both 'Lagos' (213) and 'LAGOS' (17), and the federal capital as 'FCT' (74),
-- 'ABUJA' (11), 'Abuja' (7) and 'FCT, Abuja'. Grouped raw, Lagos becomes two rows and
-- the FCT four, and every percentage computed off them is wrong while looking perfectly
-- reasonable. That is worse than a missing column.
--
-- The folding rules are NOT invented here. app.sales_hub_for_state already strips a
-- trailing " state", already folds abuja/fct/f.c.t/federal capital territory to 'FCT',
-- and already resolves against app.lead_state_hub, which holds the 37 canonical
-- spellings. This migration lifts exactly those rules into a function so the export,
-- the hub lookup and anything added later cannot drift apart: a second hand-rolled copy
-- of this logic is how the officer trailing-space defect happened.
--
-- WHAT IT DELIBERATELY DOES NOT DO: invent a state for a value it does not recognise.
-- 'Gudu market, Ojuku line' is somebody's address typed into the wrong box. It is
-- returned unchanged, so it stays visible as bad data instead of being quietly bucketed
-- into a real state and counted there. Canonicalising is not cleaning.

BEGIN;

CREATE OR REPLACE FUNCTION app.canon_state(p_state text)
RETURNS text
LANGUAGE sql
STABLE
AS $fn$
    WITH trimmed AS (
        -- Strip a trailing " State", exactly as app.sales_hub_for_state does.
        SELECT NULLIF(btrim(regexp_replace(COALESCE(p_state, ''), '\s+state$', '', 'i')), '') AS s
    ),
    folded AS (
        SELECT s,
               CASE
                   WHEN lower(s) IN ('abuja', 'fct', 'f.c.t.', 'f.c.t',
                                     'federal capital territory', 'fct, abuja',
                                     'abuja, fct')
                       THEN 'FCT'
                   ELSE s
               END AS f
          FROM trimmed
    )
    SELECT CASE
               WHEN f IS NULL THEN NULL
               -- The canonical spelling comes from the reference table, so 'LAGOS' and
               -- 'lagos' both land on 'Lagos' without a casing rule of our own.
               WHEN EXISTS (SELECT 1 FROM app.lead_state_hub h WHERE lower(h.state) = lower(f))
                   THEN (SELECT h.state FROM app.lead_state_hub h
                          WHERE lower(h.state) = lower(f) LIMIT 1)
               WHEN f = 'FCT' THEN 'FCT'
               -- Last resort: a value like 'Lagos, Ikeja' whose first element is a real
               -- state. Only the first element is considered, and only on an outright
               -- match; anything else is returned as typed.
               ELSE COALESCE(
                   (SELECT h.state FROM app.lead_state_hub h
                     WHERE lower(h.state) = lower(btrim(split_part(f, ',', 1))) LIMIT 1),
                   s)
           END
      FROM folded
$fn$;

COMMENT ON FUNCTION app.canon_state(text) IS
    'Canonical state spelling for grouping. Folds casing and the FCT/Abuja aliases '
    'against app.lead_state_hub. Returns an unrecognised value unchanged rather than '
    'guessing, so bad data stays visible.';

-- Prove the rules on the values actually in the table, not on invented ones.
DO $$
DECLARE
    bad text;
BEGIN
    IF app.canon_state('LAGOS') <> 'Lagos' OR app.canon_state('lagos') <> 'Lagos'
       OR app.canon_state('Lagos State') <> 'Lagos' THEN
        RAISE EXCEPTION 'casing fold failed: LAGOS/lagos/Lagos State gave %, %, %',
            app.canon_state('LAGOS'), app.canon_state('lagos'), app.canon_state('Lagos State');
    END IF;

    IF app.canon_state('ABUJA') <> 'FCT' OR app.canon_state('Abuja') <> 'FCT'
       OR app.canon_state('FCT') <> 'FCT' OR app.canon_state('FCT, Abuja') <> 'FCT' THEN
        RAISE EXCEPTION 'FCT fold failed: ABUJA/Abuja/FCT/"FCT, Abuja" gave %, %, %, %',
            app.canon_state('ABUJA'), app.canon_state('Abuja'),
            app.canon_state('FCT'), app.canon_state('FCT, Abuja');
    END IF;

    IF app.canon_state('RIVERS') <> 'Rivers' THEN
        RAISE EXCEPTION 'RIVERS should fold to Rivers, got %', app.canon_state('RIVERS');
    END IF;

    -- An unrecognised value survives intact, and a blank stays NULL.
    IF app.canon_state('Gudu market, Ojuku line') <> 'Gudu market, Ojuku line' THEN
        RAISE EXCEPTION 'an unrecognised value must be returned unchanged, got %',
            app.canon_state('Gudu market, Ojuku line');
    END IF;
    IF app.canon_state('') IS NOT NULL OR app.canon_state(NULL) IS NOT NULL
       OR app.canon_state('   ') IS NOT NULL THEN
        RAISE EXCEPTION 'blank input must give NULL';
    END IF;

    -- Every canonical state must be a fixed point, or grouping an already-clean value
    -- would move it.
    SELECT h.state INTO bad
      FROM app.lead_state_hub h
     WHERE app.canon_state(h.state) IS DISTINCT FROM h.state
     LIMIT 1;
    IF bad IS NOT NULL THEN
        RAISE EXCEPTION 'canon_state is not idempotent on the reference table: % became %',
            bad, app.canon_state(bad);
    END IF;
END $$;

COMMIT;

-- canon_state must be cheap enough to filter on.
--
-- MY REGRESSION, MEASURED. Migration 376 added app.canon_state so that "Lagos",
-- "LAGOS" and "Lagos State" group as one state, and I then used it on BOTH sides of the
-- state filters in handlers/export_datasets.go. On app.contact_list_members (37,916
-- rows) that turned an 18.9 ms filter into a 16,238 ms one — 860x slower — and the
-- Report Builder's own live test started timing out on it. The grouping was right; the
-- cost was not.
--
-- WHY IT WAS SLOW, AND IT IS NOT "the table read".  app.lead_state_hub has 37 rows, so
-- reading it is nothing. Two other things did the damage:
--
--   1. THE CTEs MADE THE FUNCTION UNINLINEABLE. Postgres inlines a SQL function whose
--      body is a single SELECT; a body built from WITH clauses is planned and executed
--      on its own, per row. 37,916 executor start-ups is the bulk of the 16 seconds.
--
--   2. UP TO THREE SUBQUERIES PER CALL. An EXISTS against the hub, then the SELECT that
--      repeated the same lookup, then the comma-element lookup — roughly 100,000 scans
--      of a 37-row table for one filter.
--
-- WHAT THIS CHANGES. The string work moves into app.fold_state, which touches no table
-- and is therefore genuinely IMMUTABLE and free to inline. canon_state becomes ONE
-- SELECT over a COALESCE, so it inlines, and the redundant EXISTS is gone: the lookup
-- that used to be done twice is done once. An index on lower(state) turns each
-- remaining probe into an index hit.
--
-- THE SEMANTICS ARE UNCHANGED, DELIBERATELY. Same four outcomes in the same order: a
-- hub match wins, then the FCT fold, then the first comma element, then the value as
-- typed. The assertions at the foot of this file are migration 376's, re-run, plus the
-- cases that distinguish the branches — because a rewrite for speed that quietly
-- changes which spelling wins would corrupt every grouped report that uses it.
--
-- One equivalence worth recording, since it is why this is shorter than 376: the old
-- body's final fallback returned the TRIMMED value (pre-fold), not the folded one.
-- Those differ only when the FCT fold applied, and in that case the FCT branch has
-- already returned, so the fallback is only ever reached when the two are equal.

-- The string half: strip a trailing " State", then fold the FCT spellings. No table, so
-- IMMUTABLE is honest and the planner can treat repeated calls as one.
CREATE OR REPLACE FUNCTION app.fold_state(p_state text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
    SELECT CASE
             WHEN lower(s) IN ('abuja', 'fct', 'f.c.t.', 'f.c.t',
                               'federal capital territory', 'fct, abuja',
                               'abuja, fct')
               THEN 'FCT'
             ELSE s
           END
      FROM (
        SELECT NULLIF(btrim(regexp_replace(COALESCE(p_state, ''), '\s+state$', '', 'i')), '') AS s
      ) t
$$;

COMMENT ON FUNCTION app.fold_state(text) IS
  'The table-free half of app.canon_state: strips a trailing " State" and folds the FCT/Abuja spellings. IMMUTABLE, so it inlines and costs nothing per row.';

-- One SELECT, so Postgres inlines it into the calling query instead of planning it per
-- row. COALESCE gives the branch order: hub match, FCT, first comma element, as typed.
CREATE OR REPLACE FUNCTION app.canon_state(p_state text)
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
    SELECT COALESCE(
      -- The canonical spelling comes from the reference table, so 'LAGOS' and 'lagos'
      -- both land on 'Lagos' without a casing rule of our own.
      (SELECT h.state FROM app.lead_state_hub h
        WHERE lower(h.state) = lower(app.fold_state(p_state)) LIMIT 1),
      -- FCT stands even when the hub does not list it under that name.
      CASE WHEN app.fold_state(p_state) = 'FCT' THEN 'FCT' END,
      -- Last resort: a value like 'Lagos, Ikeja' whose first element is a real state.
      -- Only the first element, and only on an outright match.
      (SELECT h.state FROM app.lead_state_hub h
        WHERE lower(h.state) = lower(btrim(split_part(app.fold_state(p_state), ',', 1)))
        LIMIT 1),
      -- Anything else is returned as typed, so an unrecognised value is never lost.
      app.fold_state(p_state)
    )
$$;

COMMENT ON FUNCTION app.canon_state(text) IS
  'Canonical state for grouping: folds case, a trailing " State" and the FCT/Abuja aliases against app.lead_state_hub, returning an unrecognised value unchanged. One SELECT on purpose, so it inlines — see migration 383.';

-- 37 rows, so this is not about scan cost: it is about each inlined probe becoming an
-- index hit rather than a scan, when the filter runs tens of thousands of times.
CREATE INDEX IF NOT EXISTS lead_state_hub_lower_state_idx
  ON app.lead_state_hub (lower(state));

DO $$
DECLARE
  got text;
BEGIN
  -- Migration 376's assertions, re-run against the rewrite. A faster function that
  -- grouped differently would silently change every report built on it.
  FOR got IN SELECT unnest(ARRAY['LAGOS', 'lagos', 'Lagos State', 'lagos state']) LOOP
    IF app.canon_state(got) <> 'Lagos' THEN
      RAISE EXCEPTION 'migration 383: canon_state(%) = %, expected Lagos', got, app.canon_state(got);
    END IF;
  END LOOP;

  FOR got IN SELECT unnest(ARRAY['ABUJA', 'Abuja', 'FCT', 'fct', 'F.C.T.',
                                 'Federal Capital Territory', 'FCT, Abuja', 'Abuja, FCT']) LOOP
    IF app.canon_state(got) <> 'FCT' THEN
      RAISE EXCEPTION 'migration 383: canon_state(%) = %, expected FCT', got, app.canon_state(got);
    END IF;
  END LOOP;

  IF app.canon_state('RIVERS') <> 'Rivers' THEN
    RAISE EXCEPTION 'migration 383: canon_state(RIVERS) = %, expected Rivers', app.canon_state('RIVERS');
  END IF;

  -- An unrecognised value is returned as typed, not blanked.
  IF app.canon_state('Atlantis') <> 'Atlantis' THEN
    RAISE EXCEPTION 'migration 383: an unrecognised state must come back unchanged, got %', app.canon_state('Atlantis');
  END IF;

  -- Blank and NULL are NULL, so they group together as "not recorded".
  IF app.canon_state('') IS NOT NULL OR app.canon_state('   ') IS NOT NULL
     OR app.canon_state(NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'migration 383: blank and NULL must canonicalise to NULL';
  END IF;

  -- The comma branch still works, and still only on the first element.
  IF app.canon_state('Lagos, Ikeja') <> 'Lagos' THEN
    RAISE EXCEPTION 'migration 383: canon_state(Lagos, Ikeja) = %, expected Lagos', app.canon_state('Lagos, Ikeja');
  END IF;
  IF app.canon_state('Ikeja, Lagos') <> 'Ikeja, Lagos' THEN
    RAISE EXCEPTION 'migration 383: only the FIRST comma element may match, got %', app.canon_state('Ikeja, Lagos');
  END IF;

  -- Fixed point: canonicalising a canonical value changes nothing. This is what lets the
  -- filter canonicalise both sides without the two drifting apart.
  PERFORM 1 FROM app.lead_state_hub h
    WHERE app.canon_state(h.state) IS DISTINCT FROM h.state;
  IF FOUND THEN
    RAISE EXCEPTION 'migration 383: canon_state is not a fixed point over lead_state_hub';
  END IF;
END $$;

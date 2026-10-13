-- A substitute holiday is recomputed, not accumulated
--
-- WHAT WENT WRONG. Migration 367 taught the business clock Nigeria's holidays, and
-- handlers/holidays.go keeps them current from the Google feed. Part of that job is the
-- weekend rule Temitope chose on 2026-10-12: a holiday on either Saturday or Sunday is
-- observed on the next working day. The importer allocated each substitute against
-- every row in app.public_holidays — which includes the substitutes it wrote on its own
-- previous run. So a substitute counted as an obstacle to itself:
--
--   run one    Boxing Day, Saturday 2026-12-26  ->  observed Monday 2026-12-28
--   run two    the 28th now looks taken         ->  observed Tuesday 2026-12-29
--   run three  the 29th now looks taken too     ->  observed Wednesday 2026-12-30
--
-- The importer ran at 21:36 and 21:58 on 2026-10-12, so December 2026 ended up with
-- three Boxing Days. Across the window it left 109 substitution rows where 38 are
-- derivable: 71 working days closed that nobody authorised as holidays. The worker runs
-- weekly, so this was a leak rather than a one-off error — roughly another 38 days every
-- week, indefinitely, each one silently shortening every duration the platform reports.
--
-- WHAT IT DID NOT DAMAGE, stated precisely rather than reassuringly. The importer only
-- considers last year onwards, so nothing before 2025-01-01 was touched: the 21
-- substitution rows before that date are migration 367's hand-written ones and are left
-- exactly as they are. Only two spurious rows fell in the past at all, 2025-04-03 and
-- 2025-04-04, and no ticket's lifetime spans either date, so no figure that has been
-- published or emailed is affected. The other 69 are in the future. This was caught
-- before it mattered, not after.
--
-- WHY THIS IS A MIGRATION AND NOT JUST THE FIXED IMPORTER. The code fix stops new
-- spurious rows and its reconcile pass would eventually clear the existing ones, but
-- that would mean a data repair whose timing depends on a weekly worker and a reachable
-- feed. The repair belongs in the ledger where it can be read later, and it must leave
-- no window in which the legitimate substitutes are missing — so this recomputes the
-- set and swaps it in one transaction, rather than deleting and waiting for a rebuild.
--
-- The allocation below deliberately mirrors substitutesFor in handlers/holidays.go. That
-- duplication is a one-time repair, not a second implementation to keep in step: after
-- this runs, the Go function is the only thing that maintains these rows. The guard
-- against them drifting apart is TestSubstitutionIsIdempotent, which asserts the
-- property this bug violated — that a second run changes nothing.
--
-- SAFETY. Every statement here is restricted to source = 'substitution'. A declared
-- holiday, an arithmetic one, a feed one and a human's 'manual' correction are all
-- unreachable from this migration by construction, which matters because correcting a
-- holiday by hand is exactly what someone does when an Eid lands a day out.

/* ── Recompute the substitution set from the declared holidays alone ─────────── */

DO $$
DECLARE
  -- The importer's own window: 'history is not up for revision'. Keeping the same
  -- boundary means this migration cannot disagree with the code about who owns a row.
  v_cutoff  date := '2025-01-01';
  r         record;
  d         date;
  v_desired int;
  v_held    int;
  v_dropped int;
  v_added   int;
BEGIN
  CREATE TEMP TABLE _desired_substitutes(date date PRIMARY KEY, name text) ON COMMIT DROP;

  -- In date order, so Christmas on a Saturday takes the Monday and Boxing Day on the
  -- Sunday takes the Tuesday, instead of both wanting the Monday.
  FOR r IN SELECT date, name
             FROM app.public_holidays
            WHERE date >= v_cutoff
              AND source <> 'substitution'   -- the fix, in one line: declared rows only
            ORDER BY date
  LOOP
    CONTINUE WHEN EXTRACT(ISODOW FROM r.date) NOT IN (6, 7);

    d := r.date;
    LOOP
      d := d + 1;
      CONTINUE WHEN EXTRACT(ISODOW FROM d) IN (6, 7);
      -- Step over a holiday that is actually declared on that day...
      CONTINUE WHEN EXISTS (SELECT 1 FROM app.public_holidays
                             WHERE date = d AND source <> 'substitution');
      -- ...and over one allocated earlier in THIS pass, which is the only kind of
      -- substitute allowed to block a substitute.
      CONTINUE WHEN EXISTS (SELECT 1 FROM _desired_substitutes WHERE date = d);
      EXIT;
    END LOOP;

    INSERT INTO _desired_substitutes VALUES (d, r.name || ' (observed)');
  END LOOP;

  SELECT count(*) INTO v_desired FROM _desired_substitutes;
  SELECT count(*) INTO v_held FROM app.public_holidays
   WHERE source = 'substitution' AND date >= v_cutoff;

  WITH gone AS (
    DELETE FROM app.public_holidays h
     WHERE h.source = 'substitution'
       AND h.date >= v_cutoff
       AND NOT EXISTS (SELECT 1 FROM _desired_substitutes x
                        WHERE x.date = h.date AND x.name = h.name)
    RETURNING 1
  ) SELECT count(*) INTO v_dropped FROM gone;

  WITH put AS (
    INSERT INTO app.public_holidays (date, name, source, is_estimated)
    SELECT x.date, x.name, 'substitution', false
      FROM _desired_substitutes x
     WHERE NOT EXISTS (SELECT 1 FROM app.public_holidays h
                        WHERE h.date = x.date AND h.source = 'substitution'
                          AND h.name = x.name)
    ON CONFLICT (date) DO NOTHING
    RETURNING 1
  ) SELECT count(*) INTO v_added FROM put;

  RAISE NOTICE 'substitutes: held % -> %, dropped %, added %',
    v_held, v_desired, v_dropped, v_added;
END $$;

/* ── Assert the repair, rather than hope for it ─────────────────────────────── */

DO $$
DECLARE
  v_cutoff       date := '2025-01-01';
  v_weekend_hols int;
  v_subs         int;
  v_on_weekend   int;
  v_2026_working int;
  v_runaway      int;
BEGIN
  -- One substitute per weekend holiday. This is the invariant the bug broke, and it is
  -- the cheapest statement of 'recomputed, not accumulated' there is.
  SELECT count(*) INTO v_weekend_hols FROM app.public_holidays
   WHERE date >= v_cutoff AND source <> 'substitution'
     AND EXTRACT(ISODOW FROM date) IN (6, 7);
  SELECT count(*) INTO v_subs FROM app.public_holidays
   WHERE date >= v_cutoff AND source = 'substitution';
  IF v_subs <> v_weekend_hols THEN
    RAISE EXCEPTION '% weekend holidays but % substitutes; they must be one for one',
      v_weekend_hols, v_subs;
  END IF;

  -- A substitute on a Saturday is not a day anybody gets off.
  SELECT count(*) INTO v_on_weekend FROM app.public_holidays
   WHERE source = 'substitution' AND date >= v_cutoff
     AND EXTRACT(ISODOW FROM date) IN (6, 7);
  IF v_on_weekend > 0 THEN
    RAISE EXCEPTION '% substitute(s) landed on a weekend', v_on_weekend;
  END IF;

  -- Three of the days the runaway invented, named so this migration fails loudly if it
  -- is ever applied to a database where the leak took a different shape.
  SELECT count(*) INTO v_runaway FROM app.public_holidays
   WHERE date IN ('2026-12-29', '2026-12-30', '2025-04-04');
  IF v_runaway > 0 THEN
    RAISE EXCEPTION '% of the known spurious dates are still present', v_runaway;
  END IF;

  -- And the reason any of this matters: the number of working days in a year has to
  -- come out plausible. 71 days wrongly closed is what this looked like from here.
  SELECT count(*) INTO v_2026_working
    FROM (SELECT d FROM app.business_calendar
           WHERE d >= '2026-01-01' AND d < '2027-01-01'
           GROUP BY d HAVING sum(open_minutes) > 0) t;
  IF v_2026_working NOT BETWEEN 240 AND 256 THEN
    RAISE EXCEPTION '2026 has % working days, which is outside the plausible 240-256',
      v_2026_working;
  END IF;
END $$;

-- A tile can say how to draw it.
--
-- Two separate problems, both of which made a dashboard tile feel like a preview of a
-- report rather than a visual somebody composed.
--
-- 1. THE CHART GUESSED WHICH COLUMNS TO USE. `dashboard_tiles.config` already had
--    `label` and `value` keys, and DashboardView's renderer already read them — but
--    nothing in the UI could ever set them, so every chart silently took the first text
--    column for its categories and the first numeric column for its values. A report
--    returning three measures drew exactly one of them, chosen by column order, with no
--    way to say which. The fix is in the application layer, since config is jsonb and
--    needs no schema change; this migration records the grown key set in the COMMENT
--    below, which is where someone reading the table will look.
--
-- 2. THE VISUAL LIST WAS SHORTER THAN THE CHART LIBRARY. `components/echarts.tsx` has
--    carried EBarH (ranked horizontal bars), ECombo (bars plus lines, optional right
--    axis) and EFunnel (stage conversion) for months, used by other pages, while a tile
--    could only be one of six kinds. The CHECK constraint was the binding limit, so it
--    is widened here.
--
-- WHY THE CHECK STAYS. It is what stops a viz value the renderer has no branch for — a
-- typo, or a kind later removed from the frontend — being stored and then drawing
-- nothing at all. A tile that renders blank is worse than a request that is refused, so
-- the constraint is replaced with a longer list rather than dropped.

DO $$
BEGIN
  -- Both statements in one block: between a bare DROP and a later ADD there is a window
  -- in which a concurrent insert could store anything at all.
  ALTER TABLE app.dashboard_tiles
    DROP CONSTRAINT IF EXISTS dashboard_tiles_viz_check;

  ALTER TABLE app.dashboard_tiles
    ADD CONSTRAINT dashboard_tiles_viz_check
    CHECK (viz = ANY (ARRAY[
      'kpi', 'bar', 'line', 'area', 'donut', 'table',
      'barh', 'combo', 'funnel'
    ]));
END $$;

COMMENT ON COLUMN app.dashboard_tiles.config IS
  'How to draw this tile, as jsonb. Keys the renderer honours: label (category column), '
  'values (array of measure columns in series order), lines (which of those draw as lines '
  'in a combo), stacked, rightAxis, legend, topN, sortBy, sortDir, and for a '
  'KPI tile compare (a second column) and goal (a number). Every key is optional, and '
  'absent means the original behaviour: first text column for categories, first numeric '
  'column for values. Resolution lives in one place on the client, '
  'frontend/src/pages/reports/builder/tileViz.ts, so the builder and the renderer cannot '
  'disagree about what a config means.';

DO $$
DECLARE
  bad bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'app.dashboard_tiles'::regclass
       AND conname  = 'dashboard_tiles_viz_check'
  ) THEN
    RAISE EXCEPTION 'migration 381: the viz CHECK is missing; a tile could store a kind that draws nothing';
  END IF;

  -- Nothing already stored may violate the new list. ADD CONSTRAINT validates existing
  -- rows, so reaching this line means it passed; asserting it states the intent rather
  -- than relying on that side effect.
  SELECT count(*) INTO bad
    FROM app.dashboard_tiles
   WHERE viz <> ALL (ARRAY['kpi','bar','line','area','donut','table','barh','combo','funnel']);
  IF bad <> 0 THEN
    RAISE EXCEPTION 'migration 381: % tiles hold a viz kind the renderer cannot draw', bad;
  END IF;

  -- The six original kinds must still be accepted: a "widening" that actually narrowed
  -- would make every existing tile unsaveable. Read back what the constraint now says
  -- rather than restating the list and comparing it with itself.
  DECLARE
    def text;
    k   text;
  BEGIN
    SELECT pg_get_constraintdef(oid) INTO def
      FROM pg_constraint
     WHERE conrelid = 'app.dashboard_tiles'::regclass
       AND conname  = 'dashboard_tiles_viz_check';
    FOREACH k IN ARRAY ARRAY['kpi','bar','line','area','donut','table','barh','combo','funnel'] LOOP
      IF position('''' || k || '''' IN def) = 0 THEN
        RAISE EXCEPTION 'migration 381: the viz CHECK no longer admits %, which would make existing tiles unsaveable', k;
      END IF;
    END LOOP;
  END;

  -- config must stay jsonb and nullable: NULL and '{}' both mean "use the defaults" and
  -- the renderer treats them identically. NOT NULL here would need a backfill nobody
  -- asked for.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'app' AND table_name = 'dashboard_tiles'
       AND column_name = 'config' AND data_type = 'jsonb'
  ) THEN
    RAISE EXCEPTION 'migration 381: dashboard_tiles.config must be jsonb';
  END IF;
END $$;

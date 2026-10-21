-- A tile can be a point cloud or a grid.
--
-- Two kinds the dashboard could not express, both of which people were working around.
--
-- 1. SCATTER. Every chart so far plots a measure against a CATEGORY. Nothing could plot
--    one measure against another, which is the shape of the question "do these two move
--    together" — balance against days past due, calls against conversions. A scatter is
--    also the one chart where more points is the point: the cloud's shape is the finding,
--    so its row cap is 400 where a column chart's is 40.
--
-- 2. MATRIX. A summary report with two groupings is drawn in LONG format today: one row
--    per combination, the first grouping repeated down the page. That is what a chart
--    wants and the opposite of what a reader wants. A matrix puts one field down the side
--    and the other across the top, which is how the same figures are read on paper.
--
--    Its cells are LOOKED UP, NEVER SUMMED. If two result rows fall in one cell, the
--    report groups by something the grid does not show, and adding them up would be right
--    for a count and wrong for an average or a percentage. The tile says what to change
--    instead of inventing a number — the same rule that stops a KPI tile summing rows.
--
-- WHY THE CHECK STAYS. It is what stops a viz value the renderer has no branch for — a
-- typo, or a kind later removed from the frontend — being stored and then drawing
-- nothing. A tile that renders blank is worse than a request that is refused, so the
-- constraint is replaced with a longer list rather than dropped.

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
      'barh', 'combo', 'funnel',
      'scatter', 'matrix'
    ]));
END $$;

COMMENT ON COLUMN app.dashboard_tiles.config IS
  'How to draw this tile, as jsonb. Keys the renderer honours: label (category column, or '
  'the point name on a scatter, or the field down the side of a matrix), colBy (the field '
  'across the top of a matrix), values (array of measure columns in series order — on a '
  'scatter the first runs across and the second up), lines (which of those draw as lines '
  'in a combo), stacked, rightAxis, legend, dataLabels, topN, sortBy, sortDir, goal (one '
  'target per tile) with goalGood (above | below), goalCol and colorByGoal, and for a KPI '
  'tile compare (a second column read from the same row). Every key is optional, and '
  'absent means the original behaviour: first text column for categories, first numeric '
  'column for values. Resolution lives in one place on the client, '
  'frontend/src/pages/reports/builder/tileViz.ts, so the builder and the renderer cannot '
  'disagree about what a config means.';

DO $$
DECLARE
  bad   bigint;
  kinds text[] := ARRAY['kpi','bar','line','area','donut','table','barh','combo','funnel','scatter','matrix'];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'app.dashboard_tiles'::regclass
       AND conname  = 'dashboard_tiles_viz_check'
  ) THEN
    RAISE EXCEPTION 'migration 385: the viz CHECK is missing; a tile could store a kind that draws nothing';
  END IF;

  -- Nothing already stored may violate the new list. ADD CONSTRAINT validates existing
  -- rows, so reaching this line means it passed; asserting it states the intent rather
  -- than relying on that side effect.
  SELECT count(*) INTO bad
    FROM app.dashboard_tiles
   WHERE viz <> ALL (kinds);
  IF bad <> 0 THEN
    RAISE EXCEPTION 'migration 385: % tiles hold a viz kind the renderer cannot draw', bad;
  END IF;

  -- Every earlier kind must still be accepted: a "widening" that actually narrowed would
  -- make existing tiles unsaveable. Read back what the constraint now says rather than
  -- restating the list and comparing it with itself.
  DECLARE
    def text;
    k   text;
  BEGIN
    SELECT pg_get_constraintdef(oid) INTO def
      FROM pg_constraint
     WHERE conrelid = 'app.dashboard_tiles'::regclass
       AND conname  = 'dashboard_tiles_viz_check';
    FOREACH k IN ARRAY kinds LOOP
      IF position('''' || k || '''' IN def) = 0 THEN
        RAISE EXCEPTION 'migration 385: the viz CHECK does not admit %, so that tile kind could never be saved', k;
      END IF;
    END LOOP;
  END;
END $$;

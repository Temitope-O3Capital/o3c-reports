-- Undo 386: narrow the viz CHECK back to the eleven kinds before 'map'.
--
-- WHAT THIS DOES NOT UNDO: a tile already saved as 'map' would violate the narrower
-- constraint, so it is moved to 'barh' first — a ranked horizontal bar of the same state
-- column and the same measure, which is the nearest honest drawing of the same figures.
-- Nothing is deleted and the tile keeps its config, so re-applying 386 restores the map.
--
-- The boundary file in the frontend is left alone: it is a static asset, it costs nothing
-- unless a map tile asks for it, and deleting it would make re-applying this migration a
-- two-part job.

DO $$
DECLARE
  moved bigint;
BEGIN
  UPDATE app.dashboard_tiles
     SET viz = 'barh'
   WHERE viz = 'map';
  GET DIAGNOSTICS moved = ROW_COUNT;
  IF moved > 0 THEN
    RAISE NOTICE 'rollback 386: % map tile(s) moved to a ranked bar', moved;
  END IF;

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

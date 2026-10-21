-- Undo 385: narrow the viz CHECK back to the nine kinds before scatter and matrix.
--
-- WHAT THIS DOES NOT UNDO, and why it matters more than usual here: a tile already
-- SAVED as 'scatter' or 'matrix' would violate the narrower constraint, so this moves
-- those tiles back to a kind that still draws before re-adding it. They become a plain
-- table — the honest fallback, since a matrix and a scatter both carry a category and a
-- measure a table can show. Nothing is deleted, and the tile keeps its config, so
-- re-applying 385 restores the drawing exactly.
--
-- The COMMENT on dashboard_tiles.config is left describing the wider key set. It is
-- documentation, the extra keys are harmless to a renderer that ignores them, and
-- rewriting prose backwards is how a comment ends up lying about both versions.

DO $$
DECLARE
  moved bigint;
BEGIN
  UPDATE app.dashboard_tiles
     SET viz = 'table'
   WHERE viz IN ('scatter', 'matrix');
  GET DIAGNOSTICS moved = ROW_COUNT;
  IF moved > 0 THEN
    RAISE NOTICE 'rollback 385: % tile(s) moved from scatter/matrix to table', moved;
  END IF;

  ALTER TABLE app.dashboard_tiles
    DROP CONSTRAINT IF EXISTS dashboard_tiles_viz_check;

  ALTER TABLE app.dashboard_tiles
    ADD CONSTRAINT dashboard_tiles_viz_check
    CHECK (viz = ANY (ARRAY[
      'kpi', 'bar', 'line', 'area', 'donut', 'table',
      'barh', 'combo', 'funnel'
    ]));
END $$;

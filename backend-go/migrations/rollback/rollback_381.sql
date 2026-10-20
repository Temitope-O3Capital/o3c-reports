-- Undo 381.
--
-- ROLL THE BINARY AND THE FRONTEND BACK FIRST, AND DELETE THE TILES THAT USE THE NEW
-- KINDS. Narrowing the CHECK back to six kinds FAILS if any tile is currently a barh,
-- combo or funnel: ADD CONSTRAINT validates existing rows. That is deliberate — it
-- refuses rather than silently rewriting somebody's dashboard. List them first:
--
--     SELECT t.id, t.title, t.viz, d.name AS dashboard
--       FROM app.dashboard_tiles t
--       JOIN app.dashboards d ON d.id = t.dashboard_id
--      WHERE t.viz IN ('barh', 'combo', 'funnel')
--      ORDER BY d.name, t.id;
--
-- Then either delete those tiles or change them to a kind the old renderer draws
-- ('bar' for barh and combo, 'donut' for funnel are the closest), and run this again.
--
-- THIS DOES NOT TOUCH config. Every tile keeps its label / values / stacked / topN keys.
-- An older renderer reads `label` and `value` and ignores the rest, so those tiles fall
-- back to their previous look — the first text column and the first numeric column —
-- rather than breaking. Stripping the keys would throw away the composition for no gain,
-- and would make rolling forward again start from nothing.
--
-- The COMMENT is restored to nothing, which is what it was before 381.

DO $$
BEGIN
  ALTER TABLE app.dashboard_tiles
    DROP CONSTRAINT IF EXISTS dashboard_tiles_viz_check;

  ALTER TABLE app.dashboard_tiles
    ADD CONSTRAINT dashboard_tiles_viz_check
    CHECK (viz = ANY (ARRAY['kpi', 'bar', 'line', 'area', 'donut', 'table']));
END $$;

COMMENT ON COLUMN app.dashboard_tiles.config IS NULL;

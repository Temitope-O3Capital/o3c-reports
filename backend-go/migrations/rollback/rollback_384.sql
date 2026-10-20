-- Undo 384.
--
-- ROLL THE BINARY AND THE FRONTEND BACK FIRST. A build that knows about this column
-- selects it in dashGet and writes it in dashUpdate; against a schema without it, both
-- error and the dashboard stops loading entirely rather than degrading.
--
-- WHAT IS LOST: which slicers each dashboard offered. Nothing else — the current
-- selection was never stored anywhere (it lives in the viewer's page, deliberately), and
-- no tile, report or figure depends on this column. Dashboards go back to being a grid
-- of independently filtered tiles, which is what they were before.
--
-- Authors will have to re-pick their slicers if this is rolled forward again, so list
-- them first if that matters:
--
--     SELECT id, name, config -> 'slicers' AS slicers
--       FROM app.dashboards
--      WHERE config ? 'slicers'
--      ORDER BY id;

ALTER TABLE app.dashboards
  DROP COLUMN IF EXISTS config;

-- Rollback for 358_a_dashboard_is_tiles_over_saved_sources.sql
--
-- Tiles go first even though dashboard_tiles.dashboard_id CASCADEs, so the order is
-- explicit rather than relying on the constraint — and so this reads correctly if
-- someone runs only the first statement.
--
-- THIS DESTROYS LAYOUTS, AND THEY ARE NOT RECOVERABLE. A dashboard's value is the
-- arrangement someone built; the tiles' SOURCES survive (pivot_reports and
-- bi_sql_queries are untouched), but the grid is gone. Take a copy first if any
-- dashboard has been used in earnest:
--
--   CREATE TABLE app.dashboards_backup_358     AS SELECT * FROM app.dashboards;
--   CREATE TABLE app.dashboard_tiles_backup_358 AS SELECT * FROM app.dashboard_tiles;

BEGIN;

DROP TABLE IF EXISTS app.dashboard_tiles;
DROP TABLE IF EXISTS app.dashboards;

COMMIT;

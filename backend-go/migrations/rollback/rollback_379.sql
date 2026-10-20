-- Undo 379.
--
-- ROLL THE BINARY BACK FIRST. A build that knows about tile_only writes it on every
-- dashboard-built tile and filters on it in three list queries; against a schema
-- without the column those queries error and the saved-reports library stops loading
-- altogether. Drop the column only once nothing running reads it.
--
-- THIS LOSES THE DISTINCTION, NOT THE DATA. The reports themselves survive — they are
-- ordinary pivot_reports rows and their tiles keep working, because a tile only needs
-- source_report_id. What is lost is the knowledge of which reports were created by a
-- dashboard rather than built by hand, so every one of them reappears in the
-- saved-reports library and in the tile source picker. That is untidy, not broken.
--
-- Nothing deletes them on the way out: a tile's report outliving a rollback is far
-- better than a rollback quietly removing reports and the tiles that cascade from them.
-- If you want them gone, list them BEFORE dropping the column — afterwards there is no
-- way to tell them apart:
--
--     SELECT id, name, created_at FROM app.pivot_reports WHERE tile_only ORDER BY id;

DROP INDEX IF EXISTS app.pivot_reports_tile_only_idx;

ALTER TABLE app.pivot_reports
  DROP COLUMN IF EXISTS tile_only;

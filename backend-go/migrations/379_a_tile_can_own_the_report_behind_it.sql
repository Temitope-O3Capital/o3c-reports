-- A tile can own the report behind it.
--
-- Dashboard tiles read a saved report or a saved query and never carry their own SQL.
-- That invariant is what makes the per-viewer access check meaningful, and it is not
-- changing here. But it also meant a tile could only ever point at a report someone
-- had already built and named in the Report Builder, so "chart this table" had no
-- route onto a dashboard at all.
--
-- This column lets the dashboard create the report for you. A tile built from a data
-- source writes an ordinary pivot_reports row, flagged tile_only, and points at it the
-- usual way. The tile keeps its foreign key, access is still re-checked per viewer per
-- tile, and nothing about the read path changes.
--
-- The flag exists for ONE reason: to keep these rows out of the lists people browse.
-- A dashboard of twelve charts would otherwise put twelve entries nobody chose to
-- create into the saved-reports library and into the tile source picker, where they
-- would be offered as though they were reusable reports. tile_only rows are excluded
-- from savedListReports, savedMyDashboard and dashSources, and are reachable only
-- through the tile that owns them.
--
-- It is deliberately NOT a new kind of report. Such a row is a normal report in every
-- other respect: same table, same config shape, same dataset guard, same export and
-- email paths. If one should become a report of its own, clearing the flag is the
-- whole change.

-- The ADD and its one-time assertion are together inside this block ON PURPOSE.
--
-- "No report was flagged by this migration" can only be checked at the moment the
-- column is created. Asserting it unconditionally would be correct on the first run
-- and WRONG on every later one: once real dashboard-built tiles exist their reports are
-- legitimately flagged, and a re-run — a manual re-apply, a restored database, a
-- replayed ledger — would abort on perfectly healthy data. So the count is only taken
-- on the run that actually adds the column.
DO $$
DECLARE
  existed boolean;
  n bigint;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'app' AND table_name = 'pivot_reports'
       AND column_name = 'tile_only'
  ) INTO existed;

  IF NOT existed THEN
    ALTER TABLE app.pivot_reports
      ADD COLUMN tile_only boolean NOT NULL DEFAULT FALSE;

    -- Every report that existed before this migration is one somebody built and named.
    -- Not one of them may be hidden by it.
    SELECT count(*) INTO n FROM app.pivot_reports WHERE tile_only;
    IF n <> 0 THEN
      RAISE EXCEPTION 'migration 379: % existing reports came out flagged tile_only; the default must be FALSE', n;
    END IF;
  END IF;
END $$;

-- Only the sweep for rows left behind reads by this flag; every other query on the
-- table reads it unfiltered, so the index is partial and tiny.
CREATE INDEX IF NOT EXISTS pivot_reports_tile_only_idx
  ON app.pivot_reports (tile_only)
  WHERE tile_only;

COMMENT ON COLUMN app.pivot_reports.tile_only IS
  'TRUE when this report exists only to back one dashboard tile: hidden from the saved-reports library and the tile source picker, and deleted with its tile.';

-- These two hold on every run, first or not.
DO $$
BEGIN
  -- The flag must never be null. The list queries say "AND NOT tile_only", and a null
  -- there would silently drop the row from every library listing.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'app' AND table_name = 'pivot_reports'
       AND column_name = 'tile_only' AND is_nullable <> 'NO'
  ) THEN
    RAISE EXCEPTION 'migration 379: tile_only must be NOT NULL';
  END IF;

  -- The cascade this feature relies on: deleting an owned report removes its tile, so
  -- removing a tile can clean up by deleting the report. If this foreign key ever
  -- loses ON DELETE CASCADE, that delete would fail instead of cascading.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'app.dashboard_tiles'::regclass
       AND conname  = 'dashboard_tiles_source_report_id_fkey'
       AND confdeltype = 'c'
  ) THEN
    RAISE EXCEPTION 'migration 379: dashboard_tiles.source_report_id must cascade on delete';
  END IF;
END $$;

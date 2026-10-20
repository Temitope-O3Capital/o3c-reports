-- A dashboard can filter every tile at once.
--
-- Until now a dashboard was a grid of independent reports. Each tile carried its own
-- period, chosen when the tile was built, and there was no way to ask the whole board a
-- question: "the same twelve figures, but only Lagos" meant editing twelve tiles. That
-- is the single biggest thing separating this from a BI tool.
--
-- This column holds which slicers a dashboard OFFERS, not what it is currently filtered
-- to. The distinction matters on a shared board: the author decides that State and
-- Officer are the useful axes, and each viewer narrows to their own selection without
-- changing what anybody else sees. A saved selection would mean one person's filter
-- silently reframing a colleague's figures, which is a good way to have two people
-- quote different numbers from the same dashboard.
--
-- Shape (every key optional):
--   {
--     "slicers": [ {"key": "state", "label": "State"}, ... ],
--     "period":  {"win": "last_30_days"}        -- the board's default window
--   }
--
-- HOW A SLICER REACHES A TILE, AND WHY IT IS NOT A JOIN. Each tile reads its own report
-- over its own dataset, and the datasets are not a star schema — there is no model to
-- traverse. A slicer is matched BY FILTER KEY: it applies to a tile whose dataset
-- declares a filter of that key (exportDataset.Filters), and is ignored by a tile whose
-- dataset has no such filter. So "state" narrows every tile that knows what a state is
-- and leaves the rest alone, and the tile says which filters it honoured rather than
-- implying it answered a question it never saw. That is the honest reading of a
-- collection of independent reports, and it is why the key set a board may offer is
-- computed from its own tiles rather than typed in.
--
-- jsonb, NOT NULL, DEFAULT '{}' so every existing dashboard reads as "no slicers
-- offered" and behaves exactly as it does today.

-- The ADD and its one-time assertion sit together, for the reason migration 379 records:
-- "no dashboard came out already configured" is only true on the run that creates the
-- column. Asserting it unconditionally would abort a re-apply — a replayed ledger, a
-- restored database — on perfectly healthy data, the moment anybody configures a slicer.
DO $$
DECLARE
  existed boolean;
  n bigint;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'app' AND table_name = 'dashboards' AND column_name = 'config'
  ) INTO existed;

  IF NOT existed THEN
    ALTER TABLE app.dashboards
      ADD COLUMN config jsonb NOT NULL DEFAULT '{}'::jsonb;

    -- Every existing dashboard must read as "offers no slicers", which is today's
    -- behaviour. A non-empty config on a board nobody configured means the default is
    -- wrong.
    SELECT count(*) INTO n FROM app.dashboards WHERE config <> '{}'::jsonb;
    IF n <> 0 THEN
      RAISE EXCEPTION 'migration 384: % dashboards came out with a non-empty config; the default must be an empty object', n;
    END IF;
  END IF;
END $$;

COMMENT ON COLUMN app.dashboards.config IS
  'Which slicers this dashboard offers, and its default period — NOT the current selection, which is per viewer and never stored. Keys: slicers (array of {key,label} matched against each tile dataset''s declared filter keys) and period ({win,from,to}). See migration 384.';

-- These hold on every run, first or not.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'app' AND table_name = 'dashboards'
       AND column_name = 'config' AND data_type = 'jsonb'
  ) THEN
    RAISE EXCEPTION 'migration 384: dashboards.config must exist and be jsonb';
  END IF;

  -- NOT NULL with a default, so the handler never has to tell NULL from '{}'.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'app' AND table_name = 'dashboards'
       AND column_name = 'config' AND is_nullable <> 'NO'
  ) THEN
    RAISE EXCEPTION 'migration 384: dashboards.config must be NOT NULL';
  END IF;
END $$;

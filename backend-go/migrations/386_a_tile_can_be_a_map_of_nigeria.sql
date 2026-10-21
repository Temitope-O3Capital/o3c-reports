-- A tile can be a map of Nigeria.
--
-- A dashboard could draw a state as a bar and not as a place, which is the wrong shape
-- for most questions about where business is: "which states are quiet" is a pattern on a
-- map and a ranking on a bar chart, and the two are read differently.
--
-- WHY THIS ONE IS SAFE TO ADD HERE AND WOULD NOT HAVE BEEN A YEAR AGO. A choropleth is
-- only honest if the report's state names and the map's state names are the SAME list.
-- They now are: app.canon_state (migration 376, made inlinable in 383) folds every
-- spelling the data carries — "Lagos State", "FCT, Abuja", "Nassarawa" — onto one of 37
-- canonical names, and the boundary file shipped with the frontend uses exactly those,
-- with geoBoundaries' "Abuja Federal Capital Territory" renamed to FCT to match. So a
-- state that does not colour means the report returned no row for it, never that two
-- spellings failed to meet. Before canon_state existed this visual would have quietly
-- dropped states, which is worse than not offering it.
--
-- NOTHING ABOUT THE GEOMETRY IS IN THE DATABASE, deliberately. The boundaries are a
-- static asset the browser fetches (frontend/public/geo/nigeria-states.json, ~107 KB,
-- simplified to about 550 m of detail). PostGIS is not installed, the shapes never join
-- to anything, and a table of polygons would be a second place for the state list to
-- disagree with canon_state.
--
-- WHY THE CHECK STAYS. It is what stops a viz value the renderer has no branch for being
-- stored and then drawing nothing. A tile that renders blank is worse than a request
-- that is refused, so the constraint is replaced with a longer list rather than dropped.

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
      'scatter', 'matrix', 'map'
    ]));
END $$;

DO $$
DECLARE
  bad   bigint;
  kinds text[] := ARRAY['kpi','bar','line','area','donut','table','barh','combo','funnel','scatter','matrix','map'];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'app.dashboard_tiles'::regclass
       AND conname  = 'dashboard_tiles_viz_check'
  ) THEN
    RAISE EXCEPTION 'migration 386: the viz CHECK is missing; a tile could store a kind that draws nothing';
  END IF;

  SELECT count(*) INTO bad
    FROM app.dashboard_tiles
   WHERE viz <> ALL (kinds);
  IF bad <> 0 THEN
    RAISE EXCEPTION 'migration 386: % tiles hold a viz kind the renderer cannot draw', bad;
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
        RAISE EXCEPTION 'migration 386: the viz CHECK does not admit %, so that tile kind could never be saved', k;
      END IF;
    END LOOP;
  END;
END $$;

-- The claim this visual rests on, asserted rather than assumed: the canonical state list
-- is the 37 the boundary file carries. If a future migration adds a 38th state or renames
-- one, this fails here rather than as a state that silently will not colour.
DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM app.lead_state_hub;
  IF n <> 37 THEN
    RAISE EXCEPTION 'migration 386: app.lead_state_hub holds % states, not 37; the map''s boundary file (frontend/public/geo/nigeria-states.json) carries 37 and would now be missing one', n;
  END IF;

  SELECT count(*) INTO n FROM app.lead_state_hub WHERE state = 'FCT';
  IF n <> 1 THEN
    RAISE EXCEPTION 'migration 386: the canonical name for the capital territory is not FCT; the boundary file renames geoBoundaries'' "Abuja Federal Capital Territory" to FCT and the two must agree';
  END IF;
END $$;

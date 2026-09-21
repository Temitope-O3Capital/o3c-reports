-- Finish the state cleanup that was started and then left orphaned.
--
-- core.state_map (raw_state -> clean_state, 142 rows) was built during the
-- original MSSQL cleanup and is referenced by NOTHING: no Go code, no view, no
-- other migration. Meanwhile every state breakdown in the app groups on the raw
-- column — executive.go's top-10 states, salesByState, salesByCity and
-- reports_business's by_state — so `LAGOS` (8,389), `Lagos` (117) and
-- `LAGOS STATE` (33) are three separate rows in a "top states" chart, and
-- `ABUJA` (1,248), `FCT` (761), `Federal Capital Territory` (69) and
-- `FCT ABUJA` (56) are four.
--
-- Measured against the 2026-09-12 dump (15,262 customers with a state):
--   exact key match          14,895 rows (97.6%)
--   case-folded key match    15,079 rows (98.8%)
--   unmapped after that         183 rows, 52 distinct values
--
-- This migration closes most of that remainder and adds the function the query
-- sites will call, so the normalisation lives in one place instead of being
-- re-implemented in four CASE expressions.

-- ── 1. The missing mappings ────────────────────────────────────────────────
--
-- Methods follow the vocabulary already in the table: 'exact' for a spelling of
-- the state itself, 'inferred_city' where a city/LGA stands in for its state,
-- 'foreign' for a non-Nigerian region (clean_state NULL, the table's existing
-- convention — see its LONDON/ONTARIO/Nairobi/California rows), 'junk' for
-- unusable values.
--
-- ON CONFLICT DO NOTHING against the raw_state primary key: this must be safe to
-- re-run, and must never overwrite a mapping someone curated by hand.
INSERT INTO core.state_map (raw_state, clean_state, method) VALUES
  -- The single largest gap. 'Federal Ca' (truncated) was already mapped; the
  -- full spelling never was.
  ('Federal Capital Territory', 'FCT',         'exact'),
  ('WUSE ZONE 5 ABUJA',         'FCT',         'inferred_city'),

  -- The "<State> State" suffix family, in the casings that actually occur.
  ('Delta State',       'DELTA',       'exact'),
  ('DELTA STATE',       'DELTA',       'exact'),
  ('Delta state',       'DELTA',       'exact'),
  ('Akwa Ibom State',   'AKWA IBOM',   'exact'),
  ('Enugu State',       'ENUGU',       'exact'),
  ('River State',       'RIVERS',      'exact'),
  ('Anambra State',     'ANAMBRA',     'exact'),
  ('Kaduna State',      'KADUNA',      'exact'),
  ('Kwara State',       'KWARA',       'exact'),
  ('Benue State',       'BENUE',       'exact'),
  ('Cross River State', 'CROSS RIVER', 'exact'),
  ('Nasarawa State',    'NASARAWA',    'exact'),
  ('Niger State',       'NIGER',       'exact'),
  ('Adamawa State',     'ADAMAWA',     'exact'),
  ('Bayelsa State',     'BAYELSA',     'exact'),
  ('Borno State',       'BORNO',       'exact'),
  ('Ekiti State',       'EKITI',       'exact'),
  ('Katsina State',     'KATSINA',     'exact'),
  ('Sokoto State',      'SOKOTO',      'exact'),
  ('Taraba State',      'TARABA',      'exact'),
  ('Ondo state',        'ONDO',        'exact'),
  ('plateau state',     'PLATEAU',     'exact'),
  ('zamfara state',     'ZAMFARA',     'exact'),

  -- Bare spellings with no existing key.
  ('CROSS RIVER', 'CROSS RIVER', 'exact'),
  ('Cross River', 'CROSS RIVER', 'exact'),
  -- Jigawa and Kebbi are the first customers from those states, so the canonical
  -- set did not contain them yet. (Yobe still has none.)
  ('Jigawa',      'JIGAWA',      'exact'),
  ('Kebbi',       'KEBBI',       'exact'),

  -- City / LGA standing in for its state.
  ('YOLA',            'ADAMAWA', 'inferred_city'),
  ('borno maiduguri', 'BORNO',   'inferred_city'),
  ('OGBOMOSHO',       'OYO',     'inferred_city'),
  ('Offa',            'KWARA',   'inferred_city'),
  ('mushin',          'LAGOS',   'inferred_city'),
  ('ingawa',          'KATSINA', 'inferred_city'),

  -- Non-Nigerian. clean_state NULL so these drop out of a Nigerian state
  -- breakdown rather than inventing a 37th state.
  ('Massachusetts',        NULL, 'foreign'),
  ('Maharashtra',          NULL, 'foreign'),
  ('County Clare',         NULL, 'foreign'),
  ('County Dublin',        NULL, 'foreign'),
  ('Bradford',             NULL, 'foreign'),
  ('Buckingham',           NULL, 'foreign'),
  ('EAST SUSSEX',          NULL, 'foreign'),
  ('England',              NULL, 'foreign'),
  ('Greater Accra Region', NULL, 'foreign'),
  ('Lancashire',           NULL, 'foreign'),
  ('Nottinghamshire',      NULL, 'foreign'),
  ('Warwickshire',         NULL, 'foreign'),
  ('manchester',           NULL, 'foreign'),
  ('chiba',                NULL, 'foreign')
ON CONFLICT (raw_state) DO NOTHING;

-- Deliberately NOT mapped, and left to show up as unresolved rather than be
-- guessed at: 'ABUJA<mojibake>' (3 rows — the table already holds two corrupted
-- variants of it and matching a third by byte sequence is not something to do
-- blind), 'Karvin<a-acute> District' (1 row, non-ASCII), and 'YO' (1 row —
-- Yobe? Yola? unknowable).

-- ── 2. One place to do the normalising ─────────────────────────────────────
--
-- Returns the mapped value when the table has a row — INCLUDING when that value
-- is NULL, which is how 'foreign' is expressed — and otherwise falls back to
-- UPPER(BTRIM(...)), which is what collapses `Ogun`/`OGUN` and the other 184
-- rows that differ from a key only by case. That distinction between "mapped to
-- nothing" and "not mapped" is the whole reason this is a function and not a
-- COALESCE at each call site.
CREATE OR REPLACE FUNCTION core.clean_state(p_raw text)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE
           WHEN EXISTS (
             SELECT 1 FROM core.state_map m
              WHERE UPPER(m.raw_state) = UPPER(BTRIM(p_raw)))
           THEN (
             SELECT m.clean_state FROM core.state_map m
              WHERE UPPER(m.raw_state) = UPPER(BTRIM(p_raw))
              LIMIT 1)
           ELSE NULLIF(UPPER(BTRIM(p_raw)), '')
         END
$$;

-- The lookup is case-insensitive, so the raw_state primary key cannot serve it.
CREATE INDEX IF NOT EXISTS idx_state_map_upper_raw
  ON core.state_map (UPPER(raw_state));

COMMENT ON FUNCTION core.clean_state(text) IS
  'Canonical Nigerian state for a raw customer state value. NULL means "not a Nigerian state" (foreign/junk) OR no value. Use this instead of grouping on app.customers.state directly — see migration 237.';

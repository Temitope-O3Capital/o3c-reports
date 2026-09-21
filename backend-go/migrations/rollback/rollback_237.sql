DROP INDEX IF EXISTS core.idx_state_map_upper_raw;
DROP FUNCTION IF EXISTS core.clean_state(text);

-- Remove only the rows migration 237 added. Keyed by the exact raw_state values
-- inserted there, so a mapping curated by hand before or after is untouched.
DELETE FROM core.state_map WHERE raw_state IN (
  'Federal Capital Territory', 'WUSE ZONE 5 ABUJA',
  'Delta State', 'DELTA STATE', 'Delta state', 'Akwa Ibom State', 'Enugu State',
  'River State', 'Anambra State', 'Kaduna State', 'Kwara State', 'Benue State',
  'Cross River State', 'Nasarawa State', 'Niger State', 'Adamawa State',
  'Bayelsa State', 'Borno State', 'Ekiti State', 'Katsina State', 'Sokoto State',
  'Taraba State', 'Ondo state', 'plateau state', 'zamfara state',
  'CROSS RIVER', 'Cross River', 'Jigawa', 'Kebbi',
  'YOLA', 'borno maiduguri', 'OGBOMOSHO', 'Offa', 'mushin', 'ingawa',
  'Massachusetts', 'Maharashtra', 'County Clare', 'County Dublin', 'Bradford',
  'Buckingham', 'EAST SUSSEX', 'England', 'Greater Accra Region', 'Lancashire',
  'Nottinghamshire', 'Warwickshire', 'manchester', 'chiba'
);

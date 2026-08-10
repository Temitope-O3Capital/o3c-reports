-- FINISH STEP — run ONLY AFTER the new backend binary (which reads app.customers/
-- accounts/transactions directly) is deployed and verified healthy. Before deploy,
-- the running binary still reads these views + the core.transaction bridge, so
-- dropping them early WILL break production.
--
-- Safety check first (should return 0 rows — nothing outside the objects we drop
-- should depend on `core`):
--   SELECT DISTINCT dependent.relname
--   FROM pg_depend d
--   JOIN pg_rewrite r ON r.oid = d.objid
--   JOIN pg_class dependent ON dependent.oid = r.ev_class
--   JOIN pg_class referenced ON referenced.oid = d.refobjid
--   JOIN pg_namespace n ON n.oid = referenced.relnamespace
--   WHERE n.nspname = 'core'
--     AND dependent.relname NOT IN ('Accounts','Products','Transactions','CIF Table','transaction');

BEGIN;

-- 1. The 4 compatibility views — every handler + recon now reads app.* directly.
DROP VIEW IF EXISTS app."Accounts";
DROP VIEW IF EXISTS app."Products";
DROP VIEW IF EXISTS app."Transactions";
DROP VIEW IF EXISTS app."CIF Table";

-- 2. The recon bridge — the recon engine now reads app.transactions directly.
DROP VIEW IF EXISTS core.transaction;

-- 3. The whole `core` schema is now redundant (the external raw->src->core ingest is
--    retired; only lookup tables + the bridge remained). CASCADE clears the residual
--    lookup tables (product, phone_placeholder, state_map, txn_code_map).
DROP SCHEMA IF EXISTS core CASCADE;

COMMIT;

-- NOT dropped (still in use, unrelated to this consolidation):
--   app."Collections Log", app."Recovery Master Sheet",
--   app.interswitch_txns, app.interswitch_transactions

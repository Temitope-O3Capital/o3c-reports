-- Rollback 255: remove the CCS transaction natural-key unique index.
DROP INDEX IF EXISTS app.uq_ccs_txn_natural;

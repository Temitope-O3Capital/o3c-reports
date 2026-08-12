-- 142_collections_kpi_updated_at.sql
-- collectionsOpsUpsertTarget (PUT /api/collections-ops/targets) INSERTs and
-- DO UPDATE SETs collections_daily_kpi.updated_at, but the table (migration 009)
-- never had that column — so every target upsert failed at runtime with
-- "column updated_at does not exist". Add it so setting daily targets works.

ALTER TABLE collections_daily_kpi
    ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT NOW();

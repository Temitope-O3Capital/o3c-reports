-- DB8: Sync recovery_cases alias columns from originals.
-- 006 created (cif_number, assigned_to_user_id, total_outstanding_kobo, total_recovered_kobo).
-- 015 added aliases (account_cif, assigned_agent_id, outstanding_kobo, recovered_kobo).
-- Handlers query the alias columns; recovery_ops.go now writes to BOTH on each payment log.
-- Backfill alias columns from originals for any rows where they diverged.
UPDATE recovery_cases
SET account_cif = COALESCE(account_cif, cif_number)
WHERE account_cif IS NULL AND cif_number IS NOT NULL;

UPDATE recovery_cases
SET outstanding_kobo = COALESCE(NULLIF(outstanding_kobo, 0), total_outstanding_kobo)
WHERE (outstanding_kobo IS NULL OR outstanding_kobo = 0) AND total_outstanding_kobo > 0;

UPDATE recovery_cases
SET recovered_kobo = COALESCE(NULLIF(recovered_kobo, 0), total_recovered_kobo)
WHERE (recovered_kobo IS NULL OR recovered_kobo = 0) AND total_recovered_kobo > 0;

UPDATE recovery_cases
SET assigned_agent_id = COALESCE(assigned_agent_id, assigned_to_user_id)
WHERE assigned_agent_id IS NULL AND assigned_to_user_id IS NOT NULL;

-- Keep alias columns in sync with originals on future writes via trigger.
CREATE OR REPLACE FUNCTION recovery_cases_sync_cols() RETURNS trigger AS $$
BEGIN
    IF NEW.total_recovered_kobo  IS DISTINCT FROM OLD.total_recovered_kobo  THEN
        NEW.recovered_kobo := NEW.total_recovered_kobo;
    END IF;
    IF NEW.recovered_kobo IS DISTINCT FROM OLD.recovered_kobo THEN
        NEW.total_recovered_kobo := NEW.recovered_kobo;
    END IF;
    IF NEW.total_outstanding_kobo IS DISTINCT FROM OLD.total_outstanding_kobo THEN
        NEW.outstanding_kobo := NEW.total_outstanding_kobo;
    END IF;
    IF NEW.outstanding_kobo IS DISTINCT FROM OLD.outstanding_kobo THEN
        NEW.total_outstanding_kobo := NEW.outstanding_kobo;
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_recovery_cases_sync ON recovery_cases;
CREATE TRIGGER trg_recovery_cases_sync
    BEFORE UPDATE ON recovery_cases
    FOR EACH ROW EXECUTE FUNCTION recovery_cases_sync_cols();

-- DB9: Standardise o3c_activity_log on ip_address TEXT; drop redundant ip TEXT.
-- migration 016 added ip_address TEXT (never written to until now); ip TEXT was original.
-- admin.go now writes ip_address; SELECTs alias ip_address AS ip for backward compat.
UPDATE o3c_activity_log
SET ip_address = COALESCE(ip_address, ip)
WHERE ip_address IS NULL AND ip IS NOT NULL;

-- Drop the superseded columns so the schema is unambiguous.
ALTER TABLE o3c_activity_log DROP COLUMN IF EXISTS ip;
ALTER TABLE o3c_activity_log DROP COLUMN IF EXISTS details; -- JSONB column from 016, never written to

-- DB13: FK constraints on dialer tables → o3c_users(id).
-- Columns exist but had no FK, so orphaned user_ids could accumulate.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'fk_dialer_campaigns_created_by'
    ) THEN
        ALTER TABLE dialer_campaigns
            ADD CONSTRAINT fk_dialer_campaigns_created_by
            FOREIGN KEY (created_by) REFERENCES o3c_users(id) ON DELETE SET NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'fk_dialer_sessions_agent_user_id'
    ) THEN
        ALTER TABLE dialer_sessions
            ADD CONSTRAINT fk_dialer_sessions_agent_user_id
            FOREIGN KEY (agent_user_id) REFERENCES o3c_users(id) ON DELETE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'fk_dialer_call_logs_agent_user_id'
    ) THEN
        ALTER TABLE dialer_call_logs
            ADD CONSTRAINT fk_dialer_call_logs_agent_user_id
            FOREIGN KEY (agent_user_id) REFERENCES o3c_users(id) ON DELETE SET NULL;
    END IF;
END $$;

-- DB15: module_config.updated_by TEXT → BIGINT FK.
-- Drop the existing TEXT column (migration 081) and replace with a typed FK.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'module_config' AND column_name = 'updated_by'
        AND data_type = 'text'
    ) THEN
        ALTER TABLE module_config DROP COLUMN updated_by;
    END IF;
END $$;
ALTER TABLE module_config
    ADD COLUMN IF NOT EXISTS updated_by BIGINT REFERENCES o3c_users(id) ON DELETE SET NULL;

-- DB17: campaign_contacts soft-delete — add deleted_at for NDPR erasure and retention jobs.
ALTER TABLE campaign_contacts
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_campaign_contacts_deleted
    ON campaign_contacts(deleted_at) WHERE deleted_at IS NOT NULL;

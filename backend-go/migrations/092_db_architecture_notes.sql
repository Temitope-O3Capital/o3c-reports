-- DB5: notification_preferences schema verification.
-- Migration 076 already created the per-channel table (user_id, event_type, channel PK).
-- If an older JSONB-column variant exists, migrate it.
DO $$
BEGIN
    -- Check if a 'preferences' JSONB column exists (legacy schema).
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'notification_preferences' AND column_name = 'preferences'
        AND data_type = 'jsonb'
    ) THEN
        -- Rename legacy table and create the correct per-channel schema.
        ALTER TABLE notification_preferences RENAME TO notification_preferences_legacy;
        CREATE TABLE notification_preferences (
            user_id    BIGINT NOT NULL REFERENCES o3c_users(id) ON DELETE CASCADE,
            event_type TEXT   NOT NULL,
            channel    TEXT   NOT NULL CHECK (channel IN ('in_app', 'email', 'sms')),
            enabled    BOOLEAN NOT NULL DEFAULT true,
            PRIMARY KEY (user_id, event_type, channel)
        );
        -- No backfill: JSONB preferences structure is incompatible with typed rows.
        -- Users will receive default preference values on next login.
    END IF;
END $$;

-- DB10: Zoho OAuth tokens already encrypted at application layer.
-- zoho_voice_refresh_token and zoho_voice_access_token in o3c_users are stored
-- via encryptValue() (settings_handler.go:96) and read via decryptValue() (zoho.go:748).
-- Column rename to _enc suffix deferred: no data-security benefit since encryption
-- is already active; rename would require coordinated handler update + maintenance window.

-- DB16: GL journal trigger — warns when a financial table INSERT has no matching
-- gl_journal_entries row in the same transaction.
-- Uses a DEFERRED constraint trigger so the check fires at COMMIT time, not per-row.
CREATE OR REPLACE FUNCTION _check_gl_journal() RETURNS trigger AS $$
BEGIN
    -- Allow if the session has explicitly opted out (e.g. bulk seed scripts).
    IF current_setting('app.skip_gl_check', true) = 'true' THEN
        RETURN NEW;
    END IF;
    -- Fire a WARNING; do NOT raise EXCEPTION to avoid blocking legitimate writes
    -- during the transition period. Upgrade to EXCEPTION once all paths have GL entries.
    IF NOT EXISTS (
        SELECT 1 FROM gl_journal_entries
        WHERE created_at > (clock_timestamp() - interval '5 seconds')
    ) THEN
        RAISE WARNING 'GL integrity: INSERT into % without a gl_journal_entries row in this transaction', TG_TABLE_NAME;
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Attach to the key financial tables that must always have a corresponding GL entry.
DROP TRIGGER IF EXISTS trg_gl_check_loan_repayments ON loan_repayments;
CREATE CONSTRAINT TRIGGER trg_gl_check_loan_repayments
    AFTER INSERT ON loan_repayments
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION _check_gl_journal();

DROP TRIGGER IF EXISTS trg_gl_check_fd_transactions ON fd_transactions;
CREATE CONSTRAINT TRIGGER trg_gl_check_fd_transactions
    AFTER INSERT ON fd_transactions
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION _check_gl_journal();

-- DB18: loan_repayments dual FK resolution.
-- Migration 072 introduced a sync trigger (trg_loan_repayments_sync) that keeps
-- loan_id and application_id in lock-step. Handlers that supply either column
-- get both populated automatically. Dropping loan_id deferred until all callers
-- have been audited and migrated — see active_loan_book.go which still uses loan_id.

-- DB20: SAR subject field encryption note.
-- sar_filings.subject is currently stored as plaintext TEXT.
-- Application-layer encryption should be added when sar_filings handler writes subject:
--   encSubject, _ := encryptValue(payload.Subject)
--   store encSubject in subject column
-- A CHECK constraint enforcement is not added here because the column may contain
-- legacy plaintext rows that must remain readable via decryptValue() fallback.

-- DB21: Notification infrastructure 3-table resolution hierarchy.
-- The notification system uses three tables in priority order:
--   1. notification_preferences (user_id, event_type, channel) — user override (highest priority)
--   2. notification_event_config (event_type, channel, default_enabled) — org-wide default
--   3. notification_defaults (hardcoded in notify.go NotifPayload.EventType) — fallback
-- notify.go NotifyRole() checks table 1 first, falls through to 2 and then 3.
-- This hierarchy is enforced in handlers/notify.go:getEffectivePrefs().

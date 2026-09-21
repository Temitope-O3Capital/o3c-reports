-- Rollback 256: drop per-source alert recipients.
--
-- The monitor falls back to it_admin + admin (its behaviour before 256) when the
-- column is absent, so dropping this does not stop alerting — it only makes every
-- alert go to admins again.
ALTER TABLE app.pipeline_source DROP COLUMN IF EXISTS notify_roles;

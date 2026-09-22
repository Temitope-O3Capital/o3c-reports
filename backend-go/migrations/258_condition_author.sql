-- 258_condition_author.sql
--
-- Who attached a condition to a credit.
--
-- application_conditions has recorded met_by/met_at since migration 004 — who SATISFIED
-- a condition — but never who imposed it. A condition is a term of the approval ("salary
-- domiciliation letter before disbursement"), so the person who set it is part of the
-- credit decision and has to be answerable for it. Without this, a condition appearing on
-- a file was unattributable: the audit trail could show it was met, but not who required
-- it or when it was added by whom.
--
-- Additive and nullable: existing rows keep a NULL author (we genuinely do not know who
-- added them), and the handler writes it from the session user on every new condition.
-- Nothing reads it as NOT NULL, so this is safe to apply while the app is running.

ALTER TABLE application_conditions ADD COLUMN IF NOT EXISTS created_by BIGINT;

COMMENT ON COLUMN application_conditions.created_by IS
  'o3c_users.id of whoever attached this condition. NULL for rows created before migration 258.';

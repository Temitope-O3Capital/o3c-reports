-- Recovery module fix-up.
--
-- The recovery-ops handlers were written against columns that the schema never had:
--   * recovery_field_visits: handlers read/write agent_user_id and visit_type, but the
--     table (migration 006) only has officer_id (NOT NULL), visit_date, address,
--     outcome, notes. Result: GET /visits 500'd, POST /cases/{id}/visit 500'd (it wrote
--     agent_user_id/visit_type and omitted the NOT-NULL officer_id), and case-detail
--     visits silently returned empty.
--   * recovery_payments: recoveryOpsCaseDetailFull joins rp.agent_user_id = u.id, but
--     the column didn't exist, so payments always came back empty in the "full" view.
--
-- Add the columns the code expects, relax the legacy officer_id NOT NULL (new inserts
-- populate agent_user_id instead), and backfill so existing rows keep an agent.

ALTER TABLE app.recovery_field_visits ADD COLUMN IF NOT EXISTS agent_user_id BIGINT;
ALTER TABLE app.recovery_field_visits ADD COLUMN IF NOT EXISTS visit_type    TEXT;
ALTER TABLE app.recovery_field_visits ALTER COLUMN officer_id DROP NOT NULL;
UPDATE app.recovery_field_visits
   SET agent_user_id = officer_id
 WHERE agent_user_id IS NULL AND officer_id IS NOT NULL;

ALTER TABLE app.recovery_payments ADD COLUMN IF NOT EXISTS agent_user_id BIGINT;

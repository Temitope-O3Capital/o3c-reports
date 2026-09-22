-- 255_collections_recovery_integrity_fixes.sql
-- Schema-level fixes from a deep review of the Collections & Recovery module.
-- Verified against production data before writing (no existing row violates any of
-- these): zero duplicate active repayment plans, zero orphaned FKs on either table,
-- zero non-date next_hearing_date values.

-- 1. recovery_payments defaulted status to 'approved' (set in 102, never revisited
--    when 188/197 put payments through a HOP -> COO approval chain), so any insert
--    that omits status is silently pre-approved with no sign-off. The handler code
--    has always set status explicitly on insert, so this has not been exploited —
--    but it is a live landmine for any future/external insert that doesn't. All 264
--    existing rows are already 'approved' through the real chain, so this default
--    change affects only future inserts, never past data.
ALTER TABLE recovery_payments ALTER COLUMN status SET DEFAULT 'pending_hop';

-- 2. Two concurrent "create a repayment plan" requests for the same account both
--    passed the application's pre-transaction existence check and each created their
--    own 'Active' plan, double-counting collections against one debt. The backend fix
--    (collections_ops.go collectionsOpsCreateRepaymentPlan) now checks for this inside
--    the transaction and translates a unique-violation into a clean 409, but the
--    transaction-scoped check alone cannot close the race without a DB constraint —
--    this index is the actual backstop.
CREATE UNIQUE INDEX IF NOT EXISTS uq_repayment_plans_active_cif
  ON repayment_plans (account_cif) WHERE status = 'Active';

-- 3. app.collection_payments carried no FK on assignment_id or received_by, so a
--    deleted assignment or user silently left orphaned references — migration 219 had
--    to manually repoint/null assignment_id for exactly this reason. ON DELETE SET
--    NULL matches how the column is already used (nullable, optional link).
ALTER TABLE app.collection_payments
  ADD CONSTRAINT fk_collection_payments_assignment
    FOREIGN KEY (assignment_id) REFERENCES collection_assignments(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_collection_payments_received_by
    FOREIGN KEY (received_by) REFERENCES o3c_users(id) ON DELETE SET NULL;

-- 4. payment_date and assignment_id are both filtered/joined directly by
--    app.rebuild_collections_daily_kpi (157_income_model_and_collections_kpi.sql)
--    with no supporting index.
CREATE INDEX IF NOT EXISTS idx_collection_payments_date ON app.collection_payments (payment_date);
CREATE INDEX IF NOT EXISTS idx_collection_payments_assignment ON app.collection_payments (assignment_id);

-- 5. app.credit_accommodations had no FKs on its actor/case columns at all, unlike
--    every comparable table in this module.
ALTER TABLE app.credit_accommodations
  ADD CONSTRAINT fk_credit_accommodations_requested_by
    FOREIGN KEY (requested_by) REFERENCES o3c_users(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_credit_accommodations_decided_by
    FOREIGN KEY (decided_by) REFERENCES o3c_users(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_credit_accommodations_recovery_case
    FOREIGN KEY (recovery_case_id) REFERENCES recovery_cases(id) ON DELETE SET NULL;

-- 6. legal_proceedings.next_hearing_date was added as TEXT (015_schema_fixes.sql,
--    because the handler that first used it wrote a different column name than the
--    DATE column 006_recovery.sql already had) while every other date column on the
--    table is a real DATE. No existing value fails the cast.
ALTER TABLE legal_proceedings
  ALTER COLUMN next_hearing_date TYPE DATE USING NULLIF(next_hearing_date, '')::date;

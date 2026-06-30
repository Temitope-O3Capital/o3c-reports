-- Missing indexes identified during Phase 3 audit.
-- All use IF NOT EXISTS so this migration is idempotent.

-- loan_applications: common filter columns
CREATE INDEX IF NOT EXISTS idx_loan_apps_stage        ON loan_applications (stage);
CREATE INDEX IF NOT EXISTS idx_loan_apps_status       ON loan_applications (status);
CREATE INDEX IF NOT EXISTS idx_loan_apps_sales_officer ON loan_applications (sales_officer_id);
CREATE INDEX IF NOT EXISTS idx_loan_apps_assigned_to  ON loan_applications (assigned_to_user_id);
CREATE INDEX IF NOT EXISTS idx_loan_apps_created_at   ON loan_applications (created_at DESC);

-- application_events: pagination by application
CREATE INDEX IF NOT EXISTS idx_app_events_app_id      ON application_events (application_id, created_at DESC);

-- collection_assignments: queue filters
CREATE INDEX IF NOT EXISTS idx_coll_assign_agent      ON collection_assignments (agent_user_id);
CREATE INDEX IF NOT EXISTS idx_coll_assign_stage      ON collection_assignments (current_stage);
CREATE INDEX IF NOT EXISTS idx_coll_assign_cif        ON collection_assignments (account_cif);
CREATE INDEX IF NOT EXISTS idx_coll_assign_dpd        ON collection_assignments (dpd_bucket);

-- collection_promises: agent + honoured status queries
CREATE INDEX IF NOT EXISTS idx_coll_promises_agent    ON collection_promises (agent_user_id);
CREATE INDEX IF NOT EXISTS idx_coll_promises_kept     ON collection_promises (is_kept, promised_date);

-- recovery_cases: queue and status filters
CREATE INDEX IF NOT EXISTS idx_recovery_cases_status  ON recovery_cases (status);
CREATE INDEX IF NOT EXISTS idx_recovery_cases_agent   ON recovery_cases (agent_user_id);

-- o3c_activity_log: per-user and per-page lookups
CREATE INDEX IF NOT EXISTS idx_activity_user          ON o3c_activity_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_page          ON o3c_activity_log (page, created_at DESC);

-- token_denylists: expire-based cleanup (index already in 033, but belt-and-suspenders)
CREATE INDEX IF NOT EXISTS idx_token_denylist_expires ON token_denylists (expires_at);

-- leave_applications: employee + status lookups
CREATE INDEX IF NOT EXISTS idx_leave_employee         ON leave_applications (employee_id, status);
CREATE INDEX IF NOT EXISTS idx_leave_status           ON leave_applications (status);

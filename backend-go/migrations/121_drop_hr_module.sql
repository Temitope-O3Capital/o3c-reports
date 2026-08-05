-- Remove the HR & Payroll module entirely (code removed separately).
-- Drops all HR/Payroll tables and their data. IRREVERSIBLE. Verified that no non-HR
-- table has a foreign key into these tables (all FKs are within the HR set), so CASCADE
-- only clears intra-HR constraints. The shared `departments` table is intentionally kept.

DROP TABLE IF EXISTS
  appraisal_items,
  appraisals,
  disciplinary_actions,
  disciplinary_cases,
  disciplinary_hearings,
  employee_emergency_contacts,
  hr_applicants,
  hr_exits,
  hr_jobs,
  hr_offboarding_items,
  hr_onboarding_items,
  leave_applications,
  leave_balances,
  leave_types,
  payroll_items,
  payroll_runs,
  training_attendance,
  training_sessions,
  employees
CASCADE;

-- Remove the "People" sidebar module registration (no longer used).
DELETE FROM module_config WHERE key = 'people';

-- Rollback for 025_zoho_enrichment
ALTER TABLE helpdesk_tickets DROP COLUMN IF EXISTS description;
ALTER TABLE helpdesk_tickets DROP COLUMN IF EXISTS zoho_department_name;
ALTER TABLE helpdesk_tickets DROP COLUMN IF EXISTS zoho_thread_count;
ALTER TABLE helpdesk_tickets DROP COLUMN IF EXISTS zoho_first_resp_min;
ALTER TABLE helpdesk_tickets DROP COLUMN IF EXISTS zoho_resolve_hours;
-- Add any other columns from 025 here if needed

-- Rollback for 249_report_builder_table_view.sql: return the two call reports to the
-- Summary layout they were saved with. Their Summary settings were never removed.
UPDATE app.pivot_reports
   SET config = config - 'view' - 'columns' - 'totals' - 'sort',
       updated_at = NOW()
 WHERE dataset = 'helpdesk_calls'
   AND name IN ('Outbound Calls Report', 'Inbound Call Report');

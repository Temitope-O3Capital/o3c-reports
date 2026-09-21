-- 249: Report Builder Table view.
--
-- The two call reports saved in the builder were lists built out of the pivot: six
-- fields in Rows to get one line per call. A pivot merges identical lines and stops at
-- 5,000 of them, so on 14 Sept 2026 the Outbound Calls Report showed 5,000 lines for a
-- week of 10,829 calls, losing the newest days, and the Inbound Call Report merged 107
-- of its 246 calls into other lines.
--
-- Table view shows one line per record. Both reports move to it with the same fields,
-- filters and date window, newest call first; the outbound report keeps its talk time,
-- totalled. Their Summary settings stay in the config, so switching a report back to
-- Summary shows its old layout. A report with no view is a Summary.

UPDATE app.pivot_reports
   SET config = config || jsonb_build_object(
         'view', 'table',
         'columns', '[{"key":"started_at"},{"key":"direction"},{"key":"purpose"},{"key":"customer_phone"},{"key":"customer_name"},{"key":"disposition"},{"key":"duration_sec"}]'::jsonb,
         'totals', '["duration_sec"]'::jsonb,
         'sort', '[{"key":"started_at","dir":"desc"}]'::jsonb),
       updated_at = NOW()
 WHERE dataset = 'helpdesk_calls'
   AND name = 'Outbound Calls Report'
   AND NOT (config ? 'view');

UPDATE app.pivot_reports
   SET config = config || jsonb_build_object(
         'view', 'table',
         'columns', '[{"key":"started_at"},{"key":"direction"},{"key":"purpose"},{"key":"customer_phone"},{"key":"customer_name"},{"key":"disposition"}]'::jsonb,
         'sort', '[{"key":"started_at","dir":"desc"}]'::jsonb),
       updated_at = NOW()
 WHERE dataset = 'helpdesk_calls'
   AND name = 'Inbound Call Report'
   AND NOT (config ? 'view');

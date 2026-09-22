-- Rollback 257: restore migration 238's customer-feed thresholds and its
-- manual-upload run times (NULL by design there).
--
-- Reverting the thresholds will make the customer feed alert stale again after
-- 36 hours and taper whenever its volume falls below a fifth of the median —
-- which, measured, happens on an ordinary quiet day.
UPDATE app.pipeline_source
   SET warn_after         = interval '12 hours',
       stale_after        = interval '36 hours',
       volume_floor_ratio = 0.20,
       notes              = 'E:\cust_file. Customers change rarely — only ~27 non-empty drops/day — so the thresholds are wider than the other two feeds.',
       updated_at         = now()
 WHERE source_key = 'customer_feed';

-- Put the three manual sources back to NULL run times. Everything else in the
-- view is unchanged, so it is rebuilt from 238's definition by re-running that
-- migration's view block; the simplest safe rollback is to drop the view and let
-- migration 238 recreate it on the next boot.
DROP VIEW IF EXISTS app.v_pipeline_freshness;
DROP VIEW IF EXISTS app.v_pipeline_data_age;
-- Reverse 257: the five split reports go back to being template='custom' presets.
-- Their sections column is untouched throughout, so nothing about what they render
-- changes either way. Run this BEFORE reverting handlers/management_reports.go, or the
-- API will still offer templates the constraint refuses.
UPDATE app.management_reports SET template = 'custom', updated_at = NOW()
 WHERE template IN ('executive_briefing', 'sales_products', 'collections_recovery',
                    'leads_contact_centre', 'customers_demographics');

ALTER TABLE app.management_reports DROP CONSTRAINT IF EXISTS management_reports_template_check;
ALTER TABLE app.management_reports ADD CONSTRAINT management_reports_template_check
  CHECK (template IN ('management', 'sales', 'custom'));

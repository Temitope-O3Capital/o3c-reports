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

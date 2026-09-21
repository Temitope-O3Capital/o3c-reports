-- The five reports the long management email was split into (2026-09-21) become real
-- templates rather than presets.
--
-- Until now sections.json carried seven templates while the API accepted three
-- ("management", "sales", "custom") and this constraint allowed the same three, so the
-- five split reports had to be stored as template='custom' with their section list copied
-- in. That works — the generator renders anything that is not management/sales through
-- customFrame either way — but it means the Report Editor cannot offer them when someone
-- creates a new report, and TestMRCatalogueFile fails on the mismatch.
--
-- Widening the constraint is the DB half; handlers/management_reports.go mrTemplates is
-- the API half. Both must list the same set as sections.json.
ALTER TABLE app.management_reports DROP CONSTRAINT IF EXISTS management_reports_template_check;
ALTER TABLE app.management_reports ADD CONSTRAINT management_reports_template_check
  CHECK (template IN ('management', 'sales', 'custom',
                      'executive_briefing', 'sales_products', 'collections_recovery',
                      'leads_contact_centre', 'customers_demographics'));

-- Point the five existing reports (and any monthly counterpart) at their own template.
-- Their sections column already holds the explicit list, so what renders does not change;
-- what changes is that the editor now shows them as what they are.
UPDATE app.management_reports SET template = 'executive_briefing', updated_at = NOW()
 WHERE report_key LIKE 'executive-briefing%' AND template = 'custom';
UPDATE app.management_reports SET template = 'sales_products', updated_at = NOW()
 WHERE report_key LIKE 'sales-products%' AND template = 'custom';
UPDATE app.management_reports SET template = 'collections_recovery', updated_at = NOW()
 WHERE report_key LIKE 'collections-recovery%' AND template = 'custom';
UPDATE app.management_reports SET template = 'leads_contact_centre', updated_at = NOW()
 WHERE report_key LIKE 'leads-contact-centre%' AND template = 'custom';
UPDATE app.management_reports SET template = 'customers_demographics', updated_at = NOW()
 WHERE report_key LIKE 'customers-demographics%' AND template = 'custom';

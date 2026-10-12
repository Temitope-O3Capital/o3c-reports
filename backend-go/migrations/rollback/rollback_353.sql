-- Rollback 353. Everything it added is additive, so this is a clean reverse.
--
-- The one thing that is NOT reversed: cities and states agents have captured since 353
-- shipped. Dropping call_center_leads.city would throw that away, so it is dropped last
-- and deliberately — comment the ALTER out if the data is worth keeping while the rest of
-- the feature is rolled back.

DROP INDEX IF EXISTS app.uq_sales_visit_plans_live;
DROP INDEX IF EXISTS app.idx_sales_visit_plans_contact;
DROP INDEX IF EXISTS app.idx_sales_visit_plans_day;
DROP INDEX IF EXISTS app.idx_sales_visit_plans_officer_day;
DROP TABLE IF EXISTS app.sales_visit_plans;

DROP INDEX IF EXISTS app.idx_crm_contacts_sales_state;

DROP FUNCTION IF EXISTS app.sales_hub_for_office(TEXT);
DROP FUNCTION IF EXISTS app.sales_hub_for_state(TEXT);
DROP TABLE IF EXISTS app.lead_state_hub;

ALTER TABLE app.call_center_leads DROP COLUMN IF EXISTS city;

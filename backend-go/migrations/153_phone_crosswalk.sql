-- 153: Phone crosswalk — link call activity to customers/leads by normalized phone.
--
-- The call centre logs 108k+ calls in helpdesk_calls keyed only by the dialled/received
-- number (customer_phone). Sales leads (crm_contacts.phone) and the customer master
-- (app.customers.phone) also carry numbers. There was no join between them, so a call
-- never surfaced on the lead, the book, or Customer 360.
--
-- Matching convention (used everywhere in this codebase — call_center_outbound.go,
-- helpdesk.go): the LAST 10 DIGITS of the number, stripped of non-digits. That absorbs
-- +234 / 0-prefix / spacing differences. We don't materialize a crosswalk table; the
-- match is computed live in queries. These expression indexes make that match fast.
--
-- The expressions are IMMUTABLE (regexp_replace / right / coalesce), so they are valid
-- index expressions. Idempotent.

CREATE INDEX IF NOT EXISTS idx_helpdesk_calls_phone10
    ON helpdesk_calls (right(regexp_replace(COALESCE(customer_phone,''),'\D','','g'),10));

CREATE INDEX IF NOT EXISTS idx_crm_contacts_phone10
    ON crm_contacts (right(regexp_replace(COALESCE(phone,''),'\D','','g'),10));

CREATE INDEX IF NOT EXISTS idx_customers_phone10
    ON app.customers (right(regexp_replace(COALESCE(phone,''),'\D','','g'),10));

-- Rollback 315: put crm_contacts.tags back.
--
-- Restores the column, empty. That is a complete restoration only because 315 refused to
-- run unless the column was empty on every row — see its guard. Nothing was lost, so
-- nothing has to be recovered.
--
-- The six code references removed alongside 315 must be reverted too, or the column exists
-- again and nothing reads or writes it: crm.go (contactUpdateCols, createContact's struct
-- and INSERT, the customer360 SELECT), sales_leads.go (the PATCH whitelist), and
-- ContactDetail.tsx (the interface field and the InfoRow).
--
-- Labels themselves live in app.crm_lead_tags and are untouched by this.

ALTER TABLE app.crm_contacts ADD COLUMN IF NOT EXISTS tags text;

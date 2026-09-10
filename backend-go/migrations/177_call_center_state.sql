-- Migration 177: add a geographic "state" field to the Call Center lead board and
-- the outbound queue, so an imported prospect's state (Lagos, FCT, …) is captured,
-- shown, and editable there — matching Sales/CRM (crm_contacts.state) and Campaigns
-- (contact_list_members.state, migration 176). Idempotent.

ALTER TABLE call_center_leads    ADD COLUMN IF NOT EXISTS state TEXT;
ALTER TABLE call_center_contacts ADD COLUMN IF NOT EXISTS state TEXT;

CREATE INDEX IF NOT EXISTS idx_cc_leads_state
    ON call_center_leads(state) WHERE state IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cc_contacts_state
    ON call_center_contacts(state) WHERE state IS NOT NULL;

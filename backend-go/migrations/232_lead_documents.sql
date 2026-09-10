-- 232_lead_documents.sql
--
-- Documents attached to a lead / contact / customer BEFORE (or without) a loan application.
--
-- los_documents requires a loan_application id, so the "agent collects the customer's
-- documents" step in the call-centre / sales phase had nowhere to store a file. This table
-- is the pre-application home, anchored the same way activities are (lead/contact/cif/phone)
-- so an uploaded document lands on the customer's timeline via a 'document' activity and
-- follows the person once they convert.

CREATE TABLE IF NOT EXISTS app.lead_documents (
    id              BIGSERIAL PRIMARY KEY,
    lead_id         BIGINT,        -- app.call_center_leads.id
    contact_id      BIGINT,        -- app.crm_contacts.id
    cif             TEXT,
    phone           TEXT,          -- normalised last-10
    doc_type        TEXT NOT NULL,
    file_name       TEXT NOT NULL,
    file_url        TEXT,
    storage_key     TEXT,
    file_size_bytes BIGINT,
    uploaded_by     BIGINT,        -- o3c_users.id
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lead_documents_lead    ON app.lead_documents (lead_id)    WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lead_documents_contact ON app.lead_documents (contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lead_documents_cif     ON app.lead_documents (cif)        WHERE cif IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lead_documents_phone   ON app.lead_documents (phone)      WHERE phone IS NOT NULL;

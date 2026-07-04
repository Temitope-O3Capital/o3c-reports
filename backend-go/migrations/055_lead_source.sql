-- Migration 055: Add lead_source to loan_applications and crm_contacts

ALTER TABLE loan_applications
  ADD COLUMN IF NOT EXISTS lead_source TEXT,
  ADD COLUMN IF NOT EXISTS campaign_id BIGINT REFERENCES campaigns(id);

ALTER TABLE crm_contacts
  ADD COLUMN IF NOT EXISTS lead_source TEXT;

CREATE INDEX IF NOT EXISTS idx_loan_lead_source   ON loan_applications(lead_source);
CREATE INDEX IF NOT EXISTS idx_loan_campaign_id   ON loan_applications(campaign_id);
CREATE INDEX IF NOT EXISTS idx_crm_lead_source    ON crm_contacts(lead_source);

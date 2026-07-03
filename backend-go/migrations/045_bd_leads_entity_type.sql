-- Migration 045: Add entity_type and lead_score to bd_leads

ALTER TABLE bd_leads
  ADD COLUMN IF NOT EXISTS entity_type TEXT NOT NULL DEFAULT 'company',
  ADD COLUMN IF NOT EXISTS lead_score  INT;

COMMENT ON COLUMN bd_leads.entity_type IS 'company | individual | individual_at_company';

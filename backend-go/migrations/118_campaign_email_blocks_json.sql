-- Persist the visual email-block model for campaigns.
--
-- The campaign update whitelist (campaignUpdateCols) already references
-- email_blocks_json, but the column was never created by any migration. As a
-- result EVERY email-campaign save that included email_blocks_json (all of them)
-- failed the whole UPDATE — so email_body_html/subject never persisted and test
-- sends went out empty. This creates the column so content saves and email
-- campaigns can be re-edited (the builder rehydrates from email_blocks_json).
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS email_blocks_json TEXT;

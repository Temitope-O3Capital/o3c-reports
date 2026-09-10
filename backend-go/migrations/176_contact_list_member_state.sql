-- Migration 176: promote "state" to a first-class contact_list_members column.
--
-- State used to ride along inside merge_data (any unknown CSV column lands there),
-- which meant it was stored but never shown or editable in the Contact Lists UI.
-- Make it a real column so it can be displayed, edited, imported, and used for
-- targeting. Campaigns still get {{state}} as a merge token — the campaign snapshot
-- folds this column back into merge_data at copy time (see campaigns.go).

ALTER TABLE contact_list_members ADD COLUMN IF NOT EXISTS state TEXT;

-- Backfill from any merge_data that already carried a state (earlier CSV imports)…
UPDATE contact_list_members
   SET state = NULLIF(TRIM(merge_data->>'state'), '')
 WHERE state IS NULL AND merge_data ? 'state';

-- …then drop the duplicate key so the column is the single source of truth.
UPDATE contact_list_members
   SET merge_data = merge_data - 'state'
 WHERE merge_data ? 'state';

CREATE INDEX IF NOT EXISTS idx_contact_list_members_state
    ON contact_list_members(state) WHERE state IS NOT NULL;

-- Per-step audience filtering for campaign sequences.
--
-- A step can target a subset of the campaign audience based on prior engagement
-- (e.g. "day 2 SMS only to people who didn't open the day-1 email"). The filter
-- is evaluated against each contact's current campaign_contacts status at the
-- time the step fires.
ALTER TABLE campaign_steps ADD COLUMN IF NOT EXISTS audience_filter TEXT NOT NULL DEFAULT 'all';

-- Rollback 350: put the three weekly reports back to their first-draft section lists.
--
-- Reverses a CONTENT decision, not a defect fix, so it is worth having. Run it if the
-- fuller weekly reports read as too long for a weekly, or if Collections and the lead
-- desk would rather keep the recovery book and the lead-stage breakdown to the daily and
-- monthly cadences they already appear in.
--
-- Note what reverting costs: each weekly report's own description then over-promises
-- again, because the descriptions were already written for the fuller content and this
-- migration did not touch them. If you revert, trim the descriptions to match --
--
--   collections-recovery    drop "...then the recovery case book."
--   customers-demographics  drop "...where they are and their age profile."
--   leads-contact-centre    drop "...and every interested lead still waiting, by stage."
--
-- -- otherwise the reports go back to saying more than they show, which is the state
-- this migration existed to end.
--
-- The narrower reason to run only PART of this: 'chart_customers_age' is 86.3% "Not
-- recorded" (15,864 of 18,384 issued cards), because app.customers.birthday is populated
-- on 2,759 of 22,227 rows. If that one chart is the problem and the rest is wanted, run
-- the single statement marked AGE ONLY below instead of the whole file.
--
-- Guarded on the exact post-350 value, so running it twice is harmless and a list edited
-- by hand since is left alone.

BEGIN;

UPDATE app.management_reports
   SET sections   = '["collections_expected"]'::jsonb,
       updated_at = NOW()
 WHERE report_key = 'collections-recovery'
   AND sections::jsonb = '["collections_expected", "recovery"]'::jsonb;

UPDATE app.management_reports
   SET sections   = '["registrations"]'::jsonb,
       updated_at = NOW()
 WHERE report_key = 'customers-demographics'
   AND sections::jsonb = '["registrations", "demographics", "chart_customers_location", "chart_customers_age"]'::jsonb;

UPDATE app.management_reports
   SET sections   = '["chart_pitched", "contact_centre"]'::jsonb,
       updated_at = NOW()
 WHERE report_key = 'leads-contact-centre'
   AND sections::jsonb = '["chart_pitched", "contact_centre", "qualified_leads", "chart_lead_stages"]'::jsonb;

COMMIT;

-- AGE ONLY -- drop just the age chart and keep everything else 350 added.
-- Run this INSTEAD of the transaction above if the age profile is the only objection.
--
-- BEGIN;
-- UPDATE app.management_reports
--    SET sections   = '["registrations", "demographics", "chart_customers_location"]'::jsonb,
--        updated_at = NOW()
--  WHERE report_key = 'customers-demographics'
--    AND sections::jsonb = '["registrations", "demographics", "chart_customers_location", "chart_customers_age"]'::jsonb;
-- COMMIT;

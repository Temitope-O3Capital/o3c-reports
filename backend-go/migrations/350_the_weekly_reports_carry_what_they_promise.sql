-- Give the three weekly management reports the sections their own descriptions promise.
--
-- THE DEFECT. Each of these three weekly reports renders strictly less than it says it
-- does, and has since it was created. Measured 2026-10-07 against the live rows:
--
--   collections-recovery    description ends "...then the recovery case book."
--                           sections: ["collections_expected"]          — no recovery
--   customers-demographics  description ends "...where they are and their age profile."
--                           sections: ["registrations"]                 — neither
--   leads-contact-centre    description ends "...every interested lead still waiting,
--                           by stage."
--                           sections: ["chart_pitched","contact_centre"] — no stages
--
-- The rendered output confirms it. Built with --dry on 2026-10-07, Collections & Recovery
-- weekly is 9.5KB and stops at the credit-card statement; Customers & Demographics weekly
-- is 6.7KB and contains exactly two figures, "New customers 18" and "Cards opened 15".
--
-- WHY THESE SECTIONS AND NOT SOME OTHER CHOICE. This is not a judgement about what a
-- weekly report ought to contain — it is read off the rows themselves. Each weekly's
-- description is WORD FOR WORD its monthly sibling's, minus the "The closed month:"
-- prefix, so the monthly's section list is the documented intent for both:
--
--   collections-recovery-monthly    [collections_expected, chart_mom_collections, recovery]
--   customers-demographics-monthly  [registrations, chart_mom_customers, demographics,
--                                    chart_customers_location, chart_customers_age]
--   leads-contact-centre-monthly    [chart_pitched, contact_centre, chart_mom_leads,
--                                    qualified_leads, chart_lead_stages]
--
-- Take each monthly list, drop the month-on-month chart (a closed-month device: a weekly
-- report covering seven days has no month to compare), and what remains is exactly what
-- the weekly description promises. That is what this migration writes.
--
-- The creation timestamps say the same thing. The three weeklies were created 2026-09-21
-- at 06:14; their daily siblings at 09:01 and their monthly siblings at 10:21, each batch
-- richer than the last. The weeklies are first drafts that were never backfilled — which
-- is also why the two DAILY reports already carry 'recovery' and 'qualified_leads' while
-- the weekly ones do not.
--
-- THE SECTIONS ARE ALREADY BUILT. Nothing new is implemented here. `node build-reports.js
-- --check` reports "catalogue sections without an implementation: none", and every section
-- added below already renders in a sibling report today. Verified in the 2026-10-07 dry
-- run: 'recovery' produces 461 active cases, 248 legal, NGN 1.64bn outstanding and
-- NGN 921.2m recovered to date; 'chart_customers_location' produces Lagos 11,927, FCT /
-- Abuja 2,158, Oyo 1,106 — already correctly merging the LAGOS/Lagos and ABUJA/FCT
-- spellings that are split in app.customers, so no data cleanup is needed to use it.
--
-- ONE SECTION ADDED WITH A CAVEAT. 'chart_customers_age' is included because the weekly
-- description promises an age profile and the monthly already ships it — not because the
-- data is good. 18,384 issued cards break down as "Not recorded" 15,864 (86.3%), 45-54
-- 1,147, 35-44 688, 55+ 431, under 35 254, because app.customers.birthday is populated on
-- only 2,759 of 22,227 rows. The chart is honest and nearly useless; the fix is capturing
-- dates of birth at onboarding, not a different chart. Flagged rather than silently
-- dropped, so the decision stays visible.
--
-- WHAT THIS DELIBERATELY DOES NOT DO. It does not set is_active. All 18 reports were
-- switched off on purpose on 2026-09-23 and 09-24, and turning them back on is a decision
-- for whoever switched them off, not a side effect of a content fix.
--
-- Guarded on the exact first-draft value, so re-running changes nothing and a list someone
-- has since edited by hand is left alone.

BEGIN;

UPDATE app.management_reports
   SET sections   = '["collections_expected", "recovery"]'::jsonb,
       updated_at = NOW()
 WHERE report_key = 'collections-recovery'
   AND sections::jsonb = '["collections_expected"]'::jsonb;

UPDATE app.management_reports
   SET sections   = '["registrations", "demographics", "chart_customers_location", "chart_customers_age"]'::jsonb,
       updated_at = NOW()
 WHERE report_key = 'customers-demographics'
   AND sections::jsonb = '["registrations"]'::jsonb;

UPDATE app.management_reports
   SET sections   = '["chart_pitched", "contact_centre", "qualified_leads", "chart_lead_stages"]'::jsonb,
       updated_at = NOW()
 WHERE report_key = 'leads-contact-centre'
   AND sections::jsonb = '["chart_pitched", "contact_centre"]'::jsonb;

COMMIT;

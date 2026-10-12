-- Give the business clock Nigeria's actual holidays, for the whole calendar it spans.
--
-- Migration 355 built the clock and seeded app.public_holidays with the fixed and
-- Easter-derived federal holidays for 2024-2027, and deliberately left the Islamic
-- ones out: they are lunar, declared close to the day, and a wrong date in the one
-- table every duration depends on is worse than a known gap. That was the right call
-- at the time. It left three problems, and all three are measurable.
--
-- 1. THE ISLAMIC HOLIDAYS WERE COUNTED AS FULL WORKING DAYS. Nigeria observes five:
--    Eid al-Fitr and Id el Kabir two days each, and Id el Maulud. Each was worth 540
--    minutes of working time the office was shut. In the window the helpdesk data
--    actually covers (2025-12-15 to 2026-10-12) that is five weekdays -- 19 and 20
--    March, 27 and 28 May, 25 August 2026 -- and 152 resolved tickets span them. Those
--    tickets have up to nine working hours of fictitious elapsed time each, which is
--    how a ticket well inside its SLA is recorded as a breach. handlers/performance.go
--    reports on this clock, so the figures on the Staff Performance page were affected.
--
-- 2. THE CALENDAR SPANS 2015-2040 AND ONLY FOUR YEARS HAD ANY HOLIDAYS AT ALL. 22 of
--    26 years had none, so any duration measured outside 2024-2027 treated Christmas
--    and Independence Day as ordinary working days.
--
-- 3. A HOLIDAY ON A WEEKEND VANISHED INSTEAD OF MOVING. app.business_hours has Monday
--    to Friday only, so a Saturday holiday already contributes nothing -- but the
--    working day the Federal Government declares in its place was absent, and was
--    counted as open. 2027 is the worst case: four of its eight holidays fall on a
--    Saturday or Sunday.
--
-- WHERE THE DATES COME FROM, SINCE THAT IS THE WHOLE RISK HERE. Two sources, neither
-- of them anybody's recollection:
--
--   fixed + Easter   arithmetic. Easter by the anonymous Gregorian computus, so Good
--                    Friday and Easter Monday are derived rather than remembered.
--                    Democracy Day is 12 June from 2019 and 29 May before it.
--   Islamic + one-offs
--                    Google's Nigerian public holiday calendar (en.ng#holiday), which
--                    is reachable from this host, needs no key, covers 2021-2031 and
--                    is the only source tested that carries the Islamic dates at all.
--                    Nager.Date also covers Nigeria and was rejected: it has none of
--                    the five Islamic holidays in any year, and it adds Children's Day
--                    and National Youth Day, which are not work-free here.
--
-- The two agree on every date they both produce, including all eight Easter dates
-- 2024-2027, which is the cross-check that made the feed trustworthy enough to use.
--
-- The feed is FILTERED by an explicit allow-list, because it also carries about a
-- dozen observances a year that are not work-free: Valentine's Day, Ash Wednesday,
-- Women's Day, Mothering Sunday, Ramadan Start, Father's Day, Christmas Eve, New
-- Year's Eve, Al-Hijra, Holy Saturday, Easter Sunday and Children's Day. That last
-- one matters: on 2026-05-27 it shares a date with Id el Kabir, and only the Eid is
-- work-free. Taking the feed wholesale would have closed the office on Valentine's Day.
--
-- is_estimated CARRIES THE UNCERTAINTY INSTEAD OF HIDING IT. The feed marks future
-- lunar dates "(tentative)" and that flag is kept, so a figure computed over an
-- estimated date can say so. 31 of the 319 rows are estimated, all of them future
-- Eids; every date in the measured window is a declared one.
--
-- WEEKEND SUBSTITUTION is Temitope's decision of 2026-10-12: a holiday on EITHER
-- Saturday or Sunday is observed on the next working day. The Public Holidays Act
-- only provides for Sunday, and Saturday is Federal Government discretion, so this is
-- a policy choice rather than a reading of the law -- it is recorded as source
-- 'substitution' and can be reversed by deleting those rows. Allocation runs in date
-- order, so two consecutive weekend holidays take the Monday and then the Tuesday and
-- never collide with a holiday that already exists.
--
-- AND THE TRAP THAT MADE ALL OF THIS INVISIBLE: app.business_calendar is
-- materialised, so inserting a holiday did nothing at all until somebody remembered
-- to call app.rebuild_business_calendar(). Nothing said so. A trigger now does it,
-- which means the next person to add an Eid date gets it applied by the act of adding
-- it.

/* ── The uncertainty and the provenance become columns ──────────────────────── */

ALTER TABLE app.public_holidays
  ADD COLUMN IF NOT EXISTS source       text    NOT NULL DEFAULT 'seed',
  ADD COLUMN IF NOT EXISTS is_estimated boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN app.public_holidays.source IS
  'arithmetic = fixed or Easter-derived; google_ics = Google en.ng#holiday feed; '
  'substitution = moved off a weekend; seed = migration 355''s original rows; '
  'manual = entered by hand, which always wins over a later import.';
COMMENT ON COLUMN app.public_holidays.is_estimated IS
  'true for a lunar date not yet declared by the Federal Government. Any duration '
  'computed across one is approximate and should be labelled as such.';

/* ── The holidays ───────────────────────────────────────────────────────────── */
-- A date entered by hand is never overwritten by an import: that is what lets HR
-- correct an Eid that landed a day out without the correction being undone.

INSERT INTO app.public_holidays (date, name, source, is_estimated) VALUES
  ('2015-01-01', 'New Year''s Day', 'arithmetic', false),
  ('2015-04-03', 'Good Friday', 'arithmetic', false),
  ('2015-04-06', 'Easter Monday', 'arithmetic', false),
  ('2015-05-01', 'Workers'' Day', 'arithmetic', false),
  ('2015-05-29', 'Democracy Day', 'arithmetic', false),
  ('2015-10-01', 'Independence Day', 'arithmetic', false),
  ('2015-12-25', 'Christmas Day', 'arithmetic', false),
  ('2015-12-26', 'Boxing Day', 'arithmetic', false),
  ('2015-12-28', 'Boxing Day (observed)', 'substitution', false),
  ('2016-01-01', 'New Year''s Day', 'arithmetic', false),
  ('2016-03-25', 'Good Friday', 'arithmetic', false),
  ('2016-03-28', 'Easter Monday', 'arithmetic', false),
  ('2016-05-01', 'Workers'' Day', 'arithmetic', false),
  ('2016-05-02', 'Workers'' Day (observed)', 'substitution', false),
  ('2016-05-29', 'Democracy Day', 'arithmetic', false),
  ('2016-05-30', 'Democracy Day (observed)', 'substitution', false),
  ('2016-10-01', 'Independence Day', 'arithmetic', false),
  ('2016-10-03', 'Independence Day (observed)', 'substitution', false),
  ('2016-12-25', 'Christmas Day', 'arithmetic', false),
  ('2016-12-26', 'Boxing Day', 'arithmetic', false),
  ('2016-12-27', 'Christmas Day (observed)', 'substitution', false),
  ('2017-01-01', 'New Year''s Day', 'arithmetic', false),
  ('2017-01-02', 'New Year''s Day (observed)', 'substitution', false),
  ('2017-04-14', 'Good Friday', 'arithmetic', false),
  ('2017-04-17', 'Easter Monday', 'arithmetic', false),
  ('2017-05-01', 'Workers'' Day', 'arithmetic', false),
  ('2017-05-29', 'Democracy Day', 'arithmetic', false),
  ('2017-10-01', 'Independence Day', 'arithmetic', false),
  ('2017-10-02', 'Independence Day (observed)', 'substitution', false),
  ('2017-12-25', 'Christmas Day', 'arithmetic', false),
  ('2017-12-26', 'Boxing Day', 'arithmetic', false),
  ('2018-01-01', 'New Year''s Day', 'arithmetic', false),
  ('2018-03-30', 'Good Friday', 'arithmetic', false),
  ('2018-04-02', 'Easter Monday', 'arithmetic', false),
  ('2018-05-01', 'Workers'' Day', 'arithmetic', false),
  ('2018-05-29', 'Democracy Day', 'arithmetic', false),
  ('2018-10-01', 'Independence Day', 'arithmetic', false),
  ('2018-12-25', 'Christmas Day', 'arithmetic', false),
  ('2018-12-26', 'Boxing Day', 'arithmetic', false),
  ('2019-01-01', 'New Year''s Day', 'arithmetic', false),
  ('2019-04-19', 'Good Friday', 'arithmetic', false),
  ('2019-04-22', 'Easter Monday', 'arithmetic', false),
  ('2019-05-01', 'Workers'' Day', 'arithmetic', false),
  ('2019-06-12', 'Democracy Day', 'arithmetic', false),
  ('2019-10-01', 'Independence Day', 'arithmetic', false),
  ('2019-12-25', 'Christmas Day', 'arithmetic', false),
  ('2019-12-26', 'Boxing Day', 'arithmetic', false),
  ('2020-01-01', 'New Year''s Day', 'arithmetic', false),
  ('2020-04-10', 'Good Friday', 'arithmetic', false),
  ('2020-04-13', 'Easter Monday', 'arithmetic', false),
  ('2020-05-01', 'Workers'' Day', 'arithmetic', false),
  ('2020-06-12', 'Democracy Day', 'arithmetic', false),
  ('2020-10-01', 'Independence Day', 'arithmetic', false),
  ('2020-12-25', 'Christmas Day', 'arithmetic', false),
  ('2020-12-26', 'Boxing Day', 'arithmetic', false),
  ('2020-12-28', 'Boxing Day (observed)', 'substitution', false),
  ('2021-01-01', 'New Year''s Day', 'google_ics', false),
  ('2021-04-02', 'Good Friday', 'google_ics', false),
  ('2021-04-05', 'Easter Monday', 'google_ics', false),
  ('2021-05-01', 'Workers'' Day', 'google_ics', false),
  ('2021-05-03', 'Workers'' Day (observed)', 'substitution', false),
  ('2021-05-12', 'Eid El-Fitr Holiday', 'google_ics', false),
  ('2021-05-13', 'Eid El-Fitr', 'google_ics', false),
  ('2021-06-12', 'Democracy Day', 'google_ics', false),
  ('2021-06-14', 'Democracy Day (observed)', 'substitution', false),
  ('2021-07-20', 'Id el Kabir', 'google_ics', false),
  ('2021-07-21', 'Id el Kabir Holiday', 'google_ics', false),
  ('2021-10-01', 'Independence Day', 'google_ics', false),
  ('2021-10-19', 'Id el Maulud', 'google_ics', false),
  ('2021-12-25', 'Christmas Day', 'google_ics', false),
  ('2021-12-26', 'Boxing Day', 'google_ics', false),
  ('2021-12-27', 'Boxing Day (observed)', 'substitution', false),
  ('2022-01-01', 'New Year''s Day', 'google_ics', false),
  ('2022-01-03', 'New Year''s Day (observed)', 'substitution', false),
  ('2022-04-15', 'Good Friday', 'google_ics', false),
  ('2022-04-18', 'Easter Monday', 'google_ics', false),
  ('2022-05-01', 'Workers'' Day', 'google_ics', false),
  ('2022-05-02', 'Eid El-Fitr', 'google_ics', false),
  ('2022-05-03', 'Eid El-Fitr Holiday', 'google_ics', false),
  ('2022-05-04', 'Workers'' Day (observed)', 'substitution', false),
  ('2022-06-12', 'Democracy Day', 'google_ics', false),
  ('2022-06-13', 'Democracy Day (observed)', 'substitution', false),
  ('2022-07-09', 'Id el Kabir', 'google_ics', false),
  ('2022-07-11', 'Id el Kabir Holiday', 'google_ics', false),
  ('2022-07-12', 'Id el Kabir (observed)', 'substitution', false),
  ('2022-10-01', 'Independence Day', 'google_ics', false),
  ('2022-10-03', 'Independence Day (observed)', 'substitution', false),
  ('2022-10-08', 'Id el Maulud', 'google_ics', false),
  ('2022-10-10', 'Id el Maulud (observed)', 'substitution', false),
  ('2022-12-25', 'Christmas Day', 'google_ics', false),
  ('2022-12-26', 'Boxing Day', 'google_ics', false),
  ('2022-12-27', 'Christmas Day (observed)', 'substitution', false),
  ('2023-01-01', 'New Year''s Day', 'google_ics', false),
  ('2023-01-02', 'New Year''s Day (observed)', 'substitution', false),
  ('2023-04-07', 'Good Friday', 'google_ics', false),
  ('2023-04-10', 'Easter Monday', 'google_ics', false),
  ('2023-04-21', 'Eid El-Fitr', 'google_ics', false),
  ('2023-04-24', 'Eid El-Fitr Holiday', 'google_ics', false),
  ('2023-05-01', 'Workers'' Day', 'google_ics', false),
  ('2023-06-12', 'Democracy Day', 'google_ics', false),
  ('2023-06-28', 'Id el Kabir', 'google_ics', false),
  ('2023-06-29', 'Id el Kabir Holiday', 'google_ics', false),
  ('2023-09-27', 'Id el Maulud', 'google_ics', false),
  ('2023-10-01', 'Independence Day', 'google_ics', false),
  ('2023-10-02', 'Independence Day (observed)', 'substitution', false),
  ('2023-12-25', 'Christmas Day', 'google_ics', false),
  ('2023-12-26', 'Boxing Day', 'google_ics', false),
  ('2024-01-01', 'New Year''s Day', 'google_ics', false),
  ('2024-03-29', 'Good Friday', 'google_ics', false),
  ('2024-04-01', 'Easter Monday', 'google_ics', false),
  ('2024-04-10', 'Eid El-Fitr', 'google_ics', false),
  ('2024-04-11', 'Eid El-Fitr Holiday', 'google_ics', false),
  ('2024-05-01', 'Workers'' Day', 'google_ics', false),
  ('2024-06-12', 'Democracy Day', 'google_ics', false),
  ('2024-06-16', 'Id el Kabir', 'google_ics', false),
  ('2024-06-17', 'Id el Kabir Holiday', 'google_ics', false),
  ('2024-06-18', 'Id el Kabir (observed)', 'substitution', false),
  ('2024-09-16', 'Id el Maulud', 'google_ics', false),
  ('2024-10-01', 'Independence Day', 'google_ics', false),
  ('2024-12-25', 'Christmas Day', 'google_ics', false),
  ('2024-12-26', 'Boxing Day', 'google_ics', false),
  ('2025-01-01', 'New Year''s Day', 'google_ics', false),
  ('2025-03-30', 'Eid El-Fitr', 'google_ics', false),
  ('2025-03-31', 'Eid El-Fitr Holiday', 'google_ics', false),
  ('2025-04-01', 'Eid El-Fitr Holiday', 'google_ics', false),
  ('2025-04-02', 'Eid El-Fitr (observed)', 'substitution', false),
  ('2025-04-18', 'Good Friday', 'google_ics', false),
  ('2025-04-21', 'Easter Monday', 'google_ics', false),
  ('2025-05-01', 'Workers'' Day', 'google_ics', false),
  ('2025-06-06', 'Id el Kabir', 'google_ics', false),
  ('2025-06-09', 'Id el Kabir Holiday', 'google_ics', false),
  ('2025-06-12', 'Democracy Day', 'google_ics', false),
  ('2025-07-15', 'Day of Mourning for President Muhammadu Buhari', 'google_ics', false),
  ('2025-09-05', 'Id el Maulud', 'google_ics', false),
  ('2025-10-01', 'Independence Day', 'google_ics', false),
  ('2025-12-25', 'Christmas Day', 'google_ics', false),
  ('2025-12-26', 'Boxing Day', 'google_ics', false),
  ('2026-01-01', 'New Year''s Day', 'google_ics', false),
  ('2026-03-19', 'Eid El-Fitr Holiday', 'google_ics', false),
  ('2026-03-20', 'Eid El-Fitr', 'google_ics', false),
  ('2026-04-03', 'Good Friday', 'google_ics', false),
  ('2026-04-06', 'Easter Monday', 'google_ics', false),
  ('2026-05-01', 'Workers'' Day', 'google_ics', false),
  ('2026-05-27', 'Id el Kabir', 'google_ics', false),
  ('2026-05-28', 'Id el Kabir Holiday', 'google_ics', false),
  ('2026-06-12', 'Democracy Day', 'google_ics', false),
  ('2026-08-25', 'Id el Maulud', 'google_ics', false),
  ('2026-10-01', 'Independence Day', 'google_ics', false),
  ('2026-12-25', 'Christmas Day', 'google_ics', false),
  ('2026-12-26', 'Boxing Day', 'google_ics', false),
  ('2026-12-28', 'Boxing Day (observed)', 'substitution', false),
  ('2027-01-01', 'New Year''s Day', 'google_ics', false),
  ('2027-03-10', 'Eid El-Fitr', 'google_ics', true),
  ('2027-03-11', 'Eid El-Fitr Holiday', 'google_ics', true),
  ('2027-03-26', 'Good Friday', 'google_ics', false),
  ('2027-03-29', 'Easter Monday', 'google_ics', false),
  ('2027-05-01', 'Workers'' Day', 'google_ics', false),
  ('2027-05-03', 'Workers'' Day (observed)', 'substitution', false),
  ('2027-05-17', 'Id el Kabir', 'google_ics', true),
  ('2027-05-18', 'Id el Kabir Holiday', 'google_ics', true),
  ('2027-06-12', 'Democracy Day', 'google_ics', false),
  ('2027-06-14', 'Democracy Day (observed)', 'substitution', false),
  ('2027-08-15', 'Id el Maulud', 'google_ics', true),
  ('2027-08-16', 'Id el Maulud (observed)', 'substitution', true),
  ('2027-10-01', 'Independence Day', 'google_ics', false),
  ('2027-12-25', 'Christmas Day', 'google_ics', false),
  ('2027-12-26', 'Boxing Day', 'google_ics', false),
  ('2027-12-27', 'Boxing Day (observed)', 'substitution', false),
  ('2028-01-01', 'New Year''s Day', 'google_ics', false),
  ('2028-01-03', 'New Year''s Day (observed)', 'substitution', false),
  ('2028-02-27', 'Eid El-Fitr', 'google_ics', true),
  ('2028-02-28', 'Eid El-Fitr Holiday', 'google_ics', true),
  ('2028-02-29', 'Eid El-Fitr (observed)', 'substitution', true),
  ('2028-04-14', 'Good Friday', 'google_ics', false),
  ('2028-04-17', 'Easter Monday', 'google_ics', false),
  ('2028-05-01', 'Workers'' Day', 'google_ics', false),
  ('2028-05-06', 'Id el Kabir', 'google_ics', true),
  ('2028-05-07', 'Id el Kabir Holiday', 'google_ics', true),
  ('2028-05-08', 'Id el Kabir Holiday (observed)', 'substitution', true),
  ('2028-06-12', 'Democracy Day', 'google_ics', false),
  ('2028-08-03', 'Id el Maulud', 'google_ics', true),
  ('2028-10-01', 'Independence Day', 'google_ics', false),
  ('2028-10-02', 'Independence Day (observed)', 'substitution', false),
  ('2028-12-25', 'Christmas Day', 'google_ics', false),
  ('2028-12-26', 'Boxing Day', 'google_ics', false),
  ('2029-01-01', 'New Year''s Day', 'google_ics', false),
  ('2029-02-15', 'Eid El-Fitr', 'google_ics', true),
  ('2029-02-16', 'Eid El-Fitr Holiday', 'google_ics', true),
  ('2029-03-30', 'Good Friday', 'google_ics', false),
  ('2029-04-02', 'Easter Monday', 'google_ics', false),
  ('2029-04-25', 'Id el Kabir', 'google_ics', true),
  ('2029-04-26', 'Id el Kabir Holiday', 'google_ics', true),
  ('2029-05-01', 'Workers'' Day', 'google_ics', false),
  ('2029-06-12', 'Democracy Day', 'google_ics', false),
  ('2029-07-24', 'Id el Maulud', 'google_ics', true),
  ('2029-10-01', 'Independence Day', 'google_ics', false),
  ('2029-12-25', 'Christmas Day', 'google_ics', false),
  ('2029-12-26', 'Boxing Day', 'google_ics', false),
  ('2030-01-01', 'New Year''s Day', 'google_ics', false),
  ('2030-02-05', 'Eid El-Fitr', 'google_ics', true),
  ('2030-02-06', 'Eid El-Fitr Holiday', 'google_ics', true),
  ('2030-04-14', 'Id el Kabir', 'google_ics', true),
  ('2030-04-15', 'Id el Kabir Holiday', 'google_ics', true),
  ('2030-04-16', 'Id el Kabir (observed)', 'substitution', true),
  ('2030-04-19', 'Good Friday', 'google_ics', false),
  ('2030-04-22', 'Easter Monday', 'google_ics', false),
  ('2030-05-01', 'Workers'' Day', 'google_ics', false),
  ('2030-06-12', 'Democracy Day', 'google_ics', false),
  ('2030-07-13', 'Id el Maulud', 'google_ics', true),
  ('2030-07-15', 'Id el Maulud (observed)', 'substitution', true),
  ('2030-10-01', 'Independence Day', 'google_ics', false),
  ('2030-12-25', 'Christmas Day', 'google_ics', false),
  ('2030-12-26', 'Boxing Day', 'google_ics', false),
  ('2031-01-01', 'New Year''s Day', 'google_ics', false),
  ('2031-01-25', 'Eid El-Fitr', 'google_ics', true),
  ('2031-01-26', 'Eid El-Fitr Holiday', 'google_ics', true),
  ('2031-01-27', 'Eid El-Fitr Holiday (observed)', 'substitution', true),
  ('2031-04-03', 'Id el Kabir', 'google_ics', true),
  ('2031-04-04', 'Id el Kabir Holiday', 'google_ics', true),
  ('2031-04-11', 'Good Friday', 'google_ics', false),
  ('2031-04-14', 'Easter Monday', 'google_ics', false),
  ('2031-05-01', 'Workers'' Day', 'google_ics', false),
  ('2031-06-12', 'Democracy Day', 'google_ics', false),
  ('2031-07-02', 'Id el Maulud', 'google_ics', true),
  ('2031-10-01', 'Independence Day', 'google_ics', false),
  ('2031-12-25', 'Christmas Day', 'google_ics', false),
  ('2031-12-26', 'Boxing Day', 'google_ics', false),
  ('2032-01-01', 'New Year''s Day', 'arithmetic', false),
  ('2032-03-26', 'Good Friday', 'arithmetic', false),
  ('2032-03-29', 'Easter Monday', 'arithmetic', false),
  ('2032-05-01', 'Workers'' Day', 'arithmetic', false),
  ('2032-05-03', 'Workers'' Day (observed)', 'substitution', false),
  ('2032-06-12', 'Democracy Day', 'arithmetic', false),
  ('2032-06-14', 'Democracy Day (observed)', 'substitution', false),
  ('2032-10-01', 'Independence Day', 'arithmetic', false),
  ('2032-12-25', 'Christmas Day', 'arithmetic', false),
  ('2032-12-26', 'Boxing Day', 'arithmetic', false),
  ('2032-12-27', 'Boxing Day (observed)', 'substitution', false),
  ('2033-01-01', 'New Year''s Day', 'arithmetic', false),
  ('2033-01-03', 'New Year''s Day (observed)', 'substitution', false),
  ('2033-04-15', 'Good Friday', 'arithmetic', false),
  ('2033-04-18', 'Easter Monday', 'arithmetic', false),
  ('2033-05-01', 'Workers'' Day', 'arithmetic', false),
  ('2033-05-02', 'Workers'' Day (observed)', 'substitution', false),
  ('2033-06-12', 'Democracy Day', 'arithmetic', false),
  ('2033-06-13', 'Democracy Day (observed)', 'substitution', false),
  ('2033-10-01', 'Independence Day', 'arithmetic', false),
  ('2033-10-03', 'Independence Day (observed)', 'substitution', false),
  ('2033-12-25', 'Christmas Day', 'arithmetic', false),
  ('2033-12-26', 'Boxing Day', 'arithmetic', false),
  ('2033-12-27', 'Christmas Day (observed)', 'substitution', false),
  ('2034-01-01', 'New Year''s Day', 'arithmetic', false),
  ('2034-01-02', 'New Year''s Day (observed)', 'substitution', false),
  ('2034-04-07', 'Good Friday', 'arithmetic', false),
  ('2034-04-10', 'Easter Monday', 'arithmetic', false),
  ('2034-05-01', 'Workers'' Day', 'arithmetic', false),
  ('2034-06-12', 'Democracy Day', 'arithmetic', false),
  ('2034-10-01', 'Independence Day', 'arithmetic', false),
  ('2034-10-02', 'Independence Day (observed)', 'substitution', false),
  ('2034-12-25', 'Christmas Day', 'arithmetic', false),
  ('2034-12-26', 'Boxing Day', 'arithmetic', false),
  ('2035-01-01', 'New Year''s Day', 'arithmetic', false),
  ('2035-03-23', 'Good Friday', 'arithmetic', false),
  ('2035-03-26', 'Easter Monday', 'arithmetic', false),
  ('2035-05-01', 'Workers'' Day', 'arithmetic', false),
  ('2035-06-12', 'Democracy Day', 'arithmetic', false),
  ('2035-10-01', 'Independence Day', 'arithmetic', false),
  ('2035-12-25', 'Christmas Day', 'arithmetic', false),
  ('2035-12-26', 'Boxing Day', 'arithmetic', false),
  ('2036-01-01', 'New Year''s Day', 'arithmetic', false),
  ('2036-04-11', 'Good Friday', 'arithmetic', false),
  ('2036-04-14', 'Easter Monday', 'arithmetic', false),
  ('2036-05-01', 'Workers'' Day', 'arithmetic', false),
  ('2036-06-12', 'Democracy Day', 'arithmetic', false),
  ('2036-10-01', 'Independence Day', 'arithmetic', false),
  ('2036-12-25', 'Christmas Day', 'arithmetic', false),
  ('2036-12-26', 'Boxing Day', 'arithmetic', false),
  ('2037-01-01', 'New Year''s Day', 'arithmetic', false),
  ('2037-04-03', 'Good Friday', 'arithmetic', false),
  ('2037-04-06', 'Easter Monday', 'arithmetic', false),
  ('2037-05-01', 'Workers'' Day', 'arithmetic', false),
  ('2037-06-12', 'Democracy Day', 'arithmetic', false),
  ('2037-10-01', 'Independence Day', 'arithmetic', false),
  ('2037-12-25', 'Christmas Day', 'arithmetic', false),
  ('2037-12-26', 'Boxing Day', 'arithmetic', false),
  ('2037-12-28', 'Boxing Day (observed)', 'substitution', false),
  ('2038-01-01', 'New Year''s Day', 'arithmetic', false),
  ('2038-04-23', 'Good Friday', 'arithmetic', false),
  ('2038-04-26', 'Easter Monday', 'arithmetic', false),
  ('2038-05-01', 'Workers'' Day', 'arithmetic', false),
  ('2038-05-03', 'Workers'' Day (observed)', 'substitution', false),
  ('2038-06-12', 'Democracy Day', 'arithmetic', false),
  ('2038-06-14', 'Democracy Day (observed)', 'substitution', false),
  ('2038-10-01', 'Independence Day', 'arithmetic', false),
  ('2038-12-25', 'Christmas Day', 'arithmetic', false),
  ('2038-12-26', 'Boxing Day', 'arithmetic', false),
  ('2038-12-27', 'Boxing Day (observed)', 'substitution', false),
  ('2039-01-01', 'New Year''s Day', 'arithmetic', false),
  ('2039-01-03', 'New Year''s Day (observed)', 'substitution', false),
  ('2039-04-08', 'Good Friday', 'arithmetic', false),
  ('2039-04-11', 'Easter Monday', 'arithmetic', false),
  ('2039-05-01', 'Workers'' Day', 'arithmetic', false),
  ('2039-05-02', 'Workers'' Day (observed)', 'substitution', false),
  ('2039-06-12', 'Democracy Day', 'arithmetic', false),
  ('2039-06-13', 'Democracy Day (observed)', 'substitution', false),
  ('2039-10-01', 'Independence Day', 'arithmetic', false),
  ('2039-10-03', 'Independence Day (observed)', 'substitution', false),
  ('2039-12-25', 'Christmas Day', 'arithmetic', false),
  ('2039-12-26', 'Boxing Day', 'arithmetic', false),
  ('2039-12-27', 'Christmas Day (observed)', 'substitution', false),
  ('2040-01-01', 'New Year''s Day', 'arithmetic', false),
  ('2040-01-02', 'New Year''s Day (observed)', 'substitution', false),
  ('2040-03-30', 'Good Friday', 'arithmetic', false),
  ('2040-04-02', 'Easter Monday', 'arithmetic', false),
  ('2040-05-01', 'Workers'' Day', 'arithmetic', false),
  ('2040-06-12', 'Democracy Day', 'arithmetic', false),
  ('2040-10-01', 'Independence Day', 'arithmetic', false),
  ('2040-12-25', 'Christmas Day', 'arithmetic', false),
  ('2040-12-26', 'Boxing Day', 'arithmetic', false)

ON CONFLICT (date) DO UPDATE
  SET name         = EXCLUDED.name,
      source       = EXCLUDED.source,
      is_estimated = EXCLUDED.is_estimated
  WHERE app.public_holidays.source <> 'manual';

/* ── Coverage, so a gap is visible rather than assumed away ─────────────────── */
-- The Islamic holidays are the ones that go missing, because they are the ones no
-- rule can generate. This view answers "is the clock trustworthy for this year" in
-- one row per year, and the Staff Performance page can read it rather than presenting
-- every duration as exact.

CREATE OR REPLACE VIEW app.v_holiday_coverage AS
SELECT EXTRACT(YEAR FROM h.date)::int                                      AS yr,
       COUNT(*)                                                            AS holidays,
       COUNT(*) FILTER (WHERE h.is_estimated)                              AS estimated,
       COUNT(*) FILTER (WHERE h.name ILIKE 'Eid%' OR h.name ILIKE 'Id el%') AS islamic,
       COUNT(*) FILTER (WHERE EXTRACT(ISODOW FROM h.date) <= 5)            AS on_a_weekday
  FROM app.public_holidays h
 GROUP BY 1
 ORDER BY 1;

COMMENT ON VIEW app.v_holiday_coverage IS
  'One row per year: how many holidays are recorded, how many are unconfirmed lunar '
  'estimates, and how many are Islamic. islamic = 0 means the year is missing five '
  'work-free days and every duration measured in it is overstated.';

/* ── Adding a holiday now applies it ───────────────────────────────────────── */
-- Created AFTER the insert above so the bulk load does not rebuild once per row, and
-- the rebuild below does it exactly once.

CREATE OR REPLACE FUNCTION app.public_holidays_rebuild_calendar()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM app.rebuild_business_calendar();
  RETURN NULL;
END $$;

COMMENT ON FUNCTION app.public_holidays_rebuild_calendar() IS
  'Statement-level: app.business_calendar is materialised, so a holiday change is '
  'inert until it is rebuilt. Before this trigger nothing said so.';

DROP TRIGGER IF EXISTS trg_public_holidays_rebuild ON app.public_holidays;
CREATE TRIGGER trg_public_holidays_rebuild
  AFTER INSERT OR UPDATE OR DELETE ON app.public_holidays
  FOR EACH STATEMENT EXECUTE FUNCTION app.public_holidays_rebuild_calendar();

DROP TRIGGER IF EXISTS trg_business_hours_rebuild ON app.business_hours;
CREATE TRIGGER trg_business_hours_rebuild
  AFTER INSERT OR UPDATE OR DELETE ON app.business_hours
  FOR EACH STATEMENT EXECUTE FUNCTION app.public_holidays_rebuild_calendar();

/* ── Apply it, and refuse to land if it did not work ───────────────────────── */

SELECT app.rebuild_business_calendar();

DO $$
DECLARE
  v_islamic_2026 int;
  v_open_on_eid  int;
  v_years_blank  int;
  v_2026_working int;
BEGIN
  -- The five 2026 Islamic holidays must be present, since they are the ones that
  -- affect every figure on the Staff Performance page today.
  SELECT COUNT(*) INTO v_islamic_2026
    FROM app.public_holidays
   WHERE date BETWEEN '2026-01-01' AND '2026-12-31'
     AND (name ILIKE 'Eid%' OR name ILIKE 'Id el%');
  IF v_islamic_2026 < 5 THEN
    RAISE EXCEPTION 'expected at least 5 Islamic holidays in 2026, found %', v_islamic_2026;
  END IF;

  -- And the calendar must now be shut on them. This is the assertion that would have
  -- caught the original bug: rows in public_holidays that business_calendar ignores.
  SELECT COUNT(*) INTO v_open_on_eid
    FROM app.public_holidays h
    JOIN app.business_calendar c ON c.d = h.date
   WHERE (h.name ILIKE 'Eid%' OR h.name ILIKE 'Id el%')
     AND c.open_minutes > 0;
  IF v_open_on_eid > 0 THEN
    RAISE EXCEPTION '% Islamic holiday(s) are still open in business_calendar', v_open_on_eid;
  END IF;

  -- No year inside the calendar may be left with no holidays at all.
  SELECT COUNT(*) INTO v_years_blank
    FROM (SELECT EXTRACT(YEAR FROM d)::int AS yr FROM app.business_calendar GROUP BY 1) y
   WHERE NOT EXISTS (SELECT 1 FROM app.public_holidays h
                      WHERE EXTRACT(YEAR FROM h.date)::int = y.yr);
  IF v_years_blank > 0 THEN
    RAISE EXCEPTION '% year(s) in business_calendar still have no holidays', v_years_blank;
  END IF;

  -- Sanity in the other direction: 2026 must still have a plausible number of
  -- working days. A bad substitution rule or a runaway allow-list would show up here
  -- rather than as a quietly shorter year.
  SELECT COUNT(*) INTO v_2026_working
    FROM app.business_calendar
   WHERE d BETWEEN '2026-01-01' AND '2026-12-31' AND open_minutes > 0;
  IF v_2026_working < 240 OR v_2026_working > 256 THEN
    RAISE EXCEPTION '2026 has % working days, which is outside the plausible 240-256', v_2026_working;
  END IF;

  RAISE NOTICE 'holidays applied: 2026 has % Islamic holiday(s) and % working days',
    v_islamic_2026, v_2026_working;
END $$;

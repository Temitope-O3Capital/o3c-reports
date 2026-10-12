-- A clock that only runs during working hours.
--
-- Staff performance is about to be measured, and every measure of it is a duration:
-- how long to first response, how long to resolve, how long something sat in a queue.
-- Measured on a calendar clock, those numbers mostly report when work ARRIVED rather
-- than how fast anyone was. A complaint raised at 17:05 on a Friday accrues 63 hours
-- before anybody could legitimately have looked at it.
--
-- That is not hypothetical here. app.helpdesk_set_sla_from_type sets
--   sla_due_at := created_at + INTERVAL 'N hours'
-- on 40,782 tickets, so nights, weekends and public holidays already count in full
-- against whoever was on duty.
--
-- This migration adds the clock and CHANGES NO EXISTING FIGURE. The live SLA trigger
-- is deliberately left exactly as it is: switching it would silently restate the
-- breach status of 29,240 resolved tickets, which is a decision about how people are
-- judged, not a migration. The clock is here so business-hours duration can be
-- reported ALONGSIDE the calendar one and the difference can be seen before anybody
-- commits to it.

/* ── When the business is open ───────────────────────────────────────────────── */

-- Configuration, not a constant. Working hours are a policy that changes, and a
-- hardcoded 08:00-17:00 would need a deploy to correct.
CREATE TABLE IF NOT EXISTS app.business_hours (
  day_of_week smallint PRIMARY KEY,   -- ISO: 1 = Monday .. 7 = Sunday
  opens       time        NOT NULL,
  closes      time        NOT NULL,
  CONSTRAINT business_hours_dow   CHECK (day_of_week BETWEEN 1 AND 7),
  CONSTRAINT business_hours_order CHECK (closes > opens)
);

-- Monday to Friday, 08:00-17:00. A day with no row is simply not a working day,
-- which is why Saturday and Sunday are absent rather than present-and-zero.
INSERT INTO app.business_hours (day_of_week, opens, closes) VALUES
  (1, '08:00', '17:00'),
  (2, '08:00', '17:00'),
  (3, '08:00', '17:00'),
  (4, '08:00', '17:00'),
  (5, '08:00', '17:00')
ON CONFLICT (day_of_week) DO NOTHING;

COMMENT ON TABLE app.business_hours IS
  'Working hours by ISO day of week. A day with no row is not a working day. Edit this rather than any query that depends on it.';

/* ── Public holidays ────────────────────────────────────────────────────────── */

-- The table has existed since migration 001 and has never held a row, so nothing
-- that should have excluded a holiday ever did. It also had no uniqueness on the
-- date, which would let the same holiday be entered twice and silently double-count.
DELETE FROM app.public_holidays a
 USING app.public_holidays b
 WHERE a.date = b.date AND a.id > b.id;

CREATE UNIQUE INDEX IF NOT EXISTS uq_public_holidays_date ON app.public_holidays (date);

-- Nigerian federal holidays whose dates are CERTAIN: the fixed ones, plus the two
-- Easter-derived ones computed from known Easter Sundays.
--
-- The Islamic holidays -- Eid al-Fitr, Eid al-Adha and Eid al-Mawlid -- are
-- deliberately NOT seeded. They follow the lunar calendar, each year's dates are
-- declared by the federal government close to the day, and they frequently shift by
-- a day from any published projection. Guessing them would put wrong dates into the
-- one table every duration in the platform is about to depend on. They must be added
-- as they are declared; until then those days count as working days, which makes
-- performance look slightly WORSE than it was rather than flattering it.
INSERT INTO app.public_holidays (name, date)
SELECT v.name, v.d::date FROM (VALUES
  ('New Year''s Day',   '2024-01-01'), ('Workers'' Day',     '2024-05-01'),
  ('Democracy Day',     '2024-06-12'), ('Independence Day',  '2024-10-01'),
  ('Christmas Day',     '2024-12-25'), ('Boxing Day',        '2024-12-26'),
  ('Good Friday',       '2024-03-29'), ('Easter Monday',     '2024-04-01'),

  ('New Year''s Day',   '2025-01-01'), ('Workers'' Day',     '2025-05-01'),
  ('Democracy Day',     '2025-06-12'), ('Independence Day',  '2025-10-01'),
  ('Christmas Day',     '2025-12-25'), ('Boxing Day',        '2025-12-26'),
  ('Good Friday',       '2025-04-18'), ('Easter Monday',     '2025-04-21'),

  ('New Year''s Day',   '2026-01-01'), ('Workers'' Day',     '2026-05-01'),
  ('Democracy Day',     '2026-06-12'), ('Independence Day',  '2026-10-01'),
  ('Christmas Day',     '2026-12-25'), ('Boxing Day',        '2026-12-26'),
  ('Good Friday',       '2026-04-03'), ('Easter Monday',     '2026-04-06'),

  ('New Year''s Day',   '2027-01-01'), ('Workers'' Day',     '2027-05-01'),
  ('Democracy Day',     '2027-06-12'), ('Independence Day',  '2027-10-01'),
  ('Christmas Day',     '2027-12-25'), ('Boxing Day',        '2027-12-26'),
  ('Good Friday',       '2027-03-26'), ('Easter Monday',     '2027-03-29')
) AS v(name, d)
ON CONFLICT (date) DO NOTHING;

COMMENT ON TABLE app.public_holidays IS
  'Non-working days. Seeded with the fixed and Easter-derived Nigerian federal holidays for 2024-2027. The Islamic holidays are NOT seeded because their dates are declared close to the day; add each as it is announced.';

/* ── The clock ──────────────────────────────────────────────────────────────── */

-- Minutes of WORKING time between two instants.
--
-- Set-based rather than a day loop, because it is meant to be called across tens of
-- thousands of rows in one query, not once per page view.
--
-- Times are resolved in Africa/Lagos: the business opens at 08:00 local, and reading
-- the window in UTC would shift every boundary by an hour.
--
-- Returns 0 -- never NULL -- for a null argument or a backwards range, so a caller
-- summing it cannot be silently poisoned by one bad row.
CREATE OR REPLACE FUNCTION app.business_minutes(p_from timestamptz, p_to timestamptz)
RETURNS numeric AS $$
  SELECT COALESCE(ROUND(SUM(
           EXTRACT(EPOCH FROM (
               LEAST(p_to,    (g.d::date + b.closes) AT TIME ZONE 'Africa/Lagos')
             - GREATEST(p_from, (g.d::date + b.opens)  AT TIME ZONE 'Africa/Lagos')
           )) / 60.0
         ), 2), 0)
    FROM generate_series(
           (p_from AT TIME ZONE 'Africa/Lagos')::date,
           (p_to   AT TIME ZONE 'Africa/Lagos')::date,
           INTERVAL '1 day') AS g(d)
    JOIN app.business_hours b
      ON b.day_of_week = EXTRACT(ISODOW FROM g.d)::smallint
   WHERE NOT EXISTS (SELECT 1 FROM app.public_holidays h WHERE h.date = g.d::date)
     AND LEAST(p_to,      (g.d::date + b.closes) AT TIME ZONE 'Africa/Lagos')
       > GREATEST(p_from, (g.d::date + b.opens)  AT TIME ZONE 'Africa/Lagos');
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION app.business_minutes(timestamptz, timestamptz) IS
  'Working minutes between two instants, excluding nights, non-working days and public holidays. Africa/Lagos. Returns 0 for null or backwards input.';

-- The same thing in hours, because every SLA in the platform is expressed in hours
-- and a caller dividing by 60 by hand will eventually forget.
CREATE OR REPLACE FUNCTION app.business_hours_between(p_from timestamptz, p_to timestamptz)
RETURNS numeric AS $$
  SELECT ROUND(app.business_minutes(p_from, p_to) / 60.0, 2);
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION app.business_hours_between(timestamptz, timestamptz) IS
  'app.business_minutes expressed in hours, to match SLA policies which are all stated in hours.';

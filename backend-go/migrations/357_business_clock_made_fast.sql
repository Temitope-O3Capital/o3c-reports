-- Make the business-hours clock fast enough to put on a page.
--
-- Migration 355 shipped app.business_minutes as a generate_series over the days a
-- span touches. Correct, and fine for one call, but the staff performance module
-- calls it once per work item: the per-person helpdesk query over 90 days took
-- **6.6 seconds**, because each long-running ticket walked a series of ~90 days.
-- A page that takes six seconds to answer "who is fast" does not get opened twice.
--
-- The fix is the standard one for interval arithmetic on a calendar: precompute
-- cumulative working minutes per day, so a span becomes a subtraction of two
-- cumulative values plus the part-days at each end.
--
-- The window itself is stored ON the day rather than looked up, which is what makes
-- each call a single indexed row read with no subquery and no join. That is sound
-- because app.business_hours has day_of_week as its PRIMARY KEY, so a day has at
-- most one open/close window by construction -- split shifts would need a different
-- shape here, and the primary key is what guarantees they cannot appear unnoticed.
--
-- THE DEFINITION DOES NOT CHANGE. The function keeps its name and signature, so no
-- caller is touched, and the new body is asserted below to agree with the old one on
-- every resolved ticket. If it ever disagreed this migration fails, rather than
-- silently restating every duration in the platform.

/* ── The calendar ───────────────────────────────────────────────────────────── */

DROP TABLE IF EXISTS app.business_calendar;

CREATE TABLE app.business_calendar (
  d            date   PRIMARY KEY,
  -- NULL on a non-working day: a weekend, or a public holiday.
  opens        time,
  closes       time,
  open_minutes int    NOT NULL,   -- working minutes ON this day
  -- Working minutes BEFORE this day, from the start of the calendar. The running
  -- total is what turns a span into a subtraction.
  cum_minutes  bigint NOT NULL
);

COMMENT ON TABLE app.business_calendar IS
  'Per-day working window, its minutes, and their running total. Derived from app.business_hours and app.public_holidays — never hand-edited. Rebuild with app.rebuild_business_calendar() after changing either.';

-- Rebuilt wholesale because it is small and because a partial rebuild after a
-- holiday is added part-way through would leave the running total wrong from that
-- day onwards — the kind of error that reads as perfectly plausible.
--
-- The range starts well before any data the platform holds (tickets begin 2025) so a
-- timestamp can never fall off the front of the calendar and silently measure zero.
CREATE OR REPLACE FUNCTION app.rebuild_business_calendar(
  p_from date DEFAULT '2015-01-01',
  p_to   date DEFAULT '2040-12-31'
) RETURNS bigint AS $$
DECLARE
  n bigint;
BEGIN
  DELETE FROM app.business_calendar;

  INSERT INTO app.business_calendar (d, opens, closes, open_minutes, cum_minutes)
  SELECT g.d::date, w.opens, w.closes,
         COALESCE(w.mins, 0),
         COALESCE(SUM(COALESCE(w.mins, 0)) OVER (ORDER BY g.d
                   ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)
    FROM generate_series(p_from, p_to, INTERVAL '1 day') AS g(d)
    LEFT JOIN LATERAL (
         SELECT b.opens, b.closes,
                (EXTRACT(EPOCH FROM (b.closes - b.opens)) / 60.0)::int AS mins
           FROM app.business_hours b
          WHERE b.day_of_week = EXTRACT(ISODOW FROM g.d)::smallint
            AND NOT EXISTS (SELECT 1 FROM app.public_holidays h WHERE h.date = g.d::date)
    ) w ON true;

  SELECT COUNT(*) INTO n FROM app.business_calendar;
  RETURN n;
END $$ LANGUAGE plpgsql;

COMMENT ON FUNCTION app.rebuild_business_calendar(date, date) IS
  'Rebuilds app.business_calendar from app.business_hours and app.public_holidays. Run after editing either, or the clock keeps answering from the old policy.';

SELECT app.rebuild_business_calendar();

/* ── The clock, rewritten ───────────────────────────────────────────────────── */

-- Cumulative working minutes up to an instant: every whole day before it, plus the
-- part of its own day already worked. One indexed row read and arithmetic.
CREATE OR REPLACE FUNCTION app.business_cum(p_at timestamptz)
RETURNS numeric AS $$
  SELECT bc.cum_minutes
       + CASE
           WHEN bc.opens IS NULL THEN 0
           ELSE LEAST(
                  GREATEST(
                    EXTRACT(EPOCH FROM (
                      p_at - ((bc.d + bc.opens) AT TIME ZONE 'Africa/Lagos')
                    )) / 60.0,
                    0),
                  bc.open_minutes)
         END
    FROM app.business_calendar bc
   WHERE bc.d = (p_at AT TIME ZONE 'Africa/Lagos')::date;
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION app.business_cum(timestamptz) IS
  'Cumulative working minutes to an instant, from the start of app.business_calendar. The building block of app.business_minutes; not usually called directly.';

-- Same name, same signature, same answer.
--
-- GREATEST(0, ...) keeps the backwards-range contract from 355, and COALESCE keeps
-- the "0, never NULL" one, so a caller summing this cannot be poisoned by one bad
-- row or by a timestamp outside the calendar.
CREATE OR REPLACE FUNCTION app.business_minutes(p_from timestamptz, p_to timestamptz)
RETURNS numeric AS $$
  SELECT COALESCE(ROUND(GREATEST(0, app.business_cum(p_to) - app.business_cum(p_from)), 2), 0);
$$ LANGUAGE sql STABLE;

/* ── Prove it agrees with the implementation it replaces ────────────────────── */

-- The 355 body, kept only long enough to assert equivalence, then dropped. Replacing
-- the definition of every duration in the platform on the strength of "it looked
-- right" is not good enough.
CREATE OR REPLACE FUNCTION app.business_minutes_v355(p_from timestamptz, p_to timestamptz)
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

DO $$
DECLARE
  bad bigint;
  worst numeric;
BEGIN
  -- Every resolved ticket carrying both timestamps: the actual population the
  -- performance module measures, not a synthetic sample.
  SELECT COUNT(*), COALESCE(MAX(ABS(a - b)), 0) INTO bad, worst
    FROM (
      SELECT app.business_minutes(created_at, resolved_at)      AS a,
             app.business_minutes_v355(created_at, resolved_at) AS b
        FROM app.helpdesk_tickets
       WHERE resolved_at IS NOT NULL AND created_at IS NOT NULL
    ) q
   WHERE ABS(a - b) > 0.01;

  IF bad > 0 THEN
    RAISE EXCEPTION
      'business_minutes rewrite disagrees with the 355 implementation on % row(s), worst gap % minutes — not replacing the definition of every duration in the platform on a maybe',
      bad, worst;
  END IF;

  RAISE NOTICE 'business_minutes rewrite agrees with 355 on every resolved ticket (worst gap % minutes)', worst;
END $$;

DROP FUNCTION app.business_minutes_v355(timestamptz, timestamptz);

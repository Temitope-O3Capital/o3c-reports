-- 307 — An officer's day, on the record, and a way for their head to read it.
--
-- WHAT THIS IS FOR. A sales officer spends the day out: they visit an employer, call a
-- prospect, sit with a customer at a branch. None of it is recorded anywhere. The only
-- trace a day leaves in the workspace is whatever happened to a LEAD — so an officer who
-- spent the day on four employer visits that produced no lead that afternoon shows up as
-- having done nothing, and their head has no way to know otherwise.
--
-- Two separate things are needed and they are deliberately not the same table:
--
--   1. THE INDIVIDUAL ACTIVITIES — where they went, who they called, what happened.
--      These go into app.activities, which already exists and already carries 30,150
--      contact-linked records from every team. A new table would have split the lead's
--      history in half: the Leads timeline reads app.activities, so an officer's call
--      logged anywhere else would not appear on the lead it was about. Sales activity
--      uses actor_team='sales' with type in ('visit','call','meeting','note'), and the
--      `type` column has no CHECK constraint so this needs no widening.
--
--   2. THE DAILY REPORT — one per officer per day, submitted at the end of it.
--      This is NOT derivable from the activities. "I logged six calls" and "I am done
--      for the day and here is what I make of it" are different statements, and the
--      supervisor calendar needs the second: a day with five activities and no report is
--      a day still in progress, and a day with a report and no activities is an honest
--      "nothing landed today", which is information. Hence its own table, and hence
--      submitted_at rather than inferring submission from a row existing.
--
-- WHY NOT REUSE crm_lead_events: those hang off a contact_id and describe a LEAD's
-- history. A visit to an employer who is not yet a lead has no contact to hang from, and
-- that is exactly the work that currently vanishes.

-- ---------------------------------------------------------------------------
-- The daily report.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS app.sales_daily_reports (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    officer_id    bigint      NOT NULL REFERENCES app.o3c_users(id) ON DELETE CASCADE,
    report_date   date        NOT NULL,
    -- What they did, and what is next. Free text on purpose: the structure that matters
    -- is already in the activities; this is the officer's own account of the day.
    summary       text        NOT NULL DEFAULT '',
    plan          text        NOT NULL DEFAULT '',
    -- NULL while a draft is being written; set when the officer submits. The supervisor
    -- calendar keys its green mark on this being non-NULL, not on the row existing, so
    -- starting to type does not tell a head you are finished.
    submitted_at  timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    -- One report per officer per day. Without this, a double-submit produces two reports
    -- for one day and the calendar cannot say which is the day's account.
    CONSTRAINT uq_sales_daily_report UNIQUE (officer_id, report_date)
);

COMMENT ON TABLE app.sales_daily_reports IS
  'One end-of-day report per sales officer per day. Distinct from app.activities, which '
  'holds the individual calls and visits: this is the officer''s own account of the day '
  'and the thing a supervisor''s calendar marks as submitted or not.';

-- The two reads: a head opening the calendar for a month, and an officer opening today.
CREATE INDEX IF NOT EXISTS idx_sales_daily_reports_date
    ON app.sales_daily_reports (report_date DESC, officer_id);

-- A report cannot be dated in the future. Submitting tomorrow's day is either a typo or
-- someone pre-filling a day they have not worked.
ALTER TABLE app.sales_daily_reports
    DROP CONSTRAINT IF EXISTS sales_daily_reports_not_future;
ALTER TABLE app.sales_daily_reports
    ADD CONSTRAINT sales_daily_reports_not_future
    CHECK (report_date <= (now() AT TIME ZONE 'Africa/Lagos')::date + 1);

-- ---------------------------------------------------------------------------
-- Supporting index on the activity stream.
--
-- The supervisor view asks "what did each of my officers do on each day of this month?",
-- which is a scan over actor_user_id + occurred_at. app.activities has 32,949 rows today
-- and grows with every call the call centre makes, so the monthly grid needs this or it
-- sequentially scans the whole stream every time a head opens the page.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_activities_actor_day
    ON app.activities (actor_user_id, occurred_at DESC)
    WHERE actor_user_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- The calendar's source. One row per officer per day they did anything, carrying both
-- halves: what they logged, and whether they signed the day off.
--
-- FULL OUTER JOIN, not an inner or left join off either side: a day can have activities
-- and no report (still working, or forgot), or a report and no activities (an honest
-- quiet day). Both are real and the calendar must show both — joining from one side
-- would silently drop the other kind.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW app.v_sales_officer_days AS
WITH acts AS (
    SELECT a.actor_user_id                                   AS officer_id,
           (a.occurred_at AT TIME ZONE 'Africa/Lagos')::date AS day,
           count(*)                                          AS activities,
           count(*) FILTER (WHERE a.type = 'visit')           AS visits,
           count(*) FILTER (WHERE a.type = 'call')            AS calls,
           count(*) FILTER (WHERE a.type = 'meeting')         AS meetings,
           count(*) FILTER (WHERE a.type = 'note')            AS notes,
           count(DISTINCT a.contact_id) FILTER (WHERE a.contact_id IS NOT NULL) AS contacts_touched,
           max(a.occurred_at)                                 AS last_activity_at
      FROM app.activities a
     WHERE a.actor_user_id IS NOT NULL
       AND COALESCE(a.actor_team, '') = 'sales'
       -- All three conditions are load-bearing, and this was measured before being
       -- written this way. actor_team='sales' ALONE selects 7,411 rows — every one a
       -- machine-written stage_change with source='crm_lead', and every one authored by
       -- one of six CALL-CENTRE agents, because advancing a lead's sales stage from a
       -- call is tagged as a sales-team event. Filtered on the team alone, this view
       -- showed a head a calendar of call-centre agents logging 1,500 "activities" a day
       -- and not one real sales officer.
       --
       -- So: the four types an officer can actually log, and only where a person logged
       -- one by hand. Machine events keep their place on the lead's timeline, where they
       -- belong — they are not somebody's working day.
       AND a.type IN ('visit', 'call', 'meeting', 'note')
       AND a.source = 'manual'
     GROUP BY 1, 2
)
SELECT COALESCE(acts.officer_id, r.officer_id)      AS officer_id,
       COALESCE(acts.day, r.report_date)            AS day,
       COALESCE(acts.activities, 0)                 AS activities,
       COALESCE(acts.visits, 0)                     AS visits,
       COALESCE(acts.calls, 0)                      AS calls,
       COALESCE(acts.meetings, 0)                   AS meetings,
       COALESCE(acts.notes, 0)                      AS notes,
       COALESCE(acts.contacts_touched, 0)           AS contacts_touched,
       acts.last_activity_at,
       r.id                                         AS report_id,
       r.submitted_at,
       (r.submitted_at IS NOT NULL)                 AS report_submitted,
       r.summary,
       r.plan
  FROM acts
  FULL OUTER JOIN app.sales_daily_reports r
    ON r.officer_id = acts.officer_id AND r.report_date = acts.day;

COMMENT ON VIEW app.v_sales_officer_days IS
  'One row per sales officer per day on which they logged activity or filed a report. '
  'FULL OUTER JOIN on purpose: a day with activity and no report (still working) and a '
  'day with a report and no activity (a quiet day, honestly reported) are both real.';

-- ---------------------------------------------------------------------------
-- Guards.
-- ---------------------------------------------------------------------------

DO $m307$
DECLARE
    v_cols bigint;
    v_rows bigint;
BEGIN
    SELECT count(*) INTO v_cols
      FROM information_schema.columns
     WHERE table_schema = 'app' AND table_name = 'sales_daily_reports';
    IF v_cols < 8 THEN
        RAISE EXCEPTION '307: sales_daily_reports did not get its columns (found %).', v_cols;
    END IF;

    -- The view must be queryable. A FULL OUTER JOIN over a grouped CTE is easy to get
    -- wrong in a way that only shows up on first read, and a broken view here would
    -- surface as an empty supervisor calendar rather than as an error.
    SELECT count(*) INTO v_rows FROM app.v_sales_officer_days;
    RAISE NOTICE '307: officer-day view reads, % officer-days recorded so far '
                 '(0 is expected — sales activity logging starts with this release).', v_rows;
END
$m307$;

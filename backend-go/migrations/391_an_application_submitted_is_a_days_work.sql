-- 391_an_application_submitted_is_a_days_work.sql
--
-- v_sales_officer_days counts a day's work from app.activities, and its type whitelist was
-- visit / call / meeting / note. That had two holes.
--
-- HOLE 1: email. The lead dialog offers it, the handler writes it, and the view threw it
-- away. An officer who spent a morning emailing customers logged a blank day.
--
-- HOLE 2: the five kinds that MOVE a lead -- interested, handed_to_sales,
-- documents_requested, application_submitted, approved. Until today the moving branch of
-- the lead activity handler wrote no activity at all (fixed in handlers/sales_leads.go, the
-- logActivitySafe after tx.Commit), so there was nothing to count. Now there is, and the
-- effect was backwards before: logging a NOTE counted as a day's work and submitting an
-- APPLICATION did not.
--
-- WHAT IS DELIBERATELY STILL EXCLUDED, and this is the important half of this migration:
-- type 'stage_change', source 'crm_lead'. Those rows are written by the trigger
-- app.activities_from_crm_lead_event on every crm_lead_events insert, and they are
-- bulk-polluted. Measured today: 12,311 of them carry a sales actor, and the per-officer
-- per-day distribution is 62 officer-days holding 101-500 each and 52 holding 21-100 --
-- because the event behind them is 'stage_changed' (20,571 rows from 7 actors), which is
-- what a bulk sweep writes, not what an officer does one lead at a time. For comparison the
-- genuinely officer-logged events number 3 documents_requested, 19 handed_to_sales and 1
-- claimed.
--
-- So counting 'stage_change' would put "317 activities" on a day card for a head who ran one
-- bulk operation. A day card that lies confidently is worse than one that reads zero. The
-- officer's own deliberate action is counted instead, through the manual row the handler
-- now writes, which a bulk sweep cannot produce because it never goes through that path.
--
-- Two columns are appended rather than inserted, because CREATE OR REPLACE VIEW may only
-- add columns at the end. The one reader (handlers/sales_activity.go:586, teamDays) selects
-- by name, so appending is safe.

BEGIN;

CREATE OR REPLACE VIEW app.v_sales_officer_days AS
WITH acts AS (
    SELECT a.actor_user_id                                        AS officer_id,
           (a.occurred_at AT TIME ZONE 'Africa/Lagos')::date      AS day,
           count(*)                                               AS activities,
           count(*) FILTER (WHERE a.type = 'visit')                AS visits,
           count(*) FILTER (WHERE a.type = 'call')                 AS calls,
           count(*) FILTER (WHERE a.type = 'meeting')              AS meetings,
           count(*) FILTER (WHERE a.type = 'note')                 AS notes,
           count(DISTINCT a.contact_id) FILTER (WHERE a.contact_id IS NOT NULL)
                                                                   AS contacts_touched,
           max(a.occurred_at)                                      AS last_activity_at,
           count(*) FILTER (WHERE a.type = 'email')                AS emails,
           count(*) FILTER (WHERE a.type IN ('interested', 'handed_to_sales',
                                             'documents_requested',
                                             'application_submitted', 'approved'))
                                                                   AS moves
      FROM app.activities a
     WHERE a.actor_user_id IS NOT NULL
       AND COALESCE(a.actor_team, '') = 'sales'
       AND a.source = 'manual'
       AND a.type = ANY (ARRAY['visit', 'call', 'meeting', 'note', 'email',
                               'interested', 'handed_to_sales', 'documents_requested',
                               'application_submitted', 'approved'])
     GROUP BY a.actor_user_id, ((a.occurred_at AT TIME ZONE 'Africa/Lagos')::date)
)
-- FULL OUTER JOIN on purpose, unchanged from 307: a day with activity and no report (still
-- working) and a report with no activity (wrote it up, logged nothing) are both real days and
-- both have to appear.
SELECT COALESCE(acts.officer_id, r.officer_id)        AS officer_id,
       COALESCE(acts.day, r.report_date)              AS day,
       COALESCE(acts.activities, 0::bigint)           AS activities,
       COALESCE(acts.visits, 0::bigint)               AS visits,
       COALESCE(acts.calls, 0::bigint)                AS calls,
       COALESCE(acts.meetings, 0::bigint)             AS meetings,
       COALESCE(acts.notes, 0::bigint)                AS notes,
       COALESCE(acts.contacts_touched, 0::bigint)     AS contacts_touched,
       acts.last_activity_at,
       r.id                                           AS report_id,
       r.submitted_at,
       r.submitted_at IS NOT NULL                     AS report_submitted,
       r.summary,
       r.plan,
       COALESCE(acts.emails, 0::bigint)               AS emails,
       COALESCE(acts.moves, 0::bigint)                AS moves
  FROM acts
  FULL JOIN app.sales_daily_reports r
    ON r.officer_id = acts.officer_id AND r.report_date = acts.day;

DO $$
DECLARE v_cols int; v_rows bigint; v_direct bigint; v_bad bigint; v_bulk bigint;
BEGIN
    -- The two new columns exist and are named as the readers will ask for them.
    SELECT count(*) INTO v_cols
      FROM information_schema.columns
     WHERE table_schema = 'app' AND table_name = 'v_sales_officer_days'
       AND column_name IN ('emails', 'moves');
    IF v_cols <> 2 THEN
        RAISE EXCEPTION 'migration 391: expected emails and moves on the view, found % of 2', v_cols;
    END IF;

    -- A FULL OUTER JOIN over a grouped CTE is easy to get past the parser and wrong at run
    -- time, so the view must actually be queryable.
    SELECT count(*) INTO v_rows FROM app.v_sales_officer_days;

    -- Internal consistency: the parts cannot exceed the whole. This is what would catch a
    -- later edit that adds a type to the whitelist without adding it to a FILTER, which
    -- would silently inflate `activities` against a column nobody is counting.
    SELECT count(*) INTO v_bad
      FROM app.v_sales_officer_days
     WHERE activities < visits + calls + meetings + notes + emails + moves;
    IF v_bad <> 0 THEN
        RAISE EXCEPTION 'migration 391: % officer-days where the counted types exceed the total', v_bad;
    END IF;

    -- The view agrees with a direct count over the same filter.
    SELECT count(DISTINCT (a.actor_user_id, (a.occurred_at AT TIME ZONE 'Africa/Lagos')::date))
      INTO v_direct
      FROM app.activities a
     WHERE a.actor_user_id IS NOT NULL
       AND COALESCE(a.actor_team, '') = 'sales'
       AND a.source = 'manual'
       AND a.type = ANY (ARRAY['visit', 'call', 'meeting', 'note', 'email',
                               'interested', 'handed_to_sales', 'documents_requested',
                               'application_submitted', 'approved']);
    IF v_rows < v_direct THEN
        RAISE EXCEPTION 'migration 391: view has % rows but % officer-days have countable activity', v_rows, v_direct;
    END IF;

    -- THE ASSERTION THIS MIGRATION EXISTS TO HOLD. The bulk stage_change rows must stay out.
    -- If a later edit lets them in, the busiest officer-day jumps from single digits into the
    -- hundreds, so the guard is an absolute ceiling on a single day's count rather than a
    -- comparison against a number that will move as the team starts logging properly.
    SELECT COALESCE(max(activities), 0) INTO v_bulk FROM app.v_sales_officer_days;
    IF v_bulk > 100 THEN
        RAISE EXCEPTION 'migration 391: an officer-day shows % activities, which no officer '
            'does by hand -- the bulk stage_change rows have leaked into the whitelist', v_bulk;
    END IF;
END $$;

INSERT INTO app.schema_migrations (filename) VALUES ('391_an_application_submitted_is_a_days_work.sql')
ON CONFLICT DO NOTHING;

COMMIT;

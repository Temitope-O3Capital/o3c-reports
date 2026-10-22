-- rollback_391.sql
--
-- Restores app.v_sales_officer_days to the definition migration 307 created.
--
-- DROP then CREATE, not CREATE OR REPLACE: replacing a view can only ADD trailing columns,
-- never remove them, and this reverts 16 columns to 14. Nothing in the database depends on
-- the view -- its only reader is Go (handlers/sales_activity.go, teamDays) -- so the DROP
-- cannot cascade into anything. If that ever changes, this rollback will fail loudly on the
-- dependency rather than quietly take it with them, which is the behaviour to want.
--
-- Reverting this puts the two holes back: a logged email counts for nothing, and the five
-- kinds that move a lead count for nothing. Pair it with reverting the logActivitySafe call
-- in handlers/sales_leads.go, or the manual stage-move activities will keep being written
-- with nothing reading them.

BEGIN;

DROP VIEW app.v_sales_officer_days;

CREATE VIEW app.v_sales_officer_days AS
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
           max(a.occurred_at)                                      AS last_activity_at
      FROM app.activities a
     WHERE a.actor_user_id IS NOT NULL
       AND COALESCE(a.actor_team, '') = 'sales'
       AND a.type = ANY (ARRAY['visit', 'call', 'meeting', 'note'])
       AND a.source = 'manual'
     GROUP BY a.actor_user_id, ((a.occurred_at AT TIME ZONE 'Africa/Lagos')::date)
)
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
       r.plan
  FROM acts
  FULL JOIN app.sales_daily_reports r
    ON r.officer_id = acts.officer_id AND r.report_date = acts.day;

DO $$
DECLARE v_cols int; v_rows bigint;
BEGIN
    SELECT count(*) INTO v_cols
      FROM information_schema.columns
     WHERE table_schema = 'app' AND table_name = 'v_sales_officer_days';
    IF v_cols <> 14 THEN
        RAISE EXCEPTION 'rollback 391: expected the 14-column view from 307, found %', v_cols;
    END IF;

    SELECT count(*) INTO v_cols
      FROM information_schema.columns
     WHERE table_schema = 'app' AND table_name = 'v_sales_officer_days'
       AND column_name IN ('emails', 'moves');
    IF v_cols <> 0 THEN
        RAISE EXCEPTION 'rollback 391: emails/moves survive on the view';
    END IF;

    SELECT count(*) INTO v_rows FROM app.v_sales_officer_days;
END $$;

DELETE FROM app.schema_migrations
 WHERE btrim(filename, chr(13)) = '391_an_application_submitted_is_a_days_work.sql';

COMMIT;

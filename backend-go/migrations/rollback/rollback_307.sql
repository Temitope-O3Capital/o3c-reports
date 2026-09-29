-- Rollback for 307_the_sales_day_on_the_record
--
-- DESTRUCTIVE: dropping sales_daily_reports destroys every daily report officers have
-- filed. Those are first-hand accounts of their own days and are not reconstructible from
-- anything else — the activities survive, but "here is what I make of today" does not.
-- Take a copy first if any have been filed:
--
--   CREATE TABLE app.sales_daily_reports_backup AS SELECT * FROM app.sales_daily_reports;
--   SELECT count(*) FILTER (WHERE submitted_at IS NOT NULL) FROM app.sales_daily_reports;
--
-- The logged ACTIVITIES are deliberately left in place. They live in app.activities
-- alongside every other team's, the Leads timeline reads them, and deleting the sales
-- rows out of that stream would tear holes in lead histories — a visit logged against a
-- lead belongs on that lead's record whether this feature exists or not.

DROP VIEW IF EXISTS app.v_sales_officer_days;

DROP TABLE IF EXISTS app.sales_daily_reports;

-- The activity index is additive and harmless, but 307 added it, so 307 takes it back.
DROP INDEX IF EXISTS app.idx_activities_actor_day;

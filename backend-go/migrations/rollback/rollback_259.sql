-- Rollback 259: restore migration 238's thresholds and drop the weekend rule.
--
-- Consequence: paystack alerts stale after 24h (its p95 quiet stretch is 41h),
-- zoho_calls alerts every weekend, and appsflyer warns at 12h while holding
-- current data. That is the behaviour 259 exists to end, so roll back only if the
-- weekend adjustment itself is the problem.
UPDATE app.pipeline_source
   SET warn_after = interval '6 hours', stale_after = interval '24 hours',
       notes = 'Data age is MAX(paid_at): real settlement activity, not the sync clock. Note the sync watermark advances even when nothing is returned.',
       updated_at = now()
 WHERE source_key = 'paystack';

UPDATE app.pipeline_source
   SET warn_after = interval '12 hours', stale_after = interval '48 hours',
       notes = 'Aggregate pull; activity_date is a date, so expect up to a day of natural lag.',
       updated_at = now()
 WHERE source_key = 'appsflyer';

UPDATE app.pipeline_source
   SET business_days_only = false,
       warn_after = interval '4 hours', stale_after = interval '12 hours',
       notes = 'Quiet overnight and at weekends — hence 4h warn rather than minutes.',
       updated_at = now()
 WHERE source_key = 'zoho_calls';

-- Drop the view so migration 238 (and 257's data-age view) rebuild it on the next
-- boot, then remove the column the rebuilt view no longer references.
DROP VIEW IF EXISTS app.v_pipeline_freshness;
ALTER TABLE app.pipeline_source DROP COLUMN IF EXISTS business_days_only;

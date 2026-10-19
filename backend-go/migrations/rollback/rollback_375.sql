-- Rollback for 375_udara_capture_jobs_are_watched_like_every_other_feed.sql
--
-- WHAT THIS DESTROYS. Almost nothing, and that is worth stating plainly because it is
-- unusual: 375 added observability, not data. Everything below is schema and four
-- configuration rows.
--
--   * app.cbs_sync_runs.degraded_steps — the only real loss. Each value is the list of
--     post-commit steps that did not run on one sync. If a run is currently showing a
--     degradation you have not yet explained, read it before dropping the column:
--
--       SELECT id, started_at, degraded_steps FROM app.cbs_sync_runs
--        WHERE degraded_steps IS NOT NULL ORDER BY id DESC LIMIT 50;
--
--   * The four app.pipeline_source rows — thresholds only. Re-deriving them means
--     re-doing the lag measurement in 375's header, so copy the rows out first if you
--     intend to restore them:
--
--       CREATE TABLE app.pipeline_source_375 AS SELECT * FROM app.pipeline_source
--        WHERE source_key IN ('cbs_repayments','cbs_gl_postings',
--                             'cbs_journal_receipts','blink_fx_events');
--
-- WHAT THIS DOES NOT UNDO, DELIBERATELY.
--
--   * app.loan_repayments, app.cbs_gl_postings, app.cbs_journal_receipts and
--     app.blink_fx_events are untouched. 375 only measured them.
--   * app.v_pipeline_data_age is untouched, because 375 never altered it. That was the
--     whole point of putting the new arms in a view of their own.
--   * The Go side is not reverted by SQL. After this runs, the Worker Hub still SELECTs
--     degraded_steps and will error on the core-banking row until the matching binary
--     is rolled back too. Roll the code back first, or in the same step.
--   * The worker_heartbeats row for 'blink_fx_parse' stays. It is written by the
--     parser, costs nothing, and is useful whether or not anything reads it.
--
-- ORDER MATTERS. v_pipeline_freshness must stop referring to the Udara measurement
-- view BEFORE that view is dropped, or the DROP fails on the dependency.

BEGIN;

-- 1. Restore the verdict view to migration 259's definition: measurement from
--    app.v_pipeline_data_age alone. Text identical to 259 — if 259 is ever superseded,
--    copy from its true latest definer instead, which is the mistake migration 257
--    made and 285 had to repair.
DROP VIEW IF EXISTS app.v_pipeline_freshness;

CREATE VIEW app.v_pipeline_freshness AS
SELECT s.source_key,
       s.label,
       s.category,
       s.owner,
       s.enabled,
       s.notes,
       s.expected_interval,
       s.warn_after,
       s.stale_after,
       a.last_run_at,
       a.last_ok_at,
       a.last_data_at,
       now() - a.last_data_at                                   AS data_age,
       adj.effective_data_age,
       s.business_days_only,
       now() - a.last_ok_at                                     AS run_age,
       a.rows_recent,
       a.rows_baseline,
       CASE WHEN COALESCE(a.rows_baseline, 0) > 0
            THEN round((a.rows_recent / a.rows_baseline)::numeric, 3) END AS volume_ratio,
       CASE
         WHEN NOT s.enabled                                          THEN 'disabled'
         WHEN a.last_data_at IS NULL                                 THEN 'never'
         WHEN s.stale_after IS NOT NULL
              AND adj.effective_data_age > s.stale_after             THEN 'stale'
         -- Taper: volume collapsed while data technically still arrives.
         WHEN s.volume_floor_ratio > 0 AND COALESCE(a.rows_baseline, 0) > 0
              AND a.rows_recent < s.volume_floor_ratio * a.rows_baseline THEN 'taper'
         WHEN s.warn_after IS NOT NULL
              AND adj.effective_data_age > s.warn_after              THEN 'warn'
         ELSE 'ok'
       END                                                       AS state,
       -- Separate verdict on the JOB as opposed to the DATA. A source can be
       -- fresh while its worker is dead (another path filled the table), or the
       -- worker green while the source is silent — the case that started this.
       CASE
         WHEN a.last_ok_at IS NULL AND a.last_run_at IS NULL       THEN 'unknown'
         WHEN s.expected_interval IS NULL                          THEN 'n/a'
         WHEN a.last_ok_at IS NULL                                 THEN 'never_ok'
         WHEN now() - a.last_ok_at > (s.expected_interval * 4)     THEN 'run_dead'
         ELSE 'running'
       END                                                       AS run_state
  FROM app.pipeline_source s
  LEFT JOIN app.v_pipeline_data_age a USING (source_key)
  LEFT JOIN LATERAL (
      -- Whole weekend days between the newest data and now are removed for a
      -- business-days-only source. Partial days are not: today counts as it
      -- stands, so a Monday-morning gap is measured honestly.
      SELECT CASE
               WHEN a.last_data_at IS NULL      THEN NULL
               WHEN NOT s.business_days_only    THEN now() - a.last_data_at
               ELSE GREATEST(
                      interval '0',
                      (now() - a.last_data_at)
                        - (COALESCE((SELECT count(*)
                                       FROM generate_series(a.last_data_at::date,
                                                            (now() - interval '1 day')::date,
                                                            interval '1 day') d
                                      WHERE EXTRACT(ISODOW FROM d) IN (6, 7)), 0)
                           * interval '24 hours'))
             END AS effective_data_age
  ) adj ON true;

COMMENT ON VIEW app.v_pipeline_freshness IS
  'One row per inbound source with a freshness verdict: ok | warn | stale | taper | never | disabled, plus an independent run_state (running | run_dead | never_ok). data_age is true wall-clock age; effective_data_age is what the verdict tests, and differs only for business_days_only sources, where whole weekend days are removed (migration 259). This is what the monitor worker and the Data Freshness page read.';

-- 2. Now nothing refers to it.
DROP VIEW IF EXISTS app.v_pipeline_data_age_udara;

-- 3. Un-register the four sources. Any open alert rows for them go too, or the
--    monitor keeps a claim on a source that no longer exists.
DELETE FROM app.pipeline_alert_state
 WHERE source_key IN ('cbs_repayments','cbs_gl_postings','cbs_journal_receipts','blink_fx_events');

DELETE FROM app.pipeline_source
 WHERE source_key IN ('cbs_repayments','cbs_gl_postings','cbs_journal_receipts','blink_fx_events');

-- 4. The one destructive step. Read the column out first if you have not.
ALTER TABLE app.cbs_sync_runs DROP COLUMN IF EXISTS degraded_steps;

DO $assert$
DECLARE n INT;
BEGIN
  SELECT COUNT(*) INTO n FROM app.pipeline_source
   WHERE source_key IN ('cbs_repayments','cbs_gl_postings','cbs_journal_receipts','blink_fx_events');
  IF n <> 0 THEN
    RAISE EXCEPTION 'rollback 375: % Udara source(s) still registered', n;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
              WHERE ns.nspname = 'app' AND c.relname = 'v_pipeline_data_age_udara') THEN
    RAISE EXCEPTION 'rollback 375: measurement view still present';
  END IF;
  -- The restored view must still answer for every source that remains, or the
  -- Data Freshness page goes blank for sources that have nothing to do with Udara.
  SELECT COUNT(*) INTO n FROM app.v_pipeline_freshness;
  IF n = 0 THEN
    RAISE EXCEPTION 'rollback 375: restored v_pipeline_freshness returned no rows';
  END IF;
  RAISE NOTICE 'rollback 375 OK: % source(s) still measured', n;
END $assert$;

COMMIT;

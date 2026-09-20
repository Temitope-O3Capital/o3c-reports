-- Stop the monitor alerting on normal quiet. An alert that fires every weekend
-- teaches everyone to ignore the one that matters, which is the failure this
-- whole feature exists to prevent.
--
-- Measured 2026-09-20 over the last 90 days, against the thresholds migration 238
-- seeded from judgement rather than data:
--
--   paystack    settlements land every day (Mon 37 ... Sat 15, Sun 19) but the
--               p95 gap between them is 1d 17h and the worst is 3d 00h. Against
--               warn 6h / stale 24h, an ordinary quiet stretch is an outage.
--
--   zoho_calls  Mon-Fri 20,548-25,745 calls; Sat 24; Sun 13. The call centre does
--               not work weekends, so warn 4h / stale 12h guarantees an alert
--               every Saturday for ever.
--
--   appsflyer   activity_date is a DATE, so it becomes midnight and the source
--               reads up to 24h stale the moment it is perfectly current — it was
--               warning at 17h while holding data for today.
--
-- Widening zoho_calls far enough to cover a 62-hour Friday-to-Monday silence
-- would leave a Monday-morning breakage undetected until Thursday. So instead the
-- verdict learns about weekends: for a business_days_only source, whole Saturdays
-- and Sundays are subtracted from the data age. Detection on working days stays
-- tight; the weekend stops being an incident.
ALTER TABLE app.pipeline_source
  ADD COLUMN IF NOT EXISTS business_days_only boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN app.pipeline_source.business_days_only IS
  'true = this source only produces data on working days, so whole weekend days are subtracted from its age before the warn/stale verdict. Set for sources whose silence at the weekend is normal (the call centre). Migration 259.';

UPDATE app.pipeline_source
   SET warn_after = interval '48 hours', stale_after = interval '96 hours',
       notes = 'Data age is MAX(paid_at): real settlement activity, not the sync clock. Thresholds measured 2026-09-20 — p95 gap between settlements is 1d 17h and the worst in 90 days is 3d, so anything tighter alerts on ordinary quiet. Note the sync watermark advances even when nothing is returned.',
       updated_at = now()
 WHERE source_key = 'paystack';

UPDATE app.pipeline_source
   SET warn_after = interval '36 hours', stale_after = interval '72 hours',
       notes = 'Aggregate pull; activity_date is a DATE, so the newest row reads as midnight and the source is up to 24h "old" the moment it is current. Thresholds allow for that plus a day of natural lag.',
       updated_at = now()
 WHERE source_key = 'appsflyer';

UPDATE app.pipeline_source
   SET business_days_only = true,
       warn_after = interval '18 hours', stale_after = interval '36 hours',
       notes = 'Weekends are excluded from the age (business_days_only): measured 2026-09-20, weekdays carry 20.5k-25.7k calls and Saturday 24, Sunday 13. An overnight gap is ~14h so it stays quiet, a Friday-to-Monday silence nets to ~14h once two weekend days are removed, and a genuine weekday outage still trips inside ~1.5 days.',
       updated_at = now()
 WHERE source_key = 'zoho_calls';

-- The verdict view, with the weekend adjustment. v_pipeline_data_age stays raw:
-- measurement and policy are deliberately separate, and data_age below is still
-- the true wall-clock age — effective_data_age is what the verdict uses.
--
-- Dropped and recreated rather than CREATE OR REPLACE: replace can only APPEND
-- columns, and effective_data_age/business_days_only belong next to data_age
-- where a reader will find them. Nothing depends on this view — the monitor and
-- the Data Freshness page query it directly by column name — so dropping it is
-- safe, and a migration that fails here would abort backend startup.
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

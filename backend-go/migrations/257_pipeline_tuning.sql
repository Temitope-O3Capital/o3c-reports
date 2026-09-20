-- Two corrections to the freshness monitor, from a week of it running.
--
-- 1. THE CUSTOMER FEED WAS NOT BROKEN. It alerted stale on 2026-09-20 with the
--    taper check firing first. Measured against the drop folder itself, the feed
--    was healthy the whole time: 96 files a day arriving on schedule, newest at
--    17:19 that afternoon. What changed is that none of them carried rows.
--
--      2026-09-14  25 files   12 non-empty
--      2026-09-15  96 files   33 non-empty
--      2026-09-16  96 files    1 non-empty
--      2026-09-17  96 files    5 non-empty
--      2026-09-18  96 files    3 non-empty
--      2026-09-19  96 files    0 non-empty
--      2026-09-20  96 files    0 non-empty
--
--    Customers genuinely change that rarely: two consecutive days with no change
--    is ordinary, not an outage. The seeded note claimed "~27 non-empty drops/day"
--    — that was never measured and is wrong by an order of magnitude.
--
--    So: warn after 48h rather than 12h, stale after 120h rather than 36h, and
--    taper detection OFF. A median daily volume of 1-3 rows makes any ratio test
--    noise, and a feed whose normal state is zero cannot have its volume collapse.
--    The account and transaction feeds keep their tight thresholds — those really
--    do deliver ~1,090 non-empty drops a day.
UPDATE app.pipeline_source
   SET warn_after         = interval '48 hours',
       stale_after        = interval '120 hours',
       volume_floor_ratio = 0,
       notes              = 'E:\cust_file. Customers change rarely: measured 2026-09-14..20, the feed delivered 96 files/day of which 0-33 carried rows, with two consecutive zero days that were not an outage. Thresholds are wide and taper detection is off for that reason — see migration 257.',
       updated_at         = now()
 WHERE source_key = 'customer_feed';

-- 2. MANUAL UPLOADS NOW HAVE A RUN TIME. Migration 238 left last_run_at NULL for
--    the three manual sources because no run table existed. Migration 245 created
--    app.upload_audit_log, and Interswitch settlement already recorded runs in
--    app.interswitch_imports, so "when did someone last try?" is answerable — and
--    it is a different question from "how old is the data?". A failed upload that
--    nobody noticed now shows as a recent run with stale data, instead of looking
--    like nobody ever tried.
--
--    This cannot introduce false "job dead" alerts: v_pipeline_freshness returns
--    run_state 'n/a' whenever expected_interval IS NULL, which is the case for all
--    three, and that branch is tested before run_dead.
CREATE OR REPLACE VIEW app.v_pipeline_data_age AS
WITH
-- File feeds: newest file THAT CARRIED ROWS, per stream.
feed_data AS (
    SELECT 'feed_' || stream AS source_key, MAX(feed_date)::timestamptz AS last_data_at
      FROM app.feed_files
     WHERE status = 'ok' AND COALESCE(rows_read, 0) > 0
     GROUP BY stream
),
-- Daily row volume per stream, for the taper baseline.
feed_daily AS (
    SELECT 'feed_' || stream AS source_key, created_at::date AS day,
           SUM(COALESCE(rows_read, 0)) AS rows_day
      FROM app.feed_files
     WHERE created_at >= now() - interval '16 days'
     GROUP BY 1, 2
),
feed_vol AS (
    SELECT source_key,
           COALESCE(SUM(rows_day) FILTER (WHERE day >= CURRENT_DATE - 1), 0) AS rows_recent,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY rows_day)
               FILTER (WHERE day < CURRENT_DATE - 1)                          AS rows_baseline
      FROM feed_daily
     GROUP BY source_key
),
feed_runs_latest AS (
    SELECT DISTINCT ON (stream) 'feed_' || stream AS source_key,
           COALESCE(finished_at, started_at) AS last_run_at,
           CASE WHEN status = 'ok' THEN COALESCE(finished_at, started_at) END AS last_ok_at
      FROM app.feed_runs
     ORDER BY stream, id DESC
),
-- custfeed predates feedcore and keeps its own tables, with no stream column.
-- A monitor that only reads feed_files silently never watches customers.
cust_daily AS (
    SELECT processed_at::date AS day, SUM(COALESCE(rows_read, 0)) AS rows_day
      FROM app.customer_feed_files
     WHERE processed_at >= now() - interval '16 days'
     GROUP BY 1
),
cust_vol AS (
    SELECT COALESCE(SUM(rows_day) FILTER (WHERE day >= CURRENT_DATE - 1), 0) AS rows_recent,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY rows_day)
               FILTER (WHERE day < CURRENT_DATE - 1)                          AS rows_baseline
      FROM cust_daily
),
cust_run AS (
    SELECT COALESCE(finished_at, started_at) AS last_run_at,
           CASE WHEN status = 'ok' THEN COALESCE(finished_at, started_at) END AS last_ok_at
      FROM app.customer_feed_runs ORDER BY id DESC LIMIT 1
)
SELECT source_key, last_run_at, last_ok_at, last_data_at, rows_recent, rows_baseline FROM (
    -- ── File feeds ──────────────────────────────────────────────────────────
    SELECT d.source_key, r.last_run_at, r.last_ok_at, d.last_data_at,
           v.rows_recent, v.rows_baseline
      FROM feed_data d
      LEFT JOIN feed_runs_latest r USING (source_key)
      LEFT JOIN feed_vol v USING (source_key)

    UNION ALL
    SELECT 'customer_feed',
           (SELECT last_run_at FROM cust_run), (SELECT last_ok_at FROM cust_run),
           (SELECT MAX(feed_date)::timestamptz FROM app.customer_feed_files
             WHERE status = 'ok' AND COALESCE(rows_read, 0) > 0),
           (SELECT rows_recent FROM cust_vol), (SELECT rows_baseline FROM cust_vol)

    -- ── Polled APIs ─────────────────────────────────────────────────────────
    -- Data age is the newest synced_at on the destination rows, not the run
    -- time: a sync that returns nothing still writes a successful run row.
    UNION ALL
    SELECT 'cbs',
           (SELECT COALESCE(finished_at, started_at) FROM app.cbs_sync_runs ORDER BY id DESC LIMIT 1),
           (SELECT COALESCE(finished_at, started_at) FROM app.cbs_sync_runs WHERE status = 'ok' ORDER BY id DESC LIMIT 1),
           GREATEST((SELECT MAX(synced_at) FROM app.cbs_loans),
                    (SELECT MAX(synced_at) FROM app.cbs_customers)),
           NULL, NULL

    UNION ALL
    SELECT 'paystack',
           (SELECT COALESCE(finished_at, started_at) FROM app.paystack_sync_runs ORDER BY id DESC LIMIT 1),
           (SELECT COALESCE(finished_at, started_at) FROM app.paystack_sync_runs WHERE status = 'ok' ORDER BY id DESC LIMIT 1),
           (SELECT MAX(paid_at) FROM app.paystack_transactions),
           NULL, NULL

    UNION ALL
    SELECT 'appsflyer',
           (SELECT COALESCE(finished_at, started_at) FROM app.appsflyer_sync_runs ORDER BY id DESC LIMIT 1),
           (SELECT COALESCE(finished_at, started_at) FROM app.appsflyer_sync_runs WHERE status = 'ok' ORDER BY id DESC LIMIT 1),
           (SELECT MAX(activity_date)::timestamptz FROM app.appsflyer_daily),
           NULL, NULL

    UNION ALL
    SELECT 'zoho_calls',
           (SELECT last_attempt_at FROM app.zoho_sync_state WHERE job = 'calls'),
           (SELECT last_success_at FROM app.zoho_sync_state WHERE job = 'calls'),
           (SELECT MAX(started_at) FROM app.helpdesk_calls),
           NULL, NULL

    UNION ALL
    SELECT 'zoho_desk',
           (SELECT last_finished_at FROM app.worker_heartbeats WHERE worker_key = 'zoho_desk'),
           (SELECT last_ok_at FROM app.worker_heartbeats WHERE worker_key = 'zoho_desk'),
           (SELECT MAX(created_at) FROM app.helpdesk_tickets),
           NULL, NULL

    UNION ALL
    SELECT 'fx_rates',
           (SELECT last_finished_at FROM app.worker_heartbeats WHERE worker_key = 'fx_rates'),
           (SELECT last_ok_at FROM app.worker_heartbeats WHERE worker_key = 'fx_rates'),
           (SELECT MAX(scraped_at) FROM app.fx_parallel_rates),
           NULL, NULL

    -- ── Mail ingest ─────────────────────────────────────────────────────────
    UNION ALL
    SELECT 'inbound_mail',
           (SELECT last_finished_at FROM app.worker_heartbeats WHERE worker_key = 'graph_inbox'),
           (SELECT last_ok_at FROM app.worker_heartbeats WHERE worker_key = 'graph_inbox'),
           (SELECT MAX(received_at) FROM app.inbound_mail),
           NULL, NULL

    UNION ALL
    SELECT 'mail_outbound',
           (SELECT last_finished_at FROM app.worker_heartbeats WHERE worker_key = 'bounce_monitor'),
           (SELECT last_ok_at FROM app.worker_heartbeats WHERE worker_key = 'bounce_monitor'),
           (SELECT MAX(created_at) FROM app.mail_messages),
           NULL, NULL

    -- ── Manual uploads ──────────────────────────────────────────────────────
    -- Run times come from the upload ledger (migration 245) and, for settlement,
    -- the run table it already had. Data age remains the newest imported row, so
    -- "someone uploaded today but the data is still six weeks old" is visible.
    UNION ALL
    SELECT 'interswitch_settlement',
           (SELECT MAX(started_at) FROM app.interswitch_imports),
           (SELECT MAX(started_at) FROM app.interswitch_imports WHERE status = 'ok'),
           (SELECT MAX(imported_at) FROM app.interswitch_legs), NULL, NULL
    UNION ALL
    SELECT 'ccs_eodtxn',
           (SELECT MAX(uploaded_at) FROM app.upload_audit_log WHERE report_type = 'ccs_eodtxn'),
           (SELECT MAX(uploaded_at) FROM app.upload_audit_log WHERE report_type = 'ccs_eodtxn' AND status = 'success'),
           (SELECT MAX(imported_at) FROM app.ccs_transactions), NULL, NULL
    UNION ALL
    SELECT 'card_cycle',
           (SELECT MAX(uploaded_at) FROM app.upload_audit_log WHERE report_type = 'card_cycle'),
           (SELECT MAX(uploaded_at) FROM app.upload_audit_log WHERE report_type = 'card_cycle' AND status = 'success'),
           (SELECT MAX(imported_at) FROM app.card_cycle_data), NULL, NULL

    -- ── Webhook inbound ─────────────────────────────────────────────────────
    UNION ALL
    SELECT 'phoenix_inbound', NULL, NULL,
           (SELECT MAX(received_at) FROM app.phoenix_events), NULL, NULL
) src;

COMMENT ON VIEW app.v_pipeline_data_age IS
  'Raw per-source measurement: last run, last successful run, age of the newest DATA, and 24h-vs-trailing-median row volume. Data age uses ingest timestamps only — business dates in this warehouse run into the future. Manual uploads take their run times from app.upload_audit_log / app.interswitch_imports (migration 257).';

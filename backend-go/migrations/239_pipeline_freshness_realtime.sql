-- 239: make file-feed "data age" real-time (fix the noon-stale false positive).
--
-- Migration 238 measured a file feed's data age from MAX(feed_date). feed_date is
-- a DATE, so MAX(feed_date)::timestamptz collapses to MIDNIGHT of the newest day
-- that carried rows. Two consequences, both wrong:
--
--   1. FALSE STALE EVERY AFTERNOON. data_age became "time since midnight", never
--      the true minutes-since-last-drop. accounts/txn have a 12h stale threshold,
--      so they flipped to 'stale' at ~noon EVERY day even while perfectly healthy
--      (observed 2026-09-14: real age 12 min, view reported 12h47m → stale).
--   2. UNDER-COUNTS INTRADAY OUTAGES. A feed dead since 00:30 still reads feed_date
--      = today, so it looks fresher than it is until the date rolls over.
--
-- A page called "Data Freshness" must reflect the actual clock. The fix: measure
-- data age from the INGEST timestamp of the newest row-carrying file
-- (feed_files.created_at / customer_feed_files.processed_at), not its calendar
-- date. This is strictly better for outage detection too — during a stall no new
-- row-carrying file is ingested, so the timestamp freezes and data_age grows in
-- real time. The row-carrying filter (status='ok' AND rows_read>0) is unchanged,
-- so zero-byte "no change this window" drops still never read as fresh.
--
-- Polled APIs (cbs, paystack, …) already used real timestamps and are untouched.
-- Only the file-feed and customer-feed branches change; output columns are
-- identical, so v_pipeline_freshness (which reads this view) needs no change.

CREATE OR REPLACE VIEW app.v_pipeline_data_age AS
WITH
-- File feeds: INGEST TIME of the newest file that carried rows, per stream.
feed_data AS (
    SELECT 'feed_' || stream AS source_key, MAX(created_at) AS last_data_at
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
    -- Customer feed: INGEST TIME (processed_at) of the newest row-carrying drop.
    SELECT 'customer_feed',
           (SELECT last_run_at FROM cust_run), (SELECT last_ok_at FROM cust_run),
           (SELECT MAX(processed_at) FROM app.customer_feed_files
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

    -- ── Manual uploads: no run table exists for most of these, so run age is
    -- NULL by design and data age is the only signal.
    UNION ALL
    SELECT 'interswitch_settlement', NULL, NULL,
           (SELECT MAX(imported_at) FROM app.interswitch_legs), NULL, NULL
    UNION ALL
    SELECT 'ccs_eodtxn', NULL, NULL,
           (SELECT MAX(imported_at) FROM app.ccs_transactions), NULL, NULL
    UNION ALL
    SELECT 'card_cycle', NULL, NULL,
           (SELECT MAX(imported_at) FROM app.card_cycle_data), NULL, NULL

    -- ── Webhook inbound ─────────────────────────────────────────────────────
    UNION ALL
    SELECT 'phoenix_inbound', NULL, NULL,
           (SELECT MAX(received_at) FROM app.phoenix_events), NULL, NULL
) src;

COMMENT ON VIEW app.v_pipeline_data_age IS
  'Raw per-source measurement: last run, last successful run, age of the newest DATA, and 24h-vs-trailing-median row volume. File-feed data age uses the INGEST timestamp of the newest row-carrying drop (migration 239) so freshness is real-time, not date-granular. Business dates are never used — they run into the future in this warehouse.';

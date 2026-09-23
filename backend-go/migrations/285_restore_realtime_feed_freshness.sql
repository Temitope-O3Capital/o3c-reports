-- 285: restore migration 239 — file-feed freshness measured in real time, not by date.
--
-- WHAT WENT WRONG. Migration 239 (2026-09-14) fixed a false "stale" by measuring a
-- file feed's data age from the INGEST TIMESTAMP of the newest row-carrying drop
-- instead of its calendar feed_date, which is a DATE and therefore collapses to
-- midnight. On 2026-09-20 migration 257_pipeline_tuning.sql did a CREATE OR REPLACE
-- on the same view, and its body had been built from migration 238's text — the
-- version from BEFORE the fix. So 239 was silently undone six days after it shipped,
-- while app.schema_migrations still (correctly) records 239 as applied. Verified on
-- the live database on 2026-09-23: the view still contained max(feed_files.feed_date).
--
-- 257's own file has since left the tree, so it cannot re-run. Its LEGITIMATE changes
-- are still live and are deliberately KEPT here — this migration starts from the
-- CURRENT view definition rather than from 239's text, so the run-timing 257 added for
-- the manual uploads (app.interswitch_imports, app.upload_audit_log) and its customer
-- feed taper work survive. Exactly two expressions change, both of them the regression:
--
--     feed_data       max(feed_files.feed_date)::timestamptz
--                  -> max(feed_files.created_at)
--     customer feed   max(customer_feed_files.feed_date)::timestamptz
--                  -> max(customer_feed_files.processed_at)
--
-- WHY IT MATTERS. feed_date is date-granular, so "data age" became "time since
-- midnight". Two symptoms, both live until now:
--   1. FALSE STALE DAILY. feed_transactions and feed_accounts carry a 3h warn
--      threshold, so they flipped to stale at 03:00 every day and stayed there until
--      midnight — while files were in fact landing every 15 minutes (96 drops/day,
--      45-51 of them carrying rows on 2026-09-21/22).
--   2. REAL OUTAGES UNDER-COUNTED. A feed dead since 00:30 still reads feed_date =
--      today, so it looks fresh until the date rolls over. This is the dangerous half:
--      the monitor that exists to catch a stall is blind to it for up to 24 hours.
--
-- The row-carrying filter (status='ok' AND rows_read>0) is unchanged, so zero-byte
-- "no change this window" drops still never read as fresh. Output columns are
-- identical, so app.v_pipeline_freshness, which reads this view, needs no change.
--
-- BEGIN/SET LOCAL because the view body below is rendered unqualified by
-- pg_get_viewdef; SET LOCAL scopes the search_path to this transaction so it cannot
-- leak into the migrations that run after it on the same connection.
BEGIN;
SET LOCAL search_path TO app, core, public;

CREATE OR REPLACE VIEW app.v_pipeline_data_age AS
 WITH feed_data AS (
         SELECT 'feed_'::text || feed_files.stream AS source_key,
            max(feed_files.created_at) AS last_data_at
           FROM feed_files
          WHERE feed_files.status = 'ok'::text AND COALESCE(feed_files.rows_read, 0) > 0
          GROUP BY feed_files.stream
        ), feed_daily AS (
         SELECT 'feed_'::text || feed_files.stream AS source_key,
            feed_files.created_at::date AS day,
            sum(COALESCE(feed_files.rows_read, 0)) AS rows_day
           FROM feed_files
          WHERE feed_files.created_at >= (now() - '16 days'::interval)
          GROUP BY ('feed_'::text || feed_files.stream), (feed_files.created_at::date)
        ), feed_vol AS (
         SELECT feed_daily.source_key,
            COALESCE(sum(feed_daily.rows_day) FILTER (WHERE feed_daily.day >= (CURRENT_DATE - 1)), 0::numeric) AS rows_recent,
            percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (feed_daily.rows_day::double precision)) FILTER (WHERE feed_daily.day < (CURRENT_DATE - 1)) AS rows_baseline
           FROM feed_daily
          GROUP BY feed_daily.source_key
        ), feed_runs_latest AS (
         SELECT DISTINCT ON (feed_runs.stream) 'feed_'::text || feed_runs.stream AS source_key,
            COALESCE(feed_runs.finished_at, feed_runs.started_at) AS last_run_at,
                CASE
                    WHEN feed_runs.status = 'ok'::text THEN COALESCE(feed_runs.finished_at, feed_runs.started_at)
                    ELSE NULL::timestamp with time zone
                END AS last_ok_at
           FROM feed_runs
          ORDER BY feed_runs.stream, feed_runs.id DESC
        ), cust_daily AS (
         SELECT customer_feed_files.processed_at::date AS day,
            sum(COALESCE(customer_feed_files.rows_read, 0)) AS rows_day
           FROM customer_feed_files
          WHERE customer_feed_files.processed_at >= (now() - '16 days'::interval)
          GROUP BY (customer_feed_files.processed_at::date)
        ), cust_vol AS (
         SELECT COALESCE(sum(cust_daily.rows_day) FILTER (WHERE cust_daily.day >= (CURRENT_DATE - 1)), 0::numeric) AS rows_recent,
            percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (cust_daily.rows_day::double precision)) FILTER (WHERE cust_daily.day < (CURRENT_DATE - 1)) AS rows_baseline
           FROM cust_daily
        ), cust_run AS (
         SELECT COALESCE(customer_feed_runs.finished_at, customer_feed_runs.started_at) AS last_run_at,
                CASE
                    WHEN customer_feed_runs.status = 'ok'::text THEN COALESCE(customer_feed_runs.finished_at, customer_feed_runs.started_at)
                    ELSE NULL::timestamp with time zone
                END AS last_ok_at
           FROM customer_feed_runs
          ORDER BY customer_feed_runs.id DESC
         LIMIT 1
        )
 SELECT source_key,
    last_run_at,
    last_ok_at,
    last_data_at,
    rows_recent,
    rows_baseline
   FROM ( SELECT d.source_key,
            r.last_run_at,
            r.last_ok_at,
            d.last_data_at,
            v.rows_recent,
            v.rows_baseline
           FROM feed_data d
             LEFT JOIN feed_runs_latest r USING (source_key)
             LEFT JOIN feed_vol v USING (source_key)
        UNION ALL
         SELECT 'customer_feed'::text,
            ( SELECT cust_run.last_run_at
                   FROM cust_run) AS last_run_at,
            ( SELECT cust_run.last_ok_at
                   FROM cust_run) AS last_ok_at,
            ( SELECT max(customer_feed_files.processed_at) AS max
                   FROM customer_feed_files
                  WHERE customer_feed_files.status = 'ok'::text AND COALESCE(customer_feed_files.rows_read, 0) > 0) AS max,
            ( SELECT cust_vol.rows_recent
                   FROM cust_vol) AS rows_recent,
            ( SELECT cust_vol.rows_baseline
                   FROM cust_vol) AS rows_baseline
        UNION ALL
         SELECT 'cbs'::text,
            ( SELECT COALESCE(cbs_sync_runs.finished_at, cbs_sync_runs.started_at) AS "coalesce"
                   FROM cbs_sync_runs
                  ORDER BY cbs_sync_runs.id DESC
                 LIMIT 1) AS "coalesce",
            ( SELECT COALESCE(cbs_sync_runs.finished_at, cbs_sync_runs.started_at) AS "coalesce"
                   FROM cbs_sync_runs
                  WHERE cbs_sync_runs.status = 'ok'::text
                  ORDER BY cbs_sync_runs.id DESC
                 LIMIT 1) AS "coalesce",
            GREATEST(( SELECT max(cbs_loans.synced_at) AS max
                   FROM cbs_loans), ( SELECT max(cbs_customers.synced_at) AS max
                   FROM cbs_customers)) AS "greatest",
            NULL::numeric,
            NULL::double precision
        UNION ALL
         SELECT 'paystack'::text,
            ( SELECT COALESCE(paystack_sync_runs.finished_at, paystack_sync_runs.started_at) AS "coalesce"
                   FROM paystack_sync_runs
                  ORDER BY paystack_sync_runs.id DESC
                 LIMIT 1) AS "coalesce",
            ( SELECT COALESCE(paystack_sync_runs.finished_at, paystack_sync_runs.started_at) AS "coalesce"
                   FROM paystack_sync_runs
                  WHERE paystack_sync_runs.status = 'ok'::text
                  ORDER BY paystack_sync_runs.id DESC
                 LIMIT 1) AS "coalesce",
            ( SELECT max(paystack_transactions.paid_at) AS max
                   FROM paystack_transactions) AS max,
            NULL::numeric,
            NULL::double precision
        UNION ALL
         SELECT 'appsflyer'::text,
            ( SELECT COALESCE(appsflyer_sync_runs.finished_at, appsflyer_sync_runs.started_at) AS "coalesce"
                   FROM appsflyer_sync_runs
                  ORDER BY appsflyer_sync_runs.id DESC
                 LIMIT 1) AS "coalesce",
            ( SELECT COALESCE(appsflyer_sync_runs.finished_at, appsflyer_sync_runs.started_at) AS "coalesce"
                   FROM appsflyer_sync_runs
                  WHERE appsflyer_sync_runs.status = 'ok'::text
                  ORDER BY appsflyer_sync_runs.id DESC
                 LIMIT 1) AS "coalesce",
            ( SELECT max(appsflyer_daily.activity_date)::timestamp with time zone AS max
                   FROM appsflyer_daily) AS max,
            NULL::numeric,
            NULL::double precision
        UNION ALL
         SELECT 'zoho_calls'::text,
            ( SELECT zoho_sync_state.last_attempt_at
                   FROM zoho_sync_state
                  WHERE zoho_sync_state.job = 'calls'::text) AS last_attempt_at,
            ( SELECT zoho_sync_state.last_success_at
                   FROM zoho_sync_state
                  WHERE zoho_sync_state.job = 'calls'::text) AS last_success_at,
            ( SELECT max(helpdesk_calls.started_at) AS max
                   FROM helpdesk_calls) AS max,
            NULL::numeric,
            NULL::double precision
        UNION ALL
         SELECT 'zoho_desk'::text,
            ( SELECT worker_heartbeats.last_finished_at
                   FROM worker_heartbeats
                  WHERE worker_heartbeats.worker_key = 'zoho_desk'::text) AS last_finished_at,
            ( SELECT worker_heartbeats.last_ok_at
                   FROM worker_heartbeats
                  WHERE worker_heartbeats.worker_key = 'zoho_desk'::text) AS last_ok_at,
            ( SELECT max(helpdesk_tickets.created_at) AS max
                   FROM helpdesk_tickets) AS max,
            NULL::numeric,
            NULL::double precision
        UNION ALL
         SELECT 'fx_rates'::text,
            ( SELECT worker_heartbeats.last_finished_at
                   FROM worker_heartbeats
                  WHERE worker_heartbeats.worker_key = 'fx_rates'::text) AS last_finished_at,
            ( SELECT worker_heartbeats.last_ok_at
                   FROM worker_heartbeats
                  WHERE worker_heartbeats.worker_key = 'fx_rates'::text) AS last_ok_at,
            ( SELECT max(fx_parallel_rates.scraped_at) AS max
                   FROM fx_parallel_rates) AS max,
            NULL::numeric,
            NULL::double precision
        UNION ALL
         SELECT 'inbound_mail'::text,
            ( SELECT worker_heartbeats.last_finished_at
                   FROM worker_heartbeats
                  WHERE worker_heartbeats.worker_key = 'graph_inbox'::text) AS last_finished_at,
            ( SELECT worker_heartbeats.last_ok_at
                   FROM worker_heartbeats
                  WHERE worker_heartbeats.worker_key = 'graph_inbox'::text) AS last_ok_at,
            ( SELECT max(inbound_mail.received_at) AS max
                   FROM inbound_mail) AS max,
            NULL::numeric,
            NULL::double precision
        UNION ALL
         SELECT 'mail_outbound'::text,
            ( SELECT worker_heartbeats.last_finished_at
                   FROM worker_heartbeats
                  WHERE worker_heartbeats.worker_key = 'bounce_monitor'::text) AS last_finished_at,
            ( SELECT worker_heartbeats.last_ok_at
                   FROM worker_heartbeats
                  WHERE worker_heartbeats.worker_key = 'bounce_monitor'::text) AS last_ok_at,
            ( SELECT max(mail_messages.created_at) AS max
                   FROM mail_messages) AS max,
            NULL::numeric,
            NULL::double precision
        UNION ALL
         SELECT 'interswitch_settlement'::text,
            ( SELECT max(interswitch_imports.started_at) AS max
                   FROM interswitch_imports) AS max,
            ( SELECT max(interswitch_imports.started_at) AS max
                   FROM interswitch_imports
                  WHERE interswitch_imports.status = 'ok'::text) AS max,
            ( SELECT max(interswitch_legs.imported_at) AS max
                   FROM interswitch_legs) AS max,
            NULL::numeric,
            NULL::double precision
        UNION ALL
         SELECT 'ccs_eodtxn'::text,
            ( SELECT max(upload_audit_log.uploaded_at) AS max
                   FROM upload_audit_log
                  WHERE upload_audit_log.report_type = 'ccs_eodtxn'::text) AS max,
            ( SELECT max(upload_audit_log.uploaded_at) AS max
                   FROM upload_audit_log
                  WHERE upload_audit_log.report_type = 'ccs_eodtxn'::text AND upload_audit_log.status = 'success'::text) AS max,
            ( SELECT max(ccs_transactions.imported_at) AS max
                   FROM ccs_transactions) AS max,
            NULL::numeric,
            NULL::double precision
        UNION ALL
         SELECT 'card_cycle'::text,
            ( SELECT max(upload_audit_log.uploaded_at) AS max
                   FROM upload_audit_log
                  WHERE upload_audit_log.report_type = 'card_cycle'::text) AS max,
            ( SELECT max(upload_audit_log.uploaded_at) AS max
                   FROM upload_audit_log
                  WHERE upload_audit_log.report_type = 'card_cycle'::text AND upload_audit_log.status = 'success'::text) AS max,
            ( SELECT max(card_cycle_data.imported_at) AS max
                   FROM card_cycle_data) AS max,
            NULL::numeric,
            NULL::double precision
        UNION ALL
         SELECT 'phoenix_inbound'::text,
            NULL::timestamp with time zone,
            NULL::timestamp with time zone,
            ( SELECT max(phoenix_events.received_at) AS max
                   FROM phoenix_events) AS max,
            NULL::numeric,
            NULL::double precision) src;

COMMENT ON VIEW app.v_pipeline_data_age IS
  'Raw per-source measurement: last run, last successful run, age of the newest DATA, and 24h-vs-trailing-median row volume. File-feed and customer-feed data age use the INGEST timestamp of the newest row-carrying drop (migration 239, restored by 285 after 257 reverted it) so freshness is real-time, not date-granular. Business dates are never used - they run into the future in this warehouse.';

COMMIT;

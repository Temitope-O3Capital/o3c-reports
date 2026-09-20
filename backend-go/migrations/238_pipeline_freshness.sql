-- Pipeline freshness: make "has this source actually sent us anything?" a
-- first-class, queryable fact instead of something nobody can see.
--
-- Why this exists. On 2026-09-08 at 08:38 the CCS export stopped mid-morning, at
-- sequence 33 of ~96 daily windows. Six days later nothing and nobody had
-- noticed, because every dashboard in the platform answers a different question
-- than the one that mattered:
--
--   feed_runs latest row .... status='ok', minutes ago, rows_inserted=0
--   feed_files newest drop .. 2026-09-08
--
-- A run over a folder with no new files SUCCEEDS. So run status is not health.
-- There are three distinct axes and the codebase measured one and a half:
--
--   1. run age   — did the job execute?           tracked everywhere
--   2. data age  — did anything actually arrive?  tracked in ONE place
--                  (handlers/workers.go's 36h stale-drop check, 4 sources only,
--                   computed at render time so invisible unless someone opens
--                   /admin/sync)
--   3. volume    — did a NORMAL amount arrive?    tracked nowhere
--
-- Axis 3 is not academic. The last two non-empty drops before the outage were
-- 198 and 136 bytes — about one row each — against ~1,090 non-empty acct_file
-- drops on a normal day. The feed TAPERED for a window before it died, and a
-- binary "is the newest file recent?" test cannot see that.
--
-- Design notes:
--
--  * The per-source SQL lives in a view here, under migration control and code
--    review — NOT in a config column. Thresholds live in the config table, so
--    tuning an alert is an UPDATE, but changing what is measured is a migration.
--
--  * Data age is keyed on INGEST timestamps, never on business dates. MAX of
--    app.transactions.txn_date is 2026-09-23 — a future date the source claims.
--    A monitor built on business dates would have reported the dead feed as
--    eleven days FRESH.
--
--  * For file feeds, last_data_at counts only files that carried rows
--    (status='ok' AND rows_read > 0). Zero-byte files legitimately mean "no
--    change in this window" (docs/DATA_FEED_INGESTION.md §2) and keep arriving
--    after the data stops, so MAX(feed_date) over ALL files reads fresh for up
--    to a day after a real outage.

-- ── Config: one row per source, thresholds tunable without a deploy ─────────
CREATE TABLE IF NOT EXISTS app.pipeline_source (
    source_key           text PRIMARY KEY,
    label                text NOT NULL,
    category             text NOT NULL,          -- file_feed | api_poll | manual_upload | webhook | mail
    expected_interval    interval,               -- how often data should arrive (NULL = irregular)
    warn_after           interval,               -- amber
    stale_after          interval,               -- red
    volume_floor_ratio   numeric DEFAULT 0,      -- taper: alert if recent rows < ratio × trailing median (0 = off)
    owner                text,                   -- who to chase when it stops
    enabled              boolean NOT NULL DEFAULT true,
    notes                text,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE app.pipeline_source IS
  'Freshness expectations per inbound data source. Thresholds are data (tune with UPDATE); what gets measured is code (app.v_pipeline_data_age).';
COMMENT ON COLUMN app.pipeline_source.volume_floor_ratio IS
  'Taper detection: raise an alert when rows in the last 24h fall below this fraction of the trailing 14-day median. 0 disables. The 2026-09-08 outage was preceded by drops of ~1 row against a ~1,090/day norm.';
COMMENT ON COLUMN app.pipeline_source.enabled IS
  'false = known-quiet or unconfigured source that must not alert. Kept as a row rather than deleted so the reason stays visible in notes.';

-- ── Alert state: exactly-once notification, claim-and-mark ──────────────────
-- Modelled on the helpdesk SLA monitor (handlers/helpdesk.go), which is the only
-- production-grade time-threshold-to-notification engine in the repo: one UPDATE
-- ... RETURNING claims the alert so concurrent ticks cannot double-notify.
CREATE TABLE IF NOT EXISTS app.pipeline_alert_state (
    source_key      text NOT NULL,
    level           text NOT NULL,              -- warn | stale | taper | run_dead
    first_seen_at   timestamptz NOT NULL DEFAULT now(),
    last_seen_at    timestamptz NOT NULL DEFAULT now(),
    last_notified_at timestamptz,
    notify_count    integer NOT NULL DEFAULT 0,
    resolved_at     timestamptz,
    detail          text,
    PRIMARY KEY (source_key, level)
);

CREATE INDEX IF NOT EXISTS idx_pipeline_alert_open
  ON app.pipeline_alert_state (source_key)
  WHERE resolved_at IS NULL;

COMMENT ON TABLE app.pipeline_alert_state IS
  'Open/resolved state per (source, level) so an alert notifies once and recovery notifies once. app.alert_log is NOT used: its notify_roles column is selected and never read, so a row there reaches nobody (0 rows in its lifetime).';

-- ── Measurement: raw run age, data age and volume, per source ───────────────
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

    -- ── Manual uploads: no run table exists for most of these, so run age is
    -- NULL by design and data age is the only signal. All three are months
    -- stale as of 2026-09-14 and nothing has ever said so.
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
  'Raw per-source measurement: last run, last successful run, age of the newest DATA, and 24h-vs-trailing-median row volume. Data age uses ingest timestamps only — business dates in this warehouse run into the future.';

-- ── Verdict: measurement joined to expectations ─────────────────────────────
CREATE OR REPLACE VIEW app.v_pipeline_freshness AS
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
       now() - a.last_ok_at                                     AS run_age,
       a.rows_recent,
       a.rows_baseline,
       CASE WHEN COALESCE(a.rows_baseline, 0) > 0
            THEN round((a.rows_recent / a.rows_baseline)::numeric, 3) END AS volume_ratio,
       CASE
         WHEN NOT s.enabled                                          THEN 'disabled'
         WHEN a.last_data_at IS NULL                                 THEN 'never'
         WHEN s.stale_after IS NOT NULL
              AND now() - a.last_data_at > s.stale_after             THEN 'stale'
         -- Taper: volume collapsed while data technically still arrives.
         WHEN s.volume_floor_ratio > 0 AND COALESCE(a.rows_baseline, 0) > 0
              AND a.rows_recent < s.volume_floor_ratio * a.rows_baseline THEN 'taper'
         WHEN s.warn_after IS NOT NULL
              AND now() - a.last_data_at > s.warn_after              THEN 'warn'
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
  LEFT JOIN app.v_pipeline_data_age a USING (source_key);

COMMENT ON VIEW app.v_pipeline_freshness IS
  'One row per inbound source with a freshness verdict: ok | warn | stale | taper | never | disabled, plus an independent run_state (running | run_dead | never_ok). This is what the monitor worker and the Data Freshness page read.';

-- ── Seeds ───────────────────────────────────────────────────────────────────
-- Thresholds are deliberately generous enough to survive a weekend upstream
-- outage without crying wolf, and tight enough that six days cannot hide.
INSERT INTO app.pipeline_source
    (source_key, label, category, expected_interval, warn_after, stale_after, volume_floor_ratio, owner, enabled, notes)
VALUES
  ('feed_accounts', 'Account feed (acct_file)', 'file_feed', interval '15 minutes', interval '3 hours', interval '12 hours', 0.25, 'CCS export owner', true,
   'E:\acct_file. ~1,090 non-empty drops/day when healthy.'),
  ('feed_transactions', 'Transaction feed (txn_file)', 'file_feed', interval '15 minutes', interval '3 hours', interval '12 hours', 0.25, 'CCS export owner', true,
   'E:\txn_file.'),
  ('customer_feed', 'Customer feed (cust_file)', 'file_feed', interval '15 minutes', interval '12 hours', interval '36 hours', 0.20, 'CCS export owner', true,
   'E:\cust_file. Customers change rarely — only ~27 non-empty drops/day — so the thresholds are wider than the other two feeds.'),
  ('feed_cardfam', 'Card-family feed (cardfam_file)', 'file_feed', interval '15 minutes', NULL, NULL, 0, 'CCS export owner', false,
   'DISABLED: 133,287 files and not one has ever been non-empty. Structurally always empty, so any freshness rule would alert forever.'),
  ('cbs', 'Udara core banking', 'api_poll', interval '3 minutes', interval '1 hour', interval '6 hours', 0, 'Udara / core banking', true,
   'Full-refresh snapshot; data age is MAX(synced_at) on cbs_loans/cbs_customers.'),
  ('paystack', 'Paystack', 'api_poll', interval '30 minutes', interval '6 hours', interval '24 hours', 0, 'Finance / Paystack', true,
   'Data age is MAX(paid_at): real settlement activity, not the sync clock. Note the sync watermark advances even when nothing is returned.'),
  ('appsflyer', 'AppsFlyer acquisition', 'api_poll', interval '1 hour', interval '12 hours', interval '48 hours', 0, 'Marketing', true,
   'Aggregate pull; activity_date is a date, so expect up to a day of natural lag.'),
  ('zoho_calls', 'Zoho Voice call logs', 'api_poll', interval '1 minute', interval '4 hours', interval '12 hours', 0, 'Call centre / Zoho', true,
   'Quiet overnight and at weekends — hence 4h warn rather than minutes.'),
  ('zoho_desk', 'Zoho Desk tickets', 'api_poll', interval '1 minute', interval '6 hours', interval '24 hours', 0, 'Care / Zoho', true,
   'Writes no row to zoho_sync_state (only job=calls exists), so run age comes from the heartbeat.'),
  ('fx_rates', 'FX parallel rates', 'api_poll', interval '1 hour', interval '6 hours', interval '24 hours', 0, 'Treasury', true,
   'Scraped from a third-party site; breakage is likely and currently silent.'),
  ('inbound_mail', 'Inbound mail (MS Graph)', 'mail', interval '3 minutes', interval '12 hours', interval '48 hours', 0, 'IT', false,
   'DISABLED: MS_GRAPH_* credentials are absent, and the poller beats "ok" with detail "Graph not configured" — green while ingesting nothing. Enable once Graph is configured.'),
  ('mail_outbound', 'Outbound mail (SendGrid)', 'mail', interval '30 minutes', interval '24 hours', interval '72 hours', 0, 'IT', true,
   'Data age is the newest queued message: catches "we stopped being able to send".'),
  ('interswitch_settlement', 'Interswitch settlement files', 'manual_upload', NULL, interval '35 days', interval '45 days', 0, 'Settlement ops', true,
   'Manual upload, no run table. Newest import 2026-08-05, settlements only to 2026-07-01 — roughly ten weeks stale at seeding, and nothing has ever reported it.'),
  ('ccs_eodtxn', 'CCS EODTXN (Report 620)', 'manual_upload', NULL, interval '14 days', interval '30 days', 0, 'Cards ops', true,
   'Manual upload with no run table at all; per-row insert errors are discarded. Newest import 2026-08-05.'),
  ('card_cycle', 'Card cycle reports', 'manual_upload', NULL, interval '40 days', interval '60 days', 0, 'Cards ops', true,
   'Monthly cycle files. Newest import 2026-08-04 for cycle 2026-07-14.'),
  ('phoenix_inbound', 'Phoenix decision webhooks', 'webhook', NULL, NULL, NULL, 0, 'Credit / Phoenix', false,
   'DISABLED: event-driven and very low volume (8 events ever), so silence is indistinguishable from health. Watch the outbox backlog instead.')
ON CONFLICT (source_key) DO NOTHING;

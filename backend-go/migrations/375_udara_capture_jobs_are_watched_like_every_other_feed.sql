-- 375: the two Udara money-capture jobs get watched, like every other feed.
--
-- WHAT WAS WRONG. The freshness monitor watched sixteen sources and exactly one of
-- them was Udara: 'cbs', which measures the three-minute book snapshot. The jobs that
-- capture MONEY -- app.loan_repayments, app.cbs_gl_postings, app.cbs_journal_receipts
-- and the Blink FX events derived from the postings -- had no registered expectation
-- at all. They write heartbeat rows, so the information existed; nothing read it.
--
-- Those four tables feed the branch P&L, the balance sheet, the cash flow statement
-- and the collections figures. Their failure mode is reporting "0 new" forever, which
-- is indistinguishable from a quiet week -- and here quiet weeks are NORMAL, because
-- Udara publishes a posting a median of five to seven days after its value date. So a
-- dead capture job looked exactly like Udara having nothing to give.
--
-- WHY THE DATA THRESHOLDS ARE DELIBERATELY LOOSE AND THE RUN THRESHOLD TIGHT. This is
-- the three-axis design from migration 238, used as intended:
--
--   run age    the real signal here. expected_interval is one hour, so run_state goes
--              'run_dead' after four hours with no successful run. That catches a dead
--              worker the same morning.
--   data age   a genuinely dry fortnight is possible and means nothing is wrong, so
--              warn at 10 days and stale at 30. Anything tighter fires during normal
--              operation, and an alert that cries wolf gets ignored -- the CCS feed has
--              notified 14 times since 2026-10-06 and nobody has acted on it.
--   volume     taper detection is OFF (volume_floor_ratio 0) on purpose. Zero new legs
--              in an hour is the common case here, not a collapse, so the ratio test
--              that works for a 1,090-drop-a-day file feed would false-positive every
--              hour of every day.
--
-- WHAT THIS DOES NOT CLAIM TO CATCH. If the capture runs, fetches, and classifies every
-- row away, run age stays green and data age looks like a quiet week. No threshold on
-- these tables can tell that apart from Udara being silent; the only witness is the
-- scanned-vs-stored count the worker writes to its heartbeat detail. Stated plainly so
-- nobody reads a green row as more assurance than it is.
--
-- HOW THE VIEW IS EXTENDED, AND WHY NOT BY RESTATING IT. app.v_pipeline_data_age is
-- ~230 lines of per-source arms and has been redefined four times (238, 239, 257, 285).
-- Migration 257 rebuilt it from 238's text and silently reverted 239's fix for six days;
-- 285 exists only to undo that. Restating it again to append four arms would be the same
-- gamble, so the new arms live in their own view and the verdict layer unions the two.
-- app.v_pipeline_data_age is not touched by this migration at all.
--
-- The verdict view IS restated, and its text below is copied from migration 259 -- its
-- true latest definer, NOT 238. 238 lacks effective_data_age and business_days_only,
-- which are live. Checking that before copying is the step 257 skipped. The only change
-- is the FROM clause: column list, order, types and every CASE arm are identical to 259.
-- Nothing in the database depends on this view (verified: zero rewrite dependencies),
-- and the monitor worker and the Data Freshness page query it by column name.

BEGIN;

-- ── A run that half-failed stops looking like a clean success ───────────────
-- Only products, loans and fixed deposits are inside doSync's transaction. The
-- customer-master fetch, the profile enrichment, the party linking, the officer
-- assignment and the reconcile all run AFTER the commit and are warn-only, so a run
-- could be stamped 'ok' while the officer attribution that feeds sales targets and
-- commission silently did not happen. Five counters the run already produces were
-- never persisted either.
--
-- This is a new COLUMN rather than a new status value on purpose. app.v_pipeline_data_age
-- computes the 'cbs' source's last_ok_at with `WHERE status = 'ok'`, so inventing a
-- 'partial' status would quietly make every degraded run invisible to the freshness
-- monitor and eventually trip run_dead on a source whose book refreshed perfectly.
-- Widening that arm would mean restating the 230-line view this migration exists to
-- avoid restating. So status keeps its meaning — "the transaction committed" — and the
-- degradation is recorded beside it.
ALTER TABLE app.cbs_sync_runs
  ADD COLUMN IF NOT EXISTS degraded_steps TEXT;

COMMENT ON COLUMN app.cbs_sync_runs.degraded_steps IS
  'Comma-separated post-commit steps that failed on an otherwise successful run (customer master, enrichment, linking, officer assignment, reconcile). NULL means every step ran. status stays ''ok'' because the book transaction committed - see migration 375.';

-- ── The new arms ────────────────────────────────────────────────────────────
-- Same six columns, same order, same types as app.v_pipeline_data_age so the two
-- union cleanly: source_key, last_run_at, last_ok_at, last_data_at, rows_recent,
-- rows_baseline.
--
-- last_run_at/last_ok_at come from app.worker_heartbeats, where these jobs already
-- report. last_data_at is the CAPTURE timestamp, never the financial date: a
-- posting's value date can be 105 days older than the moment we could first see it,
-- so measuring freshness on the business date would report a healthy capture as
-- months stale. Same rule migration 239 established for the file feeds.
CREATE OR REPLACE VIEW app.v_pipeline_data_age_udara AS
SELECT 'cbs_repayments'::text AS source_key,
       (SELECT COALESCE(h.last_finished_at, h.last_started_at)
          FROM app.worker_heartbeats h
         WHERE h.worker_key = 'cbs_repayment_capture')      AS last_run_at,
       (SELECT h.last_ok_at
          FROM app.worker_heartbeats h
         WHERE h.worker_key = 'cbs_repayment_capture')      AS last_ok_at,
       (SELECT max(r.created_at)
          FROM app.loan_repayments r
         WHERE r.channel = 'cbs_gl')                        AS last_data_at,
       NULL::numeric                                        AS rows_recent,
       NULL::double precision                               AS rows_baseline
UNION ALL
SELECT 'cbs_gl_postings'::text,
       (SELECT COALESCE(h.last_finished_at, h.last_started_at)
          FROM app.worker_heartbeats h
         WHERE h.worker_key = 'cbs_gl_postings_capture'),
       (SELECT h.last_ok_at
          FROM app.worker_heartbeats h
         WHERE h.worker_key = 'cbs_gl_postings_capture'),
       (SELECT max(g.captured_at) FROM app.cbs_gl_postings g),
       NULL::numeric,
       NULL::double precision
UNION ALL
-- Journal receipts are written by the repayment worker, so they share its heartbeat.
-- Kept as a source of their own because the receipt and its application to a facility
-- are different facts (migration 371) and either can stop alone: more than half of the
-- receipts captured so far are not linked to any loan.
SELECT 'cbs_journal_receipts'::text,
       (SELECT COALESCE(h.last_finished_at, h.last_started_at)
          FROM app.worker_heartbeats h
         WHERE h.worker_key = 'cbs_repayment_capture'),
       (SELECT h.last_ok_at
          FROM app.worker_heartbeats h
         WHERE h.worker_key = 'cbs_repayment_capture'),
       (SELECT max(j.synced_at) FROM app.cbs_journal_receipts j),
       NULL::numeric,
       NULL::double precision
UNION ALL
-- Blink FX events are derived from postings already captured, so they cannot be fresher
-- than cbs_gl_postings and a gap here is usually a gap there. The parser is given a
-- heartbeat in the same change as this migration, so run age is measurable rather than
-- permanently 'unknown'.
SELECT 'blink_fx_events'::text,
       (SELECT COALESCE(h.last_finished_at, h.last_started_at)
          FROM app.worker_heartbeats h
         WHERE h.worker_key = 'blink_fx_parse'),
       (SELECT h.last_ok_at
          FROM app.worker_heartbeats h
         WHERE h.worker_key = 'blink_fx_parse'),
       (SELECT max(e.created_at) FROM app.blink_fx_events e),
       NULL::numeric,
       NULL::double precision;

COMMENT ON VIEW app.v_pipeline_data_age_udara IS
  'Freshness measurement for the Udara money-capture jobs, kept separate from app.v_pipeline_data_age so that view never has to be restated to add a source (migration 257 reverted 239 by doing exactly that). Data age is the capture timestamp, never the financial date: Udara publishes a posting days to months after its value date.';

-- ── Verdict layer, extended to read both measurement views ──────────────────
-- Text below is migration 259's, unchanged except the FROM clause.
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
  -- The only change from 259: measurement comes from both views now. UNION ALL
  -- rather than UNION because the source_key sets are disjoint by construction,
  -- and a dedupe would hide a collision instead of letting it be noticed.
  LEFT JOIN (SELECT * FROM app.v_pipeline_data_age
             UNION ALL
             SELECT * FROM app.v_pipeline_data_age_udara) a USING (source_key)
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
  'One row per inbound source with a freshness verdict: ok | warn | stale | taper | never | disabled, plus an independent run_state (running | run_dead | never_ok). data_age is true wall-clock age; effective_data_age is what the verdict tests, and differs only for business_days_only sources, where whole weekend days are removed (migration 259). Measurement is read from app.v_pipeline_data_age and app.v_pipeline_data_age_udara (migration 375). This is what the monitor worker and the Data Freshness page read.';

-- ── Register the four sources ───────────────────────────────────────────────
INSERT INTO app.pipeline_source
    (source_key, label, category, expected_interval, warn_after, stale_after,
     volume_floor_ratio, owner, enabled, notes)
VALUES
  ('cbs_repayments', 'Udara repayment capture', 'api_poll',
   interval '1 hour', interval '10 days', interval '30 days', 0,
   'Udara / core banking', true,
   'app.loan_repayments, channel cbs_gl. Hourly walk of the transaction call-over report. Data age is the capture timestamp: Udara publishes a posting a median of 5-7 days after its value date, worst observed 105. Run age is the signal that matters - run_dead after 4h.'),

  ('cbs_gl_postings', 'Udara GL postings capture', 'api_poll',
   interval '1 hour', interval '10 days', interval '30 days', 0,
   'Udara / core banking', true,
   'app.cbs_gl_postings, every leg of both sides. Feeds the branch P&L, balance sheet and cash flow statement, so a silent stop here misstates the accounts and not merely a screen.'),

  ('cbs_journal_receipts', 'Udara journal receipts', 'api_poll',
   interval '1 hour', interval '10 days', interval '30 days', 0,
   'Udara / core banking', true,
   'app.cbs_journal_receipts - money arriving in a customer CASA account, a different fact from its application to a facility (migration 371). More than half of what has been captured is not linked to any loan.'),

  ('blink_fx_events', 'Blink FX events', 'derived',
   interval '1 hour', interval '14 days', interval '45 days', 0,
   'Udara / core banking', true,
   'app.blink_fx_events, parsed out of postings already captured. Cannot be fresher than cbs_gl_postings; thresholds are wider because an FX event is a rarer thing than a repayment.')
ON CONFLICT (source_key) DO NOTHING;

-- ── Assertions: fail loudly here rather than by luck in production ──────────
DO $assert$
DECLARE
  n_src     INT;
  n_arms    INT;
  n_joined  INT;
  n_cols    INT;
  n_dupes   INT;
BEGIN
  SELECT COUNT(*) INTO n_src FROM app.pipeline_source
   WHERE source_key IN ('cbs_repayments','cbs_gl_postings','cbs_journal_receipts','blink_fx_events');
  IF n_src <> 4 THEN
    RAISE EXCEPTION '375: expected 4 registered Udara sources, found %', n_src;
  END IF;

  SELECT COUNT(*) INTO n_arms FROM app.v_pipeline_data_age_udara;
  IF n_arms <> 4 THEN
    RAISE EXCEPTION '375: measurement view must return exactly 4 rows, returned %', n_arms;
  END IF;

  -- The join is the whole point: a source registered but unmeasured reads 'never'
  -- forever and teaches people to ignore the page.
  SELECT COUNT(*) INTO n_joined FROM app.v_pipeline_freshness
   WHERE source_key IN ('cbs_repayments','cbs_gl_postings','cbs_journal_receipts','blink_fx_events')
     AND last_data_at IS NOT NULL;
  IF n_joined <> 4 THEN
    RAISE EXCEPTION '375: all 4 Udara sources must resolve a last_data_at, only % did', n_joined;
  END IF;

  -- Guard the restatement: 259's view had 21 columns and so must this one, or
  -- something was dropped while copying.
  SELECT COUNT(*) INTO n_cols FROM pg_attribute
   WHERE attrelid = 'app.v_pipeline_freshness'::regclass AND attnum > 0 AND NOT attisdropped;
  IF n_cols <> 21 THEN
    RAISE EXCEPTION '375: v_pipeline_freshness must have 21 columns, has %', n_cols;
  END IF;

  -- UNION ALL across two measurement views can only be safe while the key sets
  -- stay disjoint. Assert it rather than trust it.
  SELECT COUNT(*) INTO n_dupes FROM (
    SELECT source_key FROM app.v_pipeline_data_age
    INTERSECT
    SELECT source_key FROM app.v_pipeline_data_age_udara) x;
  IF n_dupes <> 0 THEN
    RAISE EXCEPTION '375: % source_key(s) measured by BOTH views - verdict rows would double', n_dupes;
  END IF;

  RAISE NOTICE '375 OK: 4 Udara capture sources registered, measured and joined';
END $assert$;

COMMIT;
